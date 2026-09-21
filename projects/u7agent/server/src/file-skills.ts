/**
 * ファイルスキル (`.agents/skills`) の発見と合成。BFF は作業領域をマウントしないため走査はサンドボックスへ委譲し、
 * ここでは共通 / プロジェクトの 2 スコープを優先順位で一意化して SDK の Skill にする。
 * 本文は持たず、モデルには filePath を read させる (本文は read 時点のファイル内容。docs/persistence.md)。
 */
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { isAppDirPath } from "./app-paths";
import { messageFor } from "./http";
import { SandboxRequestError, type SandboxToolClient } from "./sandbox/client";
import type { SandboxSkillEntry } from "./sandbox/protocol";
import type { FileSkillInfo, FileSkillsResponse } from "./schema";

/** 共通スキルの置き場 (workspace root 相対)。プロジェクトスキルは `<session cwd>/.agents/skills` */
export const COMMON_SKILLS_DIR = ".agents/skills";

/** ファイルスキルの発見元。優先順位は project > user */
export type FileSkillScope = "user" | "project";

/** 1 スコープ分の発見結果。entries はサンドボックスが返した順 (同じスコープ内は先勝ち) */
export interface FileSkillSource {
  scope: FileSkillScope;
  entries: SandboxSkillEntry[];
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
  /** GET /api/skills/files の応答 (skills と同じ並び) */
  response: FileSkillsResponse;
  /** 影になった組み合わせ (ログ用) */
  shadowed: ShadowedFileSkill[];
}

export interface SessionFileSkillInput {
  rootCwd: string;
  /** セッション cwd (root 相対)。プロジェクトスキルの起点で、未所属のスクラッチでは探索しない */
  relativeCwd: string;
}

/**
 * sources を優先順位の順に走査し、同じ実体 (path) と同名 (name) を先勝ちで一意化する。
 * ファイルの改名・削除・マージはせず、落ちた側を応答の shadowed に記録するだけにする。
 */
export function composeFileSkills(sources: FileSkillSource[], rootCwd: string): ComposedFileSkills {
  const skills: Skill[] = [];
  const rows: FileSkillInfo[] = [];
  const byPath = new Map<string, FileSkillInfo>();
  const byName = new Map<string, FileSkillInfo>();
  const shadowed: ShadowedFileSkill[] = [];

  for (const source of sources) {
    for (const entry of source.entries) {
      // 同じ実体を別スコープから見つけた場合 (プロジェクト側が共通側の symlink など) は同じ表示になるため警告にしない
      if (byPath.has(entry.path)) continue;
      const duplicateName = byName.get(entry.name);
      if (duplicateName) {
        duplicateName.shadowed.push({ path: entry.path, relativePath: fileSkillDisplayPath(rootCwd, entry.path) });
        shadowed.push({ name: duplicateName.name, keptPath: duplicateName.path, shadowedPath: entry.path });
        continue;
      }
      const row: FileSkillInfo = {
        name: entry.name,
        description: entry.description,
        path: entry.path,
        relativePath: fileSkillDisplayPath(rootCwd, entry.path),
        scope: source.scope,
        disableModelInvocation: entry.disableModelInvocation,
        shadowed: [],
      };
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
 * 先に並べ、優先順位 project > user で合成する。走査できない dir は落として続行し、セッション作成は止めない
 * (サンドボックス未設定の 503 は呼び出し側の既存判定が担う)。影になったスキルは警告としてログに残す。
 */
export async function discoverSessionFileSkills(
  client: SandboxToolClient,
  input: SessionFileSkillInput,
): Promise<ComposedFileSkills> {
  const targets: Array<{ scope: FileSkillScope; dir: string }> = [];
  // 未所属チャットのスクラッチ (<appdir>/sessions/<id>) と root 直下ではプロジェクトスキルを探さない
  if (input.relativeCwd && !isAppDirPath(input.relativeCwd)) {
    targets.push({ scope: "project", dir: `${input.relativeCwd}/${COMMON_SKILLS_DIR}` });
  }
  targets.push({ scope: "user", dir: COMMON_SKILLS_DIR });

  const sources = await Promise.all(
    targets.map(async (target): Promise<FileSkillSource> => ({
      scope: target.scope,
      entries: await listSkillsOrEmpty(client, target.dir),
    })),
  );
  const composed = composeFileSkills(sources, input.rootCwd);
  for (const item of composed.shadowed) {
    console.warn(`[u7agent] 同名のスキルが複数あるため ${item.shadowedPath} を読み込みません (有効: ${item.keptPath})`);
  }
  return composed;
}

/** 404 は「そのスコープに置き場が無い」だけ。他の失敗もこの dir を落とすに留める。 */
async function listSkillsOrEmpty(client: SandboxToolClient, dir: string): Promise<SandboxSkillEntry[]> {
  try {
    return (await client.listSkills(dir)).skills;
  } catch (error) {
    if (!(error instanceof SandboxRequestError && error.status === 404)) {
      console.warn(`[u7agent] スキルを発見できませんでした (${dir}): ${messageFor(error)}`);
    }
    return [];
  }
}

/** SDK の Skill へ写す。baseDir は SKILL.md の親、sourceInfo はスコープに対応させる。 */
function toSyntheticSkill(entry: SandboxSkillEntry, scope: FileSkillScope): Skill {
  const baseDir = dirname(entry.path);
  return {
    name: entry.name,
    description: entry.description,
    filePath: entry.path,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(entry.path, {
      source: "u7agent",
      scope,
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
