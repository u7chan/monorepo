/**
 * 共通スキル (`.agents/skills`) と組み込みスキルの表示用の導出。重複警告・上書き表示の文言をここ 1 箇所へ閉じ、
 * コンポーネントは結果を描画するだけにする (docs/api-catalog.md)。
 */
import type { FileSkillInfo } from "../types";

/** 読み取り専用ブロック (共通 + 組み込み) の見出し。「読み取り専用」はここ 1 箇所にだけ出す */
export const FILE_SKILL_SECTION_LABEL = "読み取り専用スキル";
export const FILE_SKILL_GROUP_LABEL = "共通スキル";
export const BUILTIN_SKILL_GROUP_LABEL = "組み込みスキル";
/** 再読み込みは共通 + 組み込みを同時に取り直すので、読み上げ名でも両方を挙げる */
export const FILE_SKILL_RELOAD_LABEL = "再読み込み";
export const FILE_SKILL_RELOAD_ARIA_LABEL = "共通スキルと組み込みスキルを再読み込み";
export const FILE_SKILL_SCOPE_LABEL: Record<FileSkillInfo["scope"], string> = {
  user: "共通",
  project: "プロジェクト",
  builtin: "組み込み",
};
export const FILE_SKILL_EMPTY_NOTE = "共通スキルはまだありません。";
export const BUILTIN_SKILL_EMPTY_NOTE = "組み込みスキルはありません。";
export const FILE_SKILL_ERROR_PREFIX = "スキルを取得できませんでした";
export const FILE_SKILL_LOADING_NOTE = "スキルを読み込んでいます…";
export const BUILTIN_SKILL_OVERRIDE_NOTE = "上書きされています（同名の共通スキルが優先されます）";
export const BUILTIN_SKILL_READONLY_NOTE = "アプリに同梱されているため、編集・削除はできません。";
export const FILE_SKILL_READONLY_NOTE =
  "ワークスペースのファイルがそのまま使われます。編集は「ファイル」画面から行ってください。";
/** 本文ビューの見出し。一覧のグループ名 (共通 / プロジェクト / 組み込み) と同じ語を使う */
export const FILE_SKILL_PANEL_HEADING: Record<FileSkillInfo["scope"], string> = {
  user: "共通スキル",
  project: "プロジェクトスキル",
  builtin: "組み込みスキル",
};
/** 本文の取得中 / 失敗の表示。組み込みは一覧の応答に本文が載るため、ファイルスキルだけが通る */
export const FILE_SKILL_BODY_LOADING_NOTE = "本文を読み込んでいます…";
export const FILE_SKILL_BODY_ERROR_PREFIX = "本文を取得できませんでした";

/**
 * ファイルタブの root にできるスキルディレクトリ (root 相対)。組み込みは実体の無い仮想パス、root の外は
 * 絶対パスで返るため、どちらもここで落とす。判定は normalizeFileTreeRoot より前に行う (絶対パスは
 * "." へ畳まれ、ワークスペース root を見せてしまう)。
 */
export function fileSkillDir(skill: Pick<FileSkillInfo, "scope" | "relativePath">): string | null {
  if (skill.scope === "builtin") return null;
  const path = skill.relativePath;
  // バックスラッシュは区切りとして扱わない (Windows の絶対パスを root 相対と誤認しない)
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
  const segments = path.split("/");
  // 親参照はツリーの root を外へ動かす (release..notes のような名前は巻き込まない)
  if (segments.some((segment) => segment === ".." || segment === "")) return null;
  if (segments.length < 2 || segments[segments.length - 1] !== "SKILL.md") return null;
  return segments.slice(0, -1).join("/");
}

/** 一覧のグループ分け。組み込みは別グループで表示する (読み取り専用で、上書き状態を持つ) */
export function groupFileSkills(skills: FileSkillInfo[]): { common: FileSkillInfo[]; builtin: FileSkillInfo[] } {
  const common: FileSkillInfo[] = [];
  const builtin: FileSkillInfo[] = [];
  for (const skill of skills) {
    if (skill.scope === "builtin") builtin.push(skill);
    else common.push(skill);
  }
  return { common, builtin };
}

/**
 * 行に出す注意書き。共通 / プロジェクトの重複は「どちらが有効か」、組み込みは「上書きされている」を示す
 * (組み込み側には shadowed ではなく overridden が立つ)。注意が無ければ null。
 */
export function fileSkillWarning(skill: FileSkillInfo): string | null {
  if (skill.scope === "builtin") return skill.overridden ? BUILTIN_SKILL_OVERRIDE_NOTE : null;
  if (skill.shadowed.length === 0) return null;
  const shadowed = skill.shadowed.map((item) => item.relativePath).join(", ");
  return `同名のスキルが ${skill.shadowed.length + 1} 件あります。有効: ${skill.relativePath} / 読み込まれない: ${shadowed}`;
}
