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
/** read ツールが追加の指示なしに返す本文の上限 (SDK の truncateHead の既定と同じ値) */
export const BUILTIN_SKILL_MAX_LINES = 2000;
/** read ツールが追加の指示なしに返す本文の上限 (SDK の truncateHead の既定と同じ値) */
export const BUILTIN_SKILL_MAX_BYTES = 51200;

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
 * 同梱 SKILL.md を読む。既定は起動時に 1 回だけで、壊れた同梱物や取り残した VERSIONS を抱えたまま
 * 起動しない (fail fast)。dir / versions はテストから差し替える (実物は Docker イメージに同梱される)。
 */
export function loadBuiltinSkills(
  options: { dir?: string; versions?: Record<string, string> } = {},
): readonly BuiltinSkillDef[] {
  const dir = options.dir ?? BUNDLED_DIR;
  const versions = options.versions ?? VERSIONS;
  const loaded = loadSkillsFromDir({ dir, source: BUILTIN_SKILLS_SOURCE });
  const problems = loaded.diagnostics.filter((diagnostic) => diagnostic.type !== "collision");
  if (problems.length > 0) {
    const detail = problems.map((problem) => `${problem.path ?? "(不明)"}: ${problem.message}`).join(" / ");
    throw new Error(`同梱スキルの SKILL.md が不正です: ${detail}`);
  }
  // dir ごと欠けたイメージでも「組み込み 0 件」で起動しない (VERSIONS の取り残しもここで検知する)
  if (loaded.skills.length === 0) {
    throw new Error(`同梱スキルがありません (${dir} に <name>/SKILL.md を置いてください)`);
  }
  const missing = Object.keys(versions).filter((name) => !loaded.skills.some((skill) => skill.name === name));
  if (missing.length > 0) {
    throw new Error(
      `同梱スキル ${missing.join(", ")} が見つかりません (VERSIONS の名前とディレクトリを合わせてください)`,
    );
  }
  return loaded.skills.map((skill) => {
    const version = versions[skill.name];
    if (!version) {
      throw new Error(
        `同梱スキル ${skill.name} の version が未定義です (builtin-skills.ts の VERSIONS に追加してください)`,
      );
    }
    const body = readFileSync(skill.filePath, "utf8");
    assertBuiltinSkillBodyFits(body, skill.name);
    return {
      name: skill.name,
      description: skill.description,
      version,
      body,
      disableModelInvocation: skill.disableModelInvocation,
    };
  });
}

/**
 * read ツールは 2000 行 / 51200 bytes で切り詰めるが、仮想パスの本文は formatBuiltinSkillBody が整形するため
 * 同じ切り詰めを実装していない。上限を超える本文を同梱すると切り詰めずに全文が context へ入るので、
 * 同梱時に弾いて分割を促す (skill-creator 自身も SKILL.md は 500 行以内を目安にしている)。
 */
export function assertBuiltinSkillBodyFits(body: string, name = "builtin"): void {
  const lines = body.split("\n").length;
  const bytes = Buffer.byteLength(body, "utf8");
  if (lines <= BUILTIN_SKILL_MAX_LINES && bytes <= BUILTIN_SKILL_MAX_BYTES) return;
  throw new Error(
    `同梱スキル ${name} の SKILL.md が大きすぎます (${lines} 行 / ${bytes} bytes。上限は ${BUILTIN_SKILL_MAX_LINES} 行 / ${BUILTIN_SKILL_MAX_BYTES} bytes)。references/ へ分割してください`,
  );
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
