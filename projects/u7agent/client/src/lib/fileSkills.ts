/**
 * 共通スキル (`.agents/skills`) の表示用の導出。重複警告の文言をここ 1 箇所へ閉じ、
 * コンポーネントは結果を描画するだけにする (docs/api-catalog.md)。
 */
import type { FileSkillInfo } from "../types";

export const FILE_SKILL_GROUP_LABEL = "共通スキル（読み取り専用）";
export const FILE_SKILL_SCOPE_LABEL: Record<FileSkillInfo["scope"], string> = {
  user: "共通",
  project: "プロジェクト",
};
export const FILE_SKILL_EMPTY_NOTE = "共通スキルはまだありません。";
export const FILE_SKILL_ERROR_PREFIX = "共通スキルを取得できませんでした";
export const FILE_SKILL_LOADING_NOTE = "共通スキルを読み込んでいます…";

/**
 * 同名スキルの重複警告。行に出ている側が有効なので、影になったファイルを並べて「どちらが有効か」を示す。
 * 重複が無ければ null (警告を出さない)。
 */
export function fileSkillDuplicateWarning(skill: FileSkillInfo): string | null {
  if (skill.shadowed.length === 0) return null;
  const shadowed = skill.shadowed.map((item) => item.relativePath).join(", ");
  return `同名のスキルが ${skill.shadowed.length + 1} 件あります。有効: ${skill.relativePath} / 読み込まれない: ${shadowed}`;
}
