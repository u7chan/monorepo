/**
 * ファイルスキル (`.agents/skills`) と組み込みスキルの発見と合成。BFF は作業領域をマウントしないため
 * ファイルの走査はサンドボックスへ委譲し、ここではスコープを優先順位で一意化して SDK の Skill にする。
 * 本文は持たず、モデルには filePath を read させる (本文は read 時点のファイル内容。docs/persistence.md)。
 * 組み込みだけは実ファイルが無いため、仮想パスと本文を registry から受け取る (builtin-skills.ts)。
 */
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { isAppDirPath } from "./app-paths";
import { builtinSkillEntries } from "./builtin-skills";
import { messageFor } from "./http";
import { SandboxRequestError, type SandboxToolClient } from "./sandbox/client";
import type { SandboxSkillEntry } from "./sandbox/protocol";
import type { FileSkillInfo, FileSkillsResponse } from "./schema";

/** 共通スキルの置き場 (workspace root 相対)。プロジェクトスキルは `<session cwd>/.agents/skills` */
export const COMMON_SKILLS_DIR = ".agents/skills";

/**
 * プロジェクトスキルの置き場 (root 相対)。未所属チャットのスクラッチ (`<appdir>/sessions/<id>`) と
 * root 直下では探索しないため undefined。一覧 API もこの判定を使う (探索範囲を二重実装しない)。
 */
export function projectSkillsDir(relativeCwd: string): string | undefined {
  if (!relativeCwd || isAppDirPath(relativeCwd)) return undefined;
  return `${relativeCwd}/${COMMON_SKILLS_DIR}`;
}

/** ファイルスキルの発見元。優先順位は project > user > builtin */
export type FileSkillScope = "user" | "project" | "builtin";

/** 発見した 1 件。組み込みだけはワークスペースに実体が無いので body / version を添える */
export interface FileSkillCandidate extends SandboxSkillEntry {
  body?: string;
  version?: string;
}

/** 1 スコープ分の発見結果。entries はサンドボックス (組み込みは registry) が返した順 (同じスコープ内は先勝ち) */
export interface FileSkillSource {
  scope: FileSkillScope;
  entries: FileSkillCandidate[];
}

export interface ShadowedFileSkill {
  name: string;
  /** 採用されたスキルのパス */
  keptPath: string;
  /** 一意化で落ちたスキルのパス */
  shadowedPath: string;
}

export interface ComposedFileSkills {
  /** SDK へ skillsOverride で渡す合成 Skill (name はスコープをまたいで一意) */
  skills: Skill[];
  /** GET /api/skills/files の応答 (読み込む側と同じ並び。組み込みは上書きされていても残す) */
  response: FileSkillsResponse;
  /** 影になった組み合わせ (ログ用) */
  shadowed: ShadowedFileSkill[];
}

export interface SessionFileSkillInput {
  rootCwd: string;
  /** セッション cwd (root 相対)。プロジェクトスキルの起点で、未所属のスクラッチでは探索しない */
  relativeCwd: string;
  /**
   * true なら置き場の不在 (404) 以外の失敗を投げる。一覧 API は「使えるスキル」を見せる場所なので、
   * 取れないことをエラーで見せる (既定はログに残して落とし、セッション作成を止めない)。
   */
  strict?: boolean;
}

/**
 * sources を優先順位の順に走査し、同じ実体 (path) と同名 (name) を先勝ちで一意化する。
 * ファイルの改名・削除・マージはせず、落ちた側を応答の shadowed に記録するだけにする。
 * ただし組み込みは一覧の別グループとして常に見せる必要があるため、上書きされた場合も行を残し
 * `overridden` を立てる (注入はしない)。ファイルスキル同士の重複は従来どおり警告にまとめる。
 */
export function composeFileSkills(sources: FileSkillSource[], rootCwd: string): ComposedFileSkills {
  const skills: Skill[] = [];
  const rows: FileSkillInfo[] = [];
  const byPath = new Map<string, FileSkillInfo>();
  const byName = new Map<string, FileSkillInfo>();
  const shadowed: ShadowedFileSkill[] = [];

  const makeRow = (entry: FileSkillCandidate, scope: FileSkillScope, overridden: boolean): FileSkillInfo => ({
    name: entry.name,
    description: entry.description,
    path: entry.path,
    relativePath: fileSkillDisplayPath(rootCwd, entry.path),
    scope,
    disableModelInvocation: entry.disableModelInvocation,
    shadowed: [],
    overridden,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    ...(entry.version === undefined ? {} : { version: entry.version }),
  });

  for (const source of sources) {
    for (const entry of source.entries) {
      // 同じ実体を別スコープから見つけた場合 (プロジェクト側が共通側の symlink など) は同じ表示になるため警告にしない
      if (byPath.has(entry.path)) continue;
      const duplicateName = byName.get(entry.name);
      if (duplicateName) {
        shadowed.push({ name: duplicateName.name, keptPath: duplicateName.path, shadowedPath: entry.path });
        if (source.scope === "builtin") {
          // 組み込みは設定一覧にも残す (上書き状態は行が出ている側ではなく組み込み側に立てる)
          rows.push(makeRow(entry, source.scope, true));
        } else {
          duplicateName.shadowed.push({ path: entry.path, relativePath: fileSkillDisplayPath(rootCwd, entry.path) });
        }
        continue;
      }
      const row = makeRow(entry, source.scope, false);
      rows.push(row);
      byPath.set(entry.path, row);
      byName.set(entry.name, row);
      skills.push(toSyntheticSkill(entry, source.scope));
    }
  }
  return { skills, response: { skills: rows }, shadowed };
}

