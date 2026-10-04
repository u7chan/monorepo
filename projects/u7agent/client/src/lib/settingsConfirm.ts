/**
 * 設定 → エージェント / スキルの編集で出す確認。カタログの削除と下書きの破棄は元に戻せないため、
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

/** スキル削除の確認。割り当て中のエージェントからも外れることを先に伝える */
export function skillDeleteConfirmRequest(name: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "スキルを削除",
    ...(name ? { subject: { label: "削除するスキル", value: name } } : {}),
    body: ["割り当て中のエージェントからも外れます。"],
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
