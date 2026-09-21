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
