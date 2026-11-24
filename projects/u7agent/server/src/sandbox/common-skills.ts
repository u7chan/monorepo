import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadSkillsFromDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { COMMON_SKILLS_DIR, COMMON_SKILLS_SEGMENTS } from "../app-paths";
import { messageFor, pathError } from "../errors";
import { isInsideRoot } from "../path-strings";
import type { SerialLock } from "../serial-lock";
import type { ArchiveLimits } from "./archive";
import {
  deepestExistingReal,
  realpathNative,
  relativeToRoot,
  resolveCommonSkillTarget,
  resolveWorkspaceDirectory,
  skillScanFailure,
  throwIfAborted,
  type CommonSkillTarget,
} from "./fs-path";
import {
  isValidEntryName,
  SANDBOX_MAX_SKILL_SAVE_BYTES,
  type SandboxSkillCreateBody,
  type SandboxSkillCreateResult,
  type SandboxSkillDeletePreview,
  type SandboxSkillEntry,
  type SandboxSkillFileDetail,
  type SandboxSkillSaveBody,
  type SandboxSkillSaveResult,
  type SandboxSkillsResponse,
} from "./protocol";
import {
  createSkillText,
  editSkillText,
  inspectSkillText,
  skillFileVersion,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from "./skill-edit";
import { scanSkillsWithDeadline } from "./skills-scan";

/**
 * root 相対のディレクトリ配下のスキルを発見する。走査規則 (hidden・node_modules のスキップ、ignore ファイル、
 * 再帰、frontmatter 検証) は SDK の loadSkillsFromDir に委譲し、返すのは SKILL.md だけにする
 * (SDK は直下の非 SKILL.md も読むが、`.agents/skills` の規約とずれるため落とす)。
 * SDK は子ディレクトリと SKILL.md の symlink を辿るため、realpath が root 外になるものは除外する。
 * 応答の path は realpath に揃え、同じ実体へ解決する重複 (symlink 経由・循環リンク) は 1 件に畳む。
 * 走査は別スレッドで実行し、循環 symlink による指数的増殖では期限で打ち切る (skills-scan.ts)。
 */
export async function listWorkspaceSkills(
  rootCwd: string,
  requestedDir: string,
  scanTimeoutMs: number,
): Promise<SandboxSkillsResponse> {
  const { root, target } = await resolveWorkspaceDirectory(rootCwd, requestedDir);

  const skills: SandboxSkillEntry[] = [];
  const seen = new Set<string>();
  for (const skill of (await scanSkillsWithDeadline(target, scanTimeoutMs)).skills) {
    if (basename(skill.filePath) !== "SKILL.md") continue;
    const real = await realpathNative(skill.filePath).catch(() => undefined);
    if (!real || !isInsideRoot(root, real, sep) || seen.has(real)) continue;
    seen.add(real);
    skills.push({
      name: skill.name,
      description: skill.description,
      path: real,
      disableModelInvocation: skill.disableModelInvocation,
    });
  }
  return { skills };
}

/**
 * 共通スキル (`.agents/skills`) の GUI CRUD の面倒な依存。service のオプションから組み立てる。
 * 走査の期限と削除の走査上限は既存の値をそのまま使う (GUI 用の別上限を作らない)。
 */
export interface SkillCrudContext {
  rootCwd: string;
  scanTimeoutMs: number;
  archiveLimits: ArchiveLimits;
  /** 取り込みの受信 ZIP の上限 (アップロードと同じ値) */
  maxUploadBytes: number;
  /** 共通スキル置き場の外側 gate。SDK のファイル隊列より先に取る (順序を固定する) */
  gate: SerialLock;
}

/** JSON body から必要な文字列フィールドだけを読む。型違いと欠落は 400 にする (余分なキーは無視する) */
export function skillTextFieldsOf(
  body: unknown,
  keys: readonly string[],
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const value: Record<string, string> = {};
  for (const key of keys) {
    const raw = (body as Record<string, unknown>)[key];
    if (typeof raw !== "string") return { ok: false, message: `${key} must be a string` };
    value[key] = raw;
  }
  return { ok: true, value };
}

/**
 * 既存のファイル変更 API が共通スキル置き場へ影響し得るか。`inside` は置き場とその配下だけ、
 * `any` は置き場の祖先 (改名 / 移動 / 削除で置き場ごと動く) も含める。判定できないときは安全側へ倒す。
 */
export async function touchesCommonSkills(input: {
  rootCwd: string;
  requested: string;
  mode: "inside" | "any";
}): Promise<boolean> {
  const lexicalRoot = resolve(input.rootCwd);
  const lexical = resolve(lexicalRoot, input.requested || ".");
  if (!isInsideRoot(lexicalRoot, lexical, sep)) return true;
  const skillsLexical = join(lexicalRoot, COMMON_SKILLS_DIR);
  const realSkills = await realpathNative(skillsLexical).catch(() => undefined);
  if (realSkills === undefined) {
    if (isInsideRoot(skillsLexical, lexical, sep)) return true;
    return input.mode === "any" && isInsideRoot(lexical, skillsLexical, sep);
  }
  const anchor = await deepestExistingReal(lexical);
  const target = anchor?.real ?? lexical;
  if (isInsideRoot(realSkills, target, sep)) return true;
  return input.mode === "any" && isInsideRoot(target, realSkills, sep);
}

/** 共通スキルの SKILL.md の内容と版。読みと検証は常にこの組で扱う */
interface CommonSkillFileContent {
  text: string;
  version: string;
  /** mtime (epoch ms)。画面に出す目安で、保存の照合には使わない */
  mtime: number;
}

async function readCommonSkillContent(
  target: CommonSkillTarget,
  signal?: AbortSignal,
): Promise<CommonSkillFileContent> {
  throwIfAborted(signal);
  // 読めない理由は read / stat で揃える (消えていれば 404、それ以外は 400)
  const fail = (error: unknown): never => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target.lexical}`);
    throw pathError(400, `Cannot read the skill file: ${messageFor(error)}`);
  };
  const bytes = await readFile(target.lexical).catch(fail);
  // 表示用の目安。read とは別の syscall なので直後の更新は取りこぼしうるが、保存の照合は
  // 内容そのもの (fileVersion) で行うため、表示のずれが競合検出を弱めることはない
  const stats = await stat(target.lexical).catch(fail);
  return { text: decodeUtf8(bytes), version: skillFileVersion(bytes), mtime: Math.round(stats.mtimeMs) };
}

/** UTF-8 のテキストだけを受け付ける (GUI はテキストを編集する) */
function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw pathError(400, "UTF-8 のテキストではないため編集できません");
  }
}

/** 発見した一覧から実パスが一致する 1 件を取る (GUI の要求は一覧の relativePath に揃う) */
async function discoverCommonSkill(
  context: SkillCrudContext,
  realFile: string,
): Promise<SandboxSkillEntry | undefined> {
  const discovery = await listWorkspaceSkills(context.rootCwd, COMMON_SKILLS_DIR, context.scanTimeoutMs);
  return discovery.skills.find((skill) => skill.path === realFile);
}

/** 編集内容の取得。name / description は SDK の発見結果、body は trim していない原文 */
export async function readCommonSkillDetail(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<SandboxSkillFileDetail> {
  const target = await resolveCommonSkillTarget({ rootCwd: context.rootCwd, requested, mustExist: true });
  const content = await readCommonSkillContent(target, signal);
  const info = inspectSkillText(content.text);
  const entry = target.real ? await discoverCommonSkill(context, target.real) : undefined;
  const folderName = basename(dirname(target.lexical));
  const relativePath = target.real ? relativeToRoot(target.realRoot, target.real) : target.relativePath;
  // 保存の要求は BFF の bodyGuard を通るため、上限を超えるファイルは閲覧だけにする
  const tooLarge = Buffer.byteLength(content.text, "utf8") > SANDBOX_MAX_SKILL_SAVE_BYTES;
  const editable = info.reason === undefined && entry !== undefined && !tooLarge;
  const reason =
    info.reason ??
    (entry === undefined
      ? "現在の内容をスキルとして読み込めません"
      : tooLarge
        ? `保存の要求の上限 (${Math.floor(SANDBOX_MAX_SKILL_SAVE_BYTES / 1024)} KiB) を超えるため保存できません`
        : undefined);
  return {
    name: entry?.name ?? info.name ?? folderName,
    description: entry?.description ?? info.description ?? "",
    body: info.body,
    relativePath,
    fileVersion: content.version,
    mtime: content.mtime,
    editable,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * フォルダ 1 つを SDK にスキルとして読ませる。新しいスキルの作成と同じ判定で、
 * 1 件だけ読めて診断が 1 件も無いことを要求する (取り込みの staging で使う)。
 */
export async function diagnoseSkillFolder(
  folder: string,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const scanned = await loadSkillsFromDir({ dir: folder, source: "u7agent" });
  const failure = skillScanFailure(scanned);
  if (failure !== undefined) return { ok: false, message: failure };
  const skill = scanned.skills[0];
  if (!skill) return { ok: false, message: "スキルとして読み込めません" };
  return { ok: true, name: skill.name };
}

/** 一時ディレクトリで SDK に候補を読ませる。公開前の検証を SDK の規則だけで行う */
async function diagnoseSkillCandidate(input: {
  text: string;
  /** 変更前の内容。既存の name / 説明由来の warning は許し、新しい warning だけを拒否する */
  baseline?: { text: string };
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-skill-check-"));
  try {
    const write = async (name: string, text: string): Promise<string> => {
      const folder = join(dir, name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), text, "utf8");
      return folder;
    };
    if (!input.baseline) {
      const staged = await diagnoseSkillFolder(await write("candidate", input.text));
      return staged.ok ? { ok: true } : { ok: false, message: staged.message };
    }
    const candidate = await loadSkillsFromDir({ dir: await write("candidate", input.text), source: "u7agent" });
    if (candidate.skills.length !== 1 || !candidate.skills[0]) {
      return { ok: false, message: skillScanFailure(candidate) ?? "スキルとして読み込めません" };
    }
    const existing = await loadSkillsFromDir({ dir: await write("baseline", input.baseline.text), source: "u7agent" });
    const known = new Set(existing.diagnostics.map((item) => `${item.type}:${item.message}`));
    const added = candidate.diagnostics.filter((item) => !known.has(`${item.type}:${item.message}`));
    if (added.length > 0) return { ok: false, message: added.map((item) => item.message).join(" / ") };
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 同じディレクトリの一時ファイルから atomic に公開する (途中の内容を読み手に見せない) */
async function writeFileAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.u7agent-tmp-${randomUUID()}`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** フォルダ全体の走査結果。削除確認と削除直前の照合で同じ計算を使う */
interface SkillFolderScan {
  bytes: number;
  entries: number;
  files: string[];
  digest: string;
}

/**
 * フォルダ全体の決定的なダイジェスト。相対パスをソートし、エントリ種別・通常ファイルの内容ハッシュ・
 * symlink のリンク文字列を含める (隠しファイルも付随ファイルも除外しない)。参照先は辿らない。
 * 上限を超える / 読めないエントリがあるときは、変更前に拒否する。
 */
async function scanSkillFolder(folder: string, limits: ArchiveLimits): Promise<SkillFolderScan> {
  const lines: string[] = [];
  const files: string[] = [];
  let bytes = 0;
  let entries = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${dir}`);
      throw pathError(400, `Cannot read the skill folder: ${messageFor(error)}`);
    });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      entries += 1;
      if (entries > limits.maxEntries) {
        throw pathError(413, `Too many entries in the skill folder (max ${limits.maxEntries})`);
      }
      const absolute = join(dir, child.name);
      if (child.isSymbolicLink()) {
        const link = await readlink(absolute).catch((error: unknown) => {
          throw pathError(400, `Cannot read the symbolic link: ${messageFor(error)}`);
        });
        lines.push(`l:${name}:${link}`);
        files.push(name);
        continue;
      }
      if (child.isDirectory()) {
        lines.push(`d:${name}`);
        files.push(`${name}/`);
        await walk(absolute, name);
        continue;
      }
      if (child.isFile()) {
        const content = await readFile(absolute).catch((error: unknown) => {
          throw pathError(400, `Cannot read the skill file: ${messageFor(error)}`);
        });
        bytes += content.byteLength;
        if (bytes > limits.maxBytes) {
          throw pathError(413, `Too large skill folder (max ${limits.maxBytes} bytes)`);
        }
        lines.push(`f:${name}:${skillFileVersion(content)}`);
        files.push(name);
        continue;
      }
      lines.push(`o:${name}`);
      files.push(name);
    }
  };
  await walk(folder, "");
  return { bytes, entries, files, digest: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/** 削除する専用フォルダ (実パス) と、発見した名前・root 相対の表示パス */
interface CommonSkillFolder {
  relativePath: string;
  name: string;
  folder: string;
  skillFile: string;
}

/**
 * 削除対象のフォルダを特定する。SKILL.md が symlink の場合は専用フォルダを特定できないため拒否し、
 * フォルダ自身が symlink のときは実体の方を対象にする (要求の lexical パスへ rm してリンクだけ消す事故を防ぐ)。
 */
async function resolveCommonSkillFolder(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<{ target: CommonSkillTarget; folder: CommonSkillFolder }> {
  const target = await resolveCommonSkillTarget({ rootCwd: context.rootCwd, requested, mustExist: true });
  throwIfAborted(signal);
  const stats = await lstat(target.lexical).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw pathError(404, `Path not found: ${target.lexical}`);
    throw pathError(400, `Cannot resolve the skill file: ${messageFor(error)}`);
  });
  if (stats.isSymbolicLink()) throw pathError(400, "SKILL.md がシンボリックリンクのため削除できません");
  if (!stats.isFile()) throw pathError(400, `Not a regular file: ${target.lexical}`);
  if (target.real === undefined || target.realSkillsDir === undefined) {
    throw pathError(400, `Not a common skill path: ${requested}`);
  }
  const folder = dirname(target.real);
  if (folder === target.realSkillsDir) {
    // 置き場直下の SKILL.md は専用フォルダが置き場自身になるため削除しない
    throw pathError(400, "共通スキル置き場そのものは削除できません");
  }
  const found = await discoverCommonSkill(context, target.real);
  if (!found) throw pathError(404, "そのスキルは現在の一覧に発見できません");
  return {
    target,
    folder: {
      relativePath: relativeToRoot(target.realRoot, target.real),
      name: found.name,
      folder,
      skillFile: target.real,
    },
  };
}

/** 削除確認。取消は副作用なしで、ここでは何も変更しない */
export async function previewCommonSkillDelete(
  context: SkillCrudContext,
  requested: string,
  signal?: AbortSignal,
): Promise<SandboxSkillDeletePreview> {
  const { target, folder } = await resolveCommonSkillFolder(context, requested, signal);
  const scan = await scanSkillFolder(folder.folder, context.archiveLimits);
  if (!scan.files.includes("SKILL.md")) throw pathError(400, "SKILL.md を見つけられません");
  return {
    relativePath: folder.relativePath,
    name: folder.name,
    dir: relativeToRoot(target.realRoot, folder.folder),
    treeVersion: scan.digest,
    entries: scan.entries,
    bytes: scan.bytes,
    files: scan.files,
  };
}

/** 公開後の実際の発見一覧で、対象パスと内容が読めることを確認する */
async function verifyPublishedSkill(
  context: SkillCrudContext,
  realFile: string,
  expect: { description: string; name?: string },
): Promise<string | undefined> {
  const found = await discoverCommonSkill(context, realFile);
  if (!found) return "公開したスキルを発見できません";
  if (found.description !== expect.description) return "公開したスキルの説明が一致しません";
  if (expect.name !== undefined && found.name !== expect.name) return "公開したスキルの名前が一致しません";
  return undefined;
}

/**
 * 共通スキルの新規作成。排他内で同名の確認・公開前の SDK 検証・atomic な公開を行い、公開後にも
 * 実際の発見一覧で確認する。組み込みとの同名は既存の優先順位に委ねる (ここでは共通内だけを見る)。
 */
export async function createCommonSkill(
  context: SkillCrudContext,
  body: SandboxSkillCreateBody,
  signal?: AbortSignal,
): Promise<SandboxSkillCreateResult> {
  if (!isValidEntryName(body.name) || body.name.startsWith(".")) {
    throw pathError(400, `Invalid skill name: ${body.name}`);
  }
  if (body.description.trim() === "") throw pathError(400, "説明を入力してください");
  if (body.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw pathError(400, `説明は ${SKILL_DESCRIPTION_MAX_LENGTH} 文字以内にしてください`);
  }
  const text = createSkillText({ name: body.name, description: body.description, body: body.body });
  return context.gate.run(async () => {
    throwIfAborted(signal);
    const relativePath = [...COMMON_SKILLS_SEGMENTS, body.name, "SKILL.md"].join("/");
    const target = await resolveCommonSkillTarget({
      rootCwd: context.rootCwd,
      requested: relativePath,
      mustExist: false,
    });
    // 既存のディレクトリ (SKILL.md が無くても) も同名の共通スキルも上書きしない
    const existing = await lstat(dirname(target.lexical)).catch(() => undefined);
    if (existing) throw pathError(409, `既に存在します: ${relativePath}`);
    if (target.realSkillsDir !== undefined) {
      const discovery = await listWorkspaceSkills(context.rootCwd, COMMON_SKILLS_DIR, context.scanTimeoutMs);
      if (discovery.skills.some((skill) => skill.name === body.name)) {
        throw pathError(409, `同名の共通スキルが既にあります: ${body.name}`);
      }
    }
    const staged = await diagnoseSkillCandidate({ text });
    if (!staged.ok) throw pathError(400, `新しいスキルを作成できません: ${staged.message}`);
    const folder = dirname(target.lexical);
    const createdFolder = !(await lstat(folder).catch(() => undefined));
    try {
      await mkdir(folder, { recursive: true });
      await writeFileAtomic(target.lexical, text);
    } catch (error) {
      if (createdFolder) await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw pathError(400, `新しいスキルを作成できません: ${messageFor(error)}`);
    }
    const realFile = await realpathNative(target.lexical).catch(() => undefined);
    if (realFile === undefined || !isInsideRoot(target.realRoot, realFile, sep)) {
      throw pathError(400, "新しいスキルの実体を確認できません");
    }
    const nextVersion = skillFileVersion(Buffer.from(text, "utf8"));
    const failure = await verifyPublishedSkill(context, realFile, { description: body.description, name: body.name });
    if (failure) {
      // 自分が作った内容のままのときだけ畳む (確認の間に他者が変更していれば触らない)
      const current = await readFile(realFile).catch(() => undefined);
      if (current && skillFileVersion(current) === nextVersion) {
        await rm(dirname(realFile), { recursive: true, force: true }).catch(() => {});
      }
      throw pathError(500, `${failure}。現在の一覧を確認してください`);
    }
    return { relativePath: relativeToRoot(target.realRoot, realFile), fileVersion: nextVersion };
  });
}

/**
 * 共通スキルの保存。版照合 → 決定的な差し替え → 公開前の SDK 検証 → SDK のファイル隊列を使った
 * atomic な公開 → 公開後の確認の順に、すべて共通 gate の中で行う。変更なしなら書き込まない。
 */
export async function saveCommonSkill(
  context: SkillCrudContext,
  body: SandboxSkillSaveBody,
  signal?: AbortSignal,
): Promise<SandboxSkillSaveResult> {
  return context.gate.run(async () => {
    throwIfAborted(signal);
    const target = await resolveCommonSkillTarget({
      rootCwd: context.rootCwd,
      requested: body.relativePath,
      mustExist: true,
    });
    const content = await readCommonSkillContent(target, signal);
    if (content.version !== body.fileVersion) {
      throw pathError(409, "スキルが他の変更と競合しました。再読み込みしてから保存してください");
    }
    const realFile = target.real ?? target.lexical;
    // 現行の一覧に発見できない内容は保存しない (公開後の確認まで進めても戻せない)
    if (target.real === undefined || !(await discoverCommonSkill(context, target.real))) {
      throw pathError(400, "現在の内容をスキルとして読み込めないため保存できません");
    }
    const edited = editSkillText({ original: content.text, description: body.description, body: body.body });
    if (!edited.ok) throw pathError(400, edited.reason);
    const relativePath = target.real ? relativeToRoot(target.realRoot, target.real) : target.relativePath;
    if (!edited.changed) return { relativePath, fileVersion: content.version };
    const staged = await diagnoseSkillCandidate({ text: edited.text, baseline: { text: content.text } });
    if (!staged.ok) throw pathError(400, `保存できません: ${staged.message}`);
    const expectedName = inspectSkillText(edited.text).name ?? basename(dirname(target.lexical));
    const nextVersion = skillFileVersion(Buffer.from(edited.text, "utf8"));
    await withFileMutationQueue(realFile, async () => {
      // 直前の再確認。ここで観測した変更は拒否する (外部プロセスとの完全な CAS は保証しない)
      const current = await readCommonSkillContent(target, signal).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode === 404) {
          throw pathError(409, "スキルが削除されました。再読み込みしてください");
        }
        throw error;
      });
      if (current.version !== body.fileVersion) {
        throw pathError(409, "スキルが他の変更と競合しました。再読み込みしてから保存してください");
      }
      await writeFileAtomic(target.lexical, edited.text).catch((error: unknown) => {
        throw pathError(400, `保存できません: ${messageFor(error)}`);
      });
    });
    const failure = await verifyPublishedSkill(context, realFile, {
      description: body.description,
      name: expectedName,
    });
    if (failure) {
      // 自分が書いた版のままのときだけ、元の内容へ戻す (他の更新は巻き戻さない)
      const current = await readFile(realFile).catch(() => undefined);
      if (current && skillFileVersion(current) === nextVersion) {
        await writeFileAtomic(realFile, content.text).catch(() => {});
      }
      throw pathError(500, `${failure}。現在の一覧を確認してください`);
    }
    return { relativePath, fileVersion: nextVersion };
  });
}

/**
 * 共通スキルの専用フォルダ削除。treeVersion の照合を取ってから、配下ごと削除する。
 * symlink の参照先は辿らず、対象フォルダ内のエントリだけを扱う。
 */
export async function deleteCommonSkill(
  context: SkillCrudContext,
  requested: string,
  treeVersion: string,
  signal?: AbortSignal,
): Promise<void> {
  return context.gate.run(async () => {
    throwIfAborted(signal);
    const { folder } = await resolveCommonSkillFolder(context, requested, signal);
    const scan = await scanSkillFolder(folder.folder, context.archiveLimits);
    if (scan.digest !== treeVersion) {
      throw pathError(409, "フォルダの内容が変わりました。削除の確認を取り直してください");
    }
    await withFileMutationQueue(folder.skillFile, async () => {
      // 取得待ちの間の変更を確かめ直す (この 2 回目の scan 中に別の変更が入った場合は rm 後に気付く)
      const again = await scanSkillFolder(folder.folder, context.archiveLimits);
      if (again.digest !== treeVersion) {
        throw pathError(409, "フォルダの内容が変わりました。削除の確認を取り直してください");
      }
      await rm(folder.folder, { recursive: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw pathError(400, `Cannot delete the skill folder: ${messageFor(error)}`);
      });
    });
  });
}
