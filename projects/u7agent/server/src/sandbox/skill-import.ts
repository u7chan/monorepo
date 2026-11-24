import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { COMMON_SKILLS_DIR, COMMON_SKILLS_SEGMENTS } from "../app-paths";
import { messageFor, pathError } from "../errors";
import { isInsideRoot } from "../path-strings";
import type { ArchiveLimits } from "./archive";
import { diagnoseSkillFolder, type SkillCrudContext } from "./common-skills";
import { createWorkspaceDirectory, realpathNative, resolveCommonSkillTarget, throwIfAborted } from "./fs-path";
import {
  isValidEntryName,
  type SandboxSkillImportApplied,
  type SandboxSkillImportPlanEntry,
  type SandboxSkillImportSkipped,
  type SandboxSkillImportStatus,
  type SandboxSkillsImportApply,
  type SandboxSkillsImportPlan,
  type SandboxSkillsImportResult,
} from "./protocol";
import { extractZipEntry, readZipArchive, type ZipReadArchive, type ZipReadEntry } from "./zip-read";

/** 共通スキル置き場の親 (`.agents`)。取り込みの一時データを同じファイルシステムに置く */
const SKILLS_PARENT_DIR = dirname(COMMON_SKILLS_DIR);
/** 取り込みの一時ディレクトリ。受信 ZIP・staging・退避をここに閉じ、成功・失敗・中断のいずれでも消す */
const IMPORT_TEMP_PREFIX = ".import-";

/** staging へ展開したスキル 1 件。files はスキル名からの相対パス → SHA-256 */
interface StagedSkill {
  name: string;
  folder: string;
  files: Map<string, string>;
  skillFileVersion: string;
}

/** ZIP の直下フォルダ 1 つ分 (スキル 1 件) */
interface SkillImportGroup {
  name: string;
  entries: ZipReadEntry[];
  hasSkillFile: boolean;
}

/** 取り込みの計画 1 件。`reason` は invalid のとき、`protectReason` は置換できないときだけ入る */
interface SkillImportPlan {
  name: string;
  status: SandboxSkillImportStatus;
  reason?: string;
  staged: StagedSkill;
  /** 実在した置換対象の実フォルダ (置換できるときだけ) */
  replaceTarget?: string;
  protectReason?: string;
}

/**
 * 取り込みの `replace` query。保存名と同じ規則で検証し、重複は先勝ちで畳む。
 * 空値と不正な名前は 400 にする (黙って無視すると「置き換えたつもり」の食い違いを作る)。
 */
export function parseReplaceQuery(
  values: string[] | undefined,
): { ok: true; names: string[] } | { ok: false; message: string } {
  const names = [...new Set(values ?? [])];
  const invalid = names.find((name) => !isValidEntryName(name));
  if (invalid !== undefined) return { ok: false, message: `Invalid replace name: ${invalid}` };
  return { ok: true, names };
}

/** `.agents` 配下に取り込みの一時ディレクトリを作る。既存の `.agents` が root 外へ解決する場合は 400 */
async function createImportTempDir(rootCwd: string): Promise<string> {
  // 前提処理の失敗も OS メッセージ (絶対パス) を応答に載せない
  const parentRel = await createWorkspaceDirectory(rootCwd, SKILLS_PARENT_DIR).catch((error: unknown) => {
    throw importFailure(error);
  });
  const root = await realpathNative(rootCwd).catch((error: unknown) => {
    throw importFailure(error);
  });
  const parent = parentRel === "." ? root : join(root, parentRel);
  const temp = join(parent, `${IMPORT_TEMP_PREFIX}${randomUUID()}`);
  await mkdir(temp).catch((error: unknown) => {
    throw importFailure(error);
  });
  return temp;
}

