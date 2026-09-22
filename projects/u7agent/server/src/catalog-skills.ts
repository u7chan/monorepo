/**
 * カタログ (Agent 割り当て) スキルの仮想パスと索引。組み込みと同じくワークスペースに実体を作らず、
 * モデルにはこのパスを `read` させる (本文はセッションの promptSnapshot から BFF が横取りして返す)。
 * 索引 (name / description / location) だけを skillsOverride で常時渡し、本文は必要時に読む。
 * 実体が無いため `ls` / `find` / `grep` / `bash` からは見えない (組み込みと同じ割り切り)。
 */
import { createSyntheticSourceInfo, type Skill } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { APP_DIR_REL } from "./app-paths";
import { SKILL_FILE_NAME } from "./builtin-skills";

/** カタログスキルの置き場 (workspace root 相対)。組み込み (`builtin-skills`) とは別の名前空間にする */
export const CATALOG_SKILLS_DIR_REL = `${APP_DIR_REL}/agent-skills`;

/**
 * 仮想パスの 1 セグメント。名前に `/` などが含まれても 1 セグメントに畳んで、置き場の外へ出ないように
 * する (`.` / `..` は encodeURIComponent が変えないため、パス要素として特別な名前だけドットを逃がす)。
 */
function catalogSkillSegment(name: string): string {
  const encoded = encodeURIComponent(name);
  return encoded === "." || encoded === ".." ? encoded.replaceAll(".", "%2E") : encoded;
}

/** セグメントを名前に戻す。壊れた percent encoding は undefined (呼び出し側はサンドボックスへ委譲) */
function catalogSkillNameFromSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** 仮想パス (絶対)。モデルの read と一覧の location が同じ値を使う */
export function catalogSkillPath(rootCwd: string, name: string): string {
  return resolve(rootCwd, CATALOG_SKILLS_DIR_REL, catalogSkillSegment(name), SKILL_FILE_NAME);
}

/** 表示用の root 相対パス。仮想パスは root 配下にしか作らないので常に相対で返る */
export function catalogSkillRelativePath(name: string): string {
  return `${CATALOG_SKILLS_DIR_REL}/${catalogSkillSegment(name)}/${SKILL_FILE_NAME}`;
}

export interface CatalogSkillIndexEntry {
  name: string;
  description: string;
}

/**
 * SDK の skillsOverride へ渡す索引。本文は持たず、モデルには filePath (仮想パス) を read させる。
 * 名前はスコープをまたいで一意にする: ファイル / 組み込み (takenNames) と同名の行は落とし、カタログ
 * 同士の重複も先勝ちにする。一覧 (`resolveSessionSkills`) の優先順位 project > user > builtin > catalog
 * と同じ結果になるよう、落とす側だけをここで決める。
 */
export function catalogSkillIndex(
  rootCwd: string,
  skills: readonly CatalogSkillIndexEntry[],
  takenNames: Iterable<string> = [],
): Skill[] {
  const taken = new Set(takenNames);
  const index: Skill[] = [];
  for (const skill of skills) {
    if (!skill.name || taken.has(skill.name)) continue;
    taken.add(skill.name);
    const filePath = catalogSkillPath(rootCwd, skill.name);
    const baseDir = dirname(filePath);
    index.push({
      name: skill.name,
      description: skill.description,
      filePath,
      baseDir,
      // 実ファイルが無い仮想パスなので、SDK の scope では組み込みと同じ temporary (path 扱い) にする
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: "u7agent",
        scope: "temporary",
        origin: "top-level",
        baseDir,
      }),
      // カタログはモデル起動の可否を持たない (一覧に出せば呼べる)
      disableModelInvocation: false,
    });
  }
  return index;
}

/**
 * セッションの promptSnapshot (name / body) とエージェントスナップショット (name / description) から
 * 索引を組む。説明は本文と同じく作成時点の値を使い、定義を編集しても遡及させない。
 */
export function catalogSkillIndexForSession(
  rootCwd: string,
  catalogSkills: readonly { name: string; body: string }[],
  agentSkills: readonly { name: string; description: string }[],
  takenNames: Iterable<string> = [],
): Skill[] {
  const descriptions = new Map(agentSkills.map((skill) => [skill.name, skill.description]));
  return catalogSkillIndex(
    rootCwd,
    catalogSkills.map((skill) => ({ name: skill.name, description: descriptions.get(skill.name) ?? "" })),
    takenNames,
  );
}

/**
 * read が要求したパスをカタログスキル名へ解決する。対象外は undefined (呼び出し側はサンドボックスへ委譲)。
 * 仮想パスはワークスペース root 配下にしか無いので、絶対パスは root からの相対で照合し、相対パスは
 * セッション cwd と root の両方を起点に試す (`..` で root へ上がる形も、`.u7agent/...` の root 相対も受ける)。
 * 本文の有無は見ない (名前が分かっても、このセッションのスナップショットに無ければ呼び出し側が委譲する)。
 */
export function catalogSkillNameForRequestedPath(
  requestedPath: unknown,
  input: { cwd: string; rootCwd: string },
): string | undefined {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") return undefined;
  const requested = requestedPath.trim();
  const base = resolve(input.rootCwd, CATALOG_SKILLS_DIR_REL);
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : [resolve(input.cwd, requested), resolve(input.rootCwd, requested)];
  for (const candidate of candidates) {
    const rel = relative(base, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const [segment, fileName, ...rest] = rel.split(sep);
    if (!segment || fileName !== SKILL_FILE_NAME || rest.length > 0) continue;
    return catalogSkillNameFromSegment(segment);
  }
  return undefined;
}
