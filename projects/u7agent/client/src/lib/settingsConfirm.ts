/**
 * 設定 → エージェント / スキルの編集で出す確認。削除と下書きの破棄は元に戻せないため、
 * 見出しとボタンで何をするかを示す（純関数に閉じ、client test で固定する）。
 */
import type { ConfirmRequest } from "./confirmDialog";

/** エージェント削除の確認。名前は clamp した独立した行へ出す */
export function agentDeleteConfirmRequest(name: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "エージェントを削除",
    ...(name ? { subject: { label: "削除するエージェント", value: name } } : {}),
    confirmLabel: "削除する",
    danger: true,
  };
}

/** 編集の破棄の確認。保存していない変更が戻せないことを示す */
export function skillDiscardConfirmRequest(): ConfirmRequest {
  return {
    kind: "confirm",
    title: "編集を破棄",
    body: ["保存していない変更は元に戻せません。"],
    confirmLabel: "破棄する",
    danger: true,
  };
}

/** 確認に列挙する付随ファイルの上限 (件数は本文で必ず示す) */
export const FILE_SKILL_DELETE_FILES_MAX = 8;

/**
 * 共通スキル (`.agents/skills`) の削除の確認。専用フォルダごと消え、付随ファイルも戻せないことを、
 * 確認の段階で得た一覧 (delete-preview) で示す。
 */
export function fileSkillDeleteConfirmRequest(input: {
  name: string;
  dir: string;
  files: readonly string[];
  entries: number;
}): ConfirmRequest {
  const shown = input.files.slice(0, FILE_SKILL_DELETE_FILES_MAX);
  const hidden = input.entries - shown.length;
  return {
    kind: "confirm",
    title: "スキルを削除",
    ...(input.name ? { subject: { label: "削除するスキル", value: input.name } } : {}),
    code: { label: "削除するフォルダ", value: input.dir },
    body: [
      `フォルダと ${input.entries} 件のファイルを削除します。元に戻せません。`,
      shown.length > 0 ? `含まれるもの: ${shown.join(", ")}${hidden > 0 ? ` ほか ${hidden} 件` : ""}` : "",
    ].filter((line) => line.length > 0),
    confirmLabel: "削除する",
    danger: true,
  };
}