/** 受信した ZIP を一時ファイルへ書く。上限はアップロードと同じ値で、超過は 413 */
async function receiveImportArchive(input: {
  dir: string;
  body: ReadableStream<Uint8Array> | null;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  const path = join(input.dir, "archive.zip");
  const handle = await open(path, "wx", 0o600).catch((error: unknown) => {
    throw importFailure(error);
  });
  let size = 0;
  try {
    if (input.body) {
      const reader = input.body.getReader();
      try {
        for (;;) {
          throwIfAborted(input.signal);
          const { done, value } = await reader.read().catch((error: unknown) => {
            throw importFailure(error);
          });
          if (done) break;
          size += value.byteLength;
          if (size > input.maxBytes) {
            await reader.cancel().catch(() => {});
            throw pathError(413, `Import archive is too large (max ${input.maxBytes} bytes)`);
          }
          await handle.write(value).catch((error: unknown) => {
            throw importFailure(error);
          });
        }
      } finally {
        reader.releaseLock();
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return path;
}

/**
 * 1 エントリのパスを検証し、セグメントに分ける。zip slip (絶対パス・`..`・`\`・制御文字) と、
 * `.git` の全階層除外、hidden の直下フォルダ、symlink / 特殊ファイルのエントリをここで断る。
 */
function importEntrySegments(entry: ZipReadEntry): string[] {
  if (entry.name.startsWith("/") || entry.name.startsWith("\\")) {
    throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
  }
  if (entry.unixMode !== undefined) {
    const fileType = entry.unixMode & 0o170000;
    if (fileType === 0o120000) throw pathError(400, `Symbolic link entries are not allowed: ${entry.name}`);
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw pathError(400, `Not a regular file or directory: ${entry.name}`);
    }
  }
  // 末尾の `/` はディレクトリの印。2 つ以上や、区切りの連続・空セグメントは名前として扱わない
  const trimmed = entry.isDirectory && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
  const segments = trimmed.split("/");
  if (trimmed === "" || segments.some((segment) => segment === "")) {
    throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
  }
  for (const segment of segments) {
    if (!isValidEntryName(segment)) throw pathError(400, `Invalid ZIP entry name: ${entry.name}`);
    // export の固定除外と对称 (全階層・ベース名の完全一致)
    if (segment === ".git") throw pathError(400, `Excluded from skill archives: ${entry.name}`);
  }
  if (segments[0]!.startsWith(".")) {
    throw pathError(400, `Hidden directories are not skill folders: ${entry.name}`);
  }
  return segments;
}

/** 直下がスキルフォルダだけであることと、各フォルダが `SKILL.md` を直接持つことを検証してグループへ分ける */
function groupImportEntries(entries: readonly ZipReadEntry[]): SkillImportGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, SkillImportGroup>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw pathError(400, `Duplicate ZIP entry: ${entry.name}`);
    seen.add(entry.name);
    const segments = importEntrySegments(entry);
    const name = segments[0]!;
    let group = groups.get(name);
    if (!group) {
      group = { name, entries: [], hasSkillFile: false };
      groups.set(name, group);
    }
    // 直下の項目はスキルフォルダ (ディレクトリ) だけ。ファイルはどのスキルにも属さない
    if (segments.length === 1 && !entry.isDirectory) {
      throw pathError(400, `SKILL.md を持たない直下項目です: ${entry.name}`);
    }
    if (segments.length === 2 && segments[1] === "SKILL.md" && !entry.isDirectory) group.hasSkillFile = true;
    group.entries.push(entry);
  }
  for (const group of groups.values()) {
    if (!group.hasSkillFile) throw pathError(400, `SKILL.md を持たないスキルフォルダです: ${group.name}`);
  }
  return [...groups.values()];
}

/** 検証済みの ZIP を staging へ展開し、同一判定に使うスキルごとのバイトハッシュを集める */
async function extractImportGroups(input: {
  archivePath: string;
  archive: ZipReadArchive;
  groups: readonly SkillImportGroup[];
  staging: string;
}): Promise<StagedSkill[]> {
  const staged: StagedSkill[] = [];
  for (const group of input.groups) {
    const folder = join(input.staging, group.name);
    await mkdir(folder, { recursive: true }).catch(() => {
      throw pathError(400, `Invalid ZIP archive: cannot extract ${group.name}`);
    });
    const files = new Map<string, string>();
    let skillFileVersion: string | undefined;
    for (const entry of group.entries) {
      const extracted = await extractZipEntry({
        archive: input.archivePath,
        entry,
        target: join(input.staging, entry.name),
        dataLimit: input.archive.dataLimit,
      });
      if (entry.isDirectory) continue;
      const relativePath = entry.name.slice(group.name.length + 1);
      files.set(relativePath, extracted.digest);
      if (relativePath === "SKILL.md") skillFileVersion = extracted.digest;
    }
    if (skillFileVersion === undefined) throw pathError(400, `SKILL.md を持たないスキルフォルダです: ${group.name}`);
    staged.push({ name: group.name, folder, files, skillFileVersion });
  }
  return staged;
}

/**
 * フォルダ下の通常ファイルの相対パス → SHA-256。symlink / 特殊ファイルがあるときと、
 * エントリ数 / 合計サイズが既存の上限 (export の walk と同じ値) を超えるときは undefined を返す
 * (同一とは言えない。上限付きで読むのは、共通スキル gate を握ったまま巨大なフォルダを読まないため)。
 */
async function folderFileDigests(folder: string, limits: ArchiveLimits): Promise<Map<string, string> | undefined> {
  const digests = new Map<string, string>();
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const children = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!children) return false;
    for (const child of children) {
      entries += 1;
      if (entries > limits.maxEntries) return false;
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isSymbolicLink()) return false;
      if (child.isDirectory()) {
        if (!(await walk(join(dir, child.name), name))) return false;
        continue;
      }
      if (!child.isFile()) return false;
      const stats = await lstat(join(dir, child.name)).catch(() => undefined);
      if (!stats) return false;
      bytes += stats.size;
      if (bytes > limits.maxBytes) return false;
      const hash = createHash("sha256");
      try {
        await pipeline(createReadStream(join(dir, child.name)), hash);
      } catch {
        return false;
      }
      digests.set(name, hash.digest("hex"));
    }
    return true;
  };
  return (await walk(folder, "")) ? digests : undefined;
}

