/**
 * アプリに同梱する組み込みスキル (skill-creator など) の registry。
 * 本文の正本は `server/src/builtin-skills/<name>/SKILL.md` で、起動時に SDK の `loadSkillsFromDir` で
 * 読み込んで frontmatter を検証する (走査規則や検証を二重実装しない)。
 * ワークスペースへは materialize せず、モデルには仮想パス (`<root>/.u7agent/builtin-skills/...`) を
 * `read` させる。実ファイルが無いため、その要求は BFF が横取りしてこの本文を返す (sandbox/remote-tools.ts)。
 */
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIR_REL } from "./app-paths";

/** SKILL.md のファイル名。ファイルスキルの発見と同じ規約 */
export const SKILL_FILE_NAME = "SKILL.md";
/** 同梱スキルの置き場 (workspace root 相対)。ワークスペースには実体を作らない */
export const BUILTIN_SKILLS_DIR_REL = `${APP_DIR_REL}/builtin-skills`;
/** SDK の sourceInfo.source。ファイルスキルと同じくアプリ由来であることを示す */
export const BUILTIN_SKILLS_SOURCE = "u7agent";

/**
 * 同梱物の版。SKILL.md の本文や frontmatter を変えたら上げる。
 * 設定画面に表示し、同梱物が更新されたことをユーザーが確認できるようにする。
 */
const VERSIONS: Record<string, string> = { "skill-creator": "1" };

/** 同梱 SKILL.md のディレクトリ。tsx 実行なので import.meta.url はこのソースを指す (Docker も src/ を同梱する) */
const BUNDLED_DIR = fileURLToPath(new URL("./builtin-skills/", import.meta.url));

export interface BuiltinSkillDef {
  name: string;
  description: string;
  /** 同梱物の版 */
  version: string;
  /** SKILL.md の全文 (frontmatter 込み)。read の横取りで返す本文 */
  body: string;
  disableModelInvocation: boolean;
}

/**
 * 起動時に 1 回だけ読む。壊れた SKILL.md を同梱したまま起動しない (fail fast)。
 * frontmatter の name / description は SKILL.md を正本にし、version だけ VERSIONS で宣言する。
 */
function loadBuiltinSkills(): readonly BuiltinSkillDef[] {
  const loaded = loadSkillsFromDir({ dir: BUNDLED_DIR, source: BUILTIN_SKILLS_SOURCE });
  const problems = loaded.diagnostics.filter((diagnostic) => diagnostic.type !== "collision");
  if (problems.length > 0) {
    const detail = problems.map((problem) => `${problem.path ?? "(不明)"}: ${problem.message}`).join(" / ");
    throw new Error(`同梱スキルの SKILL.md が不正です: ${detail}`);
  }
  return loaded.skills.map((skill) => {
    const version = VERSIONS[skill.name];
    if (!version) {
      throw new Error(
        `同梱スキル ${skill.name} の version が未定義です (builtin-skills.ts の VERSIONS に追加してください)`,
      );
    }
    return {
      name: skill.name,
      description: skill.description,
      version,
      body: readFileSync(skill.filePath, "utf8"),
      disableModelInvocation: skill.disableModelInvocation,
    };
  });
}

/** 同梱 SKILL.md の一覧 (ディレクトリ名の昇順)。全セッション・全エージェントで使う */
export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = loadBuiltinSkills();

export function builtinSkillByName(name: string): BuiltinSkillDef | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.name === name);
}

/** 仮想パス (絶対)。model の read はこのパスを受け取り、設定画面もこのパスを表示する */
export function builtinSkillPath(rootCwd: string, name: string): string {
  return resolve(rootCwd, BUILTIN_SKILLS_DIR_REL, name, SKILL_FILE_NAME);
}

/**
 * 発見結果としての組み込みスキル。ファイルスキルと違いワークスペースに実体が無いため、
 * 本文と版を一覧へ載せて設定画面が本文を表示できるようにする (docs/api-catalog.md)。
 */
export function builtinSkillEntries(rootCwd: string): Array<{
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
  body: string;
  version: string;
}> {
  return BUILTIN_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: builtinSkillPath(rootCwd, skill.name),
    disableModelInvocation: skill.disableModelInvocation,
    body: skill.body,
    version: skill.version,
  }));
}

/**
 * read が要求したパスを組み込みスキルへ解決する。対象外は undefined (呼び出し側はサンドボックスへ委譲)。
 * 仮想パスはワークスペース root 配下にしか無いので、絶対パスは root からの相対で照合し、相対パスは
 * セッション cwd と root の両方を起点に試す (`..` で root へ上がる形も、`.u7agent/...` の root 相対も受ける)。
 * 実在確認はしない (仮想パスなので FS に触れず、既知の name だけを対象にする)。
 */
export function builtinSkillForRequestedPath(
  requestedPath: unknown,
  input: { cwd: string; rootCwd: string },
): BuiltinSkillDef | undefined {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") return undefined;
  const requested = requestedPath.trim();
  const base = resolve(input.rootCwd, BUILTIN_SKILLS_DIR_REL);
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : [resolve(input.cwd, requested), resolve(input.rootCwd, requested)];
  for (const candidate of candidates) {
    const rel = relative(base, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const [name, fileName, ...rest] = rel.split(sep);
    if (!name || fileName !== SKILL_FILE_NAME || rest.length > 0) continue;
    const skill = builtinSkillByName(name);
    if (skill) return skill;
  }
  return undefined;
}

/**
 * read ツールと同じ整形 (offset / limit と「続きがある」注記)。同梱 SKILL.md は 51KB 未満なので、
 * バイト上限による切り詰めは扱わない (超えたら同梱物を分割する)。
 */
export function formatBuiltinSkillBody(skill: BuiltinSkillDef, page: { offset?: number; limit?: number } = {}): string {
  const lines = skill.body.split("\n");
  const start = page.offset !== undefined && page.offset > 0 ? Math.max(0, page.offset - 1) : 0;
  if (start >= lines.length) {
    throw new Error(`Offset ${page.offset} is beyond end of file (${lines.length} lines total)`);
  }
  const limit = page.limit === undefined ? undefined : Math.max(0, page.limit);
  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const text = lines.slice(start, end).join("\n");
  const remaining = lines.length - end;
  return remaining > 0 ? `${text}\n\n[${remaining} more lines in file. Use offset=${end + 1} to continue.]` : text;
}