/**
 * セッション作成 / 復元時の発見。プロジェクト (`<cwd>/.agents/skills`) を共通 (`<root>/.agents/skills`) より
 * 先に並べ、優先順位 project > user > builtin で合成する。走査できない dir は落として続行し、
 * セッション作成は止めない (サンドボックス未設定の 503 は呼び出し側の既存判定が担う)。
 * 組み込みはサンドボックスに依らないので、発見に失敗しても常に注入する。影になったスキルはログに残す。
 */
export async function discoverSessionFileSkills(
  client: SkillScanClient,
  input: SessionFileSkillInput,
): Promise<ComposedFileSkills> {
  const targets: Array<{ scope: FileSkillScope; dir: string }> = [];
  const projectDir = projectSkillsDir(input.relativeCwd);
  if (projectDir) targets.push({ scope: "project", dir: projectDir });
  targets.push({ scope: "user", dir: COMMON_SKILLS_DIR });

  const sources: FileSkillSource[] = await Promise.all(
    targets.map(async (target): Promise<FileSkillSource> => ({
      scope: target.scope,
      entries: await listSkillsOrEmpty(client, target.dir, input.strict ?? false),
    })),
  );
  // 組み込みはワークスペースに実体が無いため、最後 (最低優先) に足す
  sources.push({ scope: "builtin", entries: builtinSkillEntries(input.rootCwd) });
  const composed = composeFileSkills(sources, input.rootCwd);
  for (const item of composed.shadowed) {
    console.warn(`[u7agent] 同名のスキルが複数あるため ${item.shadowedPath} を読み込みません (有効: ${item.keptPath})`);
  }
  return composed;
}

/** 発見に必要なサンドボックスの操作だけ (workspace client でも tool client でも受けられる) */
export type SkillScanClient = Pick<SandboxToolClient, "listSkills">;

/** 404 は「そのスコープに置き場が無い」だけ。他の失敗も (strict でなければ) この dir を落とすに留める。 */
async function listSkillsOrEmpty(client: SkillScanClient, dir: string, strict: boolean): Promise<SandboxSkillEntry[]> {
  try {
    return (await client.listSkills(dir)).skills;
  } catch (error) {
    if (!(error instanceof SandboxRequestError && error.status === 404)) {
      if (strict) throw error;
      console.warn(`[u7agent] スキルを発見できませんでした (${dir}): ${messageFor(error)}`);
    }
    return [];
  }
}

/** SDK の Skill へ写す。baseDir は SKILL.md の親、sourceInfo はスコープに対応させる。 */
function toSyntheticSkill(entry: FileSkillCandidate, scope: FileSkillScope): Skill {
  const baseDir = dirname(entry.path);
  return {
    name: entry.name,
    description: entry.description,
    filePath: entry.path,
    baseDir,
    // 組み込みはワークスペースに実体が無い仮想パスなので、SDK の scope では temporary (path) として扱う
    sourceInfo: createSyntheticSourceInfo(entry.path, {
      source: "u7agent",
      scope: scope === "builtin" ? "temporary" : scope,
      origin: "top-level",
      baseDir,
    }),
    disableModelInvocation: entry.disableModelInvocation,
  };
}

/**
 * 表示用の root 相対パス。サンドボックスの path は realpath なので、root 自体も実パスへ寄せてから比較する
 * (root が symlink でも表示が絶対パスへ落ちないように)。root の外へ解決する場合は絶対パスのまま返す。
 */
function fileSkillDisplayPath(rootCwd: string, absolutePath: string): string {
  const root = realRoot(rootCwd);
  const rel = relative(root, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** realpath は FS に触るため、root が無い (テストなど) ときは lexical な resolve に落とす。 */
function realRoot(rootCwd: string): string {
  try {
    return realpathSync.native(rootCwd);
  } catch {
    return resolve(rootCwd);
  }
}