/** 2 つのファイル集合 (相対パス → SHA-256) が完全に一致するか */
function sameFileDigests(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, digest] of a) if (b.get(name) !== digest) return false;
  return true;
}

/** フォルダ自身が `<skills>` の内側へ解決するか (しないときは置換しない)。symlink の判定に使う */
async function resolvesInsideSkills(input: { rootCwd: string; target: string }): Promise<boolean> {
  const realRoot = await realpathNative(input.rootCwd).catch(() => undefined);
  if (!realRoot) return false;
  const realSkillsDir = await realpathNative(join(realRoot, COMMON_SKILLS_DIR)).catch(() => undefined);
  const real = await realpathNative(input.target).catch(() => undefined);
  if (!realSkillsDir || !real) return false;
  return isInsideRoot(realSkillsDir, real, sep);
}

/**
 * bundle のスキル名に対する既存の置換対象を、共通スキルの CRUD と同じ規則で解決する
 * (realpath で置き場の内側、`SKILL.md` が symlink のスキルは置換しない)。
 * 既存の同名が置き場の外へ解決する symlink でも、そのスキルを置換対象にしないだけで、
 * bundle の他のスキル (new を含む) の取り込みは止めない。
 */
async function resolveImportTarget(input: {
  rootCwd: string;
  name: string;
}): Promise<{ state: "missing" } | { state: "protected"; reason: string } | { state: "existing"; folder: string }> {
  const requested = [...COMMON_SKILLS_SEGMENTS, input.name, "SKILL.md"].join("/");
  const lexical = join(resolve(input.rootCwd), ...COMMON_SKILLS_SEGMENTS, input.name, "SKILL.md");
  // 置換可否は lexical な形で先に見る (参照先が置き場の外でも resolveCommonSkillTarget の 400 にしない)
  const stats = await lstat(lexical).catch(() => undefined);
  if (stats?.isSymbolicLink()) {
    return { state: "protected", reason: "SKILL.md がシンボリックリンクのため置換できません" };
  }
  if (stats !== undefined && !stats.isFile()) {
    return { state: "protected", reason: "SKILL.md が通常ファイルではないため置換できません" };
  }
  const folderStats = await lstat(dirname(lexical)).catch(() => undefined);
  if (
    folderStats?.isSymbolicLink() &&
    !(await resolvesInsideSkills({ rootCwd: input.rootCwd, target: dirname(lexical) }))
  ) {
    return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
  }

  const target = await resolveCommonSkillTarget({ rootCwd: input.rootCwd, requested, mustExist: false }).catch(
    (error: unknown) => {
      throw importFailure(error);
    },
  );
  const skillsDir = target.realSkillsDir;
  if (skillsDir === undefined) return { state: "missing" };
  if (target.real !== undefined) {
    const folder = dirname(target.real);
    if (!isInsideRoot(skillsDir, folder, sep)) {
      return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
    }
    return { state: "existing", folder };
  }
  const folder = dirname(target.lexical);
  if (folderStats === undefined) return { state: "missing" };
  // SKILL.md は無いがフォルダはある (非スキル項目)。中身を同一と判定できないため置換対象にする
  const real = await realpathNative(folder).catch(() => undefined);
  if (!real || !isInsideRoot(skillsDir, real, sep)) {
    return { state: "protected", reason: "スキルフォルダが置き場の外へ解決するため置換できません" };
  }
  return { state: "existing", folder: real };
}

/** 展開済みの bundle を SDK で検証し、既存と突き合わせて new / identical / conflict / invalid に分ける */
async function planSkillsImport(input: {
  rootCwd: string;
  staged: readonly StagedSkill[];
  limits: ArchiveLimits;
}): Promise<SkillImportPlan[]> {
  const plans: SkillImportPlan[] = [];
  for (const staged of input.staged) {
    const diagnosed = await diagnoseSkillFolder(staged.folder).catch((error: unknown) => {
      throw importFailure(error);
    });
    if (!diagnosed.ok) {
      plans.push({ name: staged.name, status: "invalid", reason: diagnosed.message, staged });
      continue;
    }
    if (diagnosed.name !== staged.name) {
      plans.push({
        name: staged.name,
        status: "invalid",
        reason: `スキル名 (name) がフォルダ名と一致しません: ${diagnosed.name}`,
        staged,
      });
      continue;
    }
    const existing = await resolveImportTarget({ rootCwd: input.rootCwd, name: staged.name });
    if (existing.state === "missing") {
      plans.push({ name: staged.name, status: "new", staged });
      continue;
    }
    if (existing.state === "protected") {
      plans.push({ name: staged.name, status: "conflict", protectReason: existing.reason, staged });
      continue;
    }
    const digests = await folderFileDigests(existing.folder, input.limits);
    const identical = digests !== undefined && sameFileDigests(digests, staged.files);
    plans.push({
      name: staged.name,
      status: identical ? "identical" : "conflict",
      replaceTarget: existing.folder,
      staged,
    });
  }
  return plans;
}

/**
 * 取り込みの失敗を、内部パスを含まない固定文言に写す。診断に要る OS メッセージ (絶対パスを含む) は
 * 応答本文には載せず、プロセスのログにだけ残す。ステータスは変更前の分類を保ち、OS の失敗は 500 にする。
 */
function importFailure(error: unknown): Error & { statusCode: number } {
  console.warn(`[u7agent-sandbox] スキルの取り込みに失敗しました: ${messageFor(error)}`);
  const statusCode = (error as { statusCode?: number }).statusCode;
  const status = statusCode !== undefined && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return pathError(status, "スキルをインポートできませんでした");
}

/**
 * 計画を適用する。置換対象を退避へ rename → 新フォルダを rename の順に行い、
 * 全件成功後に退避を消す。途中で失敗したら、適用済みの分を逆順に戻す。
 */
async function applySkillsImport(input: {
  rootCwd: string;
  tempDir: string;
  plans: readonly SkillImportPlan[];
  replace: ReadonlySet<string>;
  entries: number;
  bytes: number;
  signal?: AbortSignal;
}): Promise<SandboxSkillsImportApply> {
  const backupDir = join(input.tempDir, "backup");
  // 準備段階の失敗も OS メッセージ (絶対パス) を応答に載せない
  const root = await realpathNative(input.rootCwd).catch((error: unknown) => {
    throw importFailure(error);
  });
  await mkdir(backupDir, { recursive: true }).catch((error: unknown) => {
    throw importFailure(error);
  });
  const applied: SandboxSkillImportApplied[] = [];
  const skipped: SandboxSkillImportSkipped[] = [];
  const rollback: { destination: string; folder?: string; backup?: string }[] = [];
  /** スキルを 1 件でも作るときだけ `.agents/skills` を作る (全件 skip の要求では何も作らない) */
  let destinationRoot: string | undefined;
  const destinationRootOf = async (): Promise<string> => {
    if (destinationRoot !== undefined) return destinationRoot;
    const rel = await createWorkspaceDirectory(input.rootCwd, COMMON_SKILLS_DIR).catch((error: unknown) => {
      throw importFailure(error);
    });
    destinationRoot = rel === "." ? root : join(root, rel);
    return destinationRoot;
  };
  try {
    for (const plan of input.plans) {
      throwIfAborted(input.signal);
      if (plan.status === "invalid") {
        skipped.push({ name: plan.name, reason: plan.reason ?? "スキルとして読み込めません" });
        continue;
      }
      if (plan.status === "identical") {
        skipped.push({ name: plan.name, reason: "内容が同一" });
        continue;
      }
      if (plan.protectReason !== undefined) {
        skipped.push({ name: plan.name, reason: plan.protectReason });
        continue;
      }
      if (plan.status === "conflict" && !input.replace.has(plan.name)) {
        skipped.push({ name: plan.name, reason: "同名のためインポートしない" });
        continue;
      }
      const destination = join(await destinationRootOf(), plan.name);
      let backup: string | undefined;
      if (plan.replaceTarget !== undefined) {
        backup = join(backupDir, plan.name);
        await rename(plan.replaceTarget, backup).catch((error: unknown) => {
          throw importFailure(error);
        });
      }
      try {
        await rename(plan.staged.folder, destination).catch((error: unknown) => {
          throw importFailure(error);
        });
      } catch (error) {
        if (backup !== undefined && plan.replaceTarget !== undefined) {
          await rename(backup, plan.replaceTarget).catch(() => {});
        }
        throw error;
      }
      rollback.push({ destination, folder: plan.replaceTarget, backup });
      applied.push({
        name: plan.name,
        relativePath: `${COMMON_SKILLS_DIR}/${plan.name}/SKILL.md`,
        fileVersion: plan.staged.skillFileVersion,
        replaced: plan.replaceTarget !== undefined,
      });
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    return { applied, skipped, entries: input.entries, bytes: input.bytes };
  } catch (error) {
    for (const item of rollback.reverse()) {
      await rm(item.destination, { recursive: true, force: true }).catch(() => {});
      if (item.backup !== undefined && item.folder !== undefined) {
        await rename(item.backup, item.folder).catch(() => {});
      }
    }
    throw error;
  }
}

/**
 * `.agents/skills` の取り込み。構造の検証と staging への展開を済ませてから、共通スキル置き場の gate の内側で
 * 全件を検証 (plan) し、apply のときだけ書き込む。一時データは成功・失敗・中断のいずれでも消す。
 */
export async function importSkills(
  context: SkillCrudContext,
  input: {
    body: ReadableStream<Uint8Array> | null;
    replace: readonly string[];
    dryRun: boolean;
    signal?: AbortSignal;
  },
): Promise<SandboxSkillsImportResult> {
  const tempDir = await createImportTempDir(context.rootCwd);
  try {
    const archivePath = await receiveImportArchive({
      dir: tempDir,
      body: input.body,
      maxBytes: context.maxUploadBytes,
      signal: input.signal,
    });
    const archive = await readZipArchive(archivePath, context.archiveLimits);
    const groups = groupImportEntries(archive.entries);
    const staging = join(tempDir, "staging");
    await mkdir(staging, { recursive: true }).catch((error: unknown) => {
      throw importFailure(error);
    });
    const staged = await extractImportGroups({ archivePath, archive, groups, staging });
    return await context.gate.run(async () => {
      throwIfAborted(input.signal);
      const plans = await planSkillsImport({ rootCwd: context.rootCwd, staged, limits: context.archiveLimits });
      if (input.dryRun) {
        const skills = plans.map((plan): SandboxSkillImportPlanEntry => ({
          name: plan.name,
          status: plan.status,
          ...(plan.reason === undefined ? {} : { reason: plan.reason }),
        }));
        return { skills, entries: archive.entryCount, bytes: archive.bytes } satisfies SandboxSkillsImportPlan;
      }
      return await applySkillsImport({
        rootCwd: context.rootCwd,
        tempDir,
        plans,
        replace: new Set(input.replace),
        entries: archive.entryCount,
        bytes: archive.bytes,
        signal: input.signal,
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
