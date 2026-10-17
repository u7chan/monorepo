/**
 * 入力欄の主ボタン (送信 ↑ / 停止 ■) の出し分け。送れるものがあるときは ↑ を主に残し、■ は控えにする。
 * 例外 (主スロットへ上げない条件) と保留時間の根拠は docs/ui-layout.md を正とする。
 */

/** 主スロットに出す操作。`send` = ↑ だけ / `stop` = ■ だけ / `sendAndStop` = ■ (控え) + ↑ */
export type ComposerAction = "send" | "stop" | "sendAndStop";

export type ComposerActionInput = {
  /** 実行中 / 圧縮中 / 待機キューあり (停止できる状態か) */
  stopVisible: boolean;
  /** 本文 / 添付 / 定型チップのいずれかがあり、送れる状態か */
  sendable: boolean;
  /** 実行中以外の理由で送信が止まっているか (回答待ち / モデル未設定 / 添付のアップロード中) */
  sendBlocked: boolean;
  /** 送信直後の保留中か (入れ替えた位置を続けて押すと、実行と待機キューが落ちる) */
  stopPrimaryHeld: boolean;
};

export function composerAction({
  stopVisible,
  sendable,
  sendBlocked,
  stopPrimaryHeld,
}: ComposerActionInput): ComposerAction {
  if (!stopVisible) return "send";
  if (sendable || sendBlocked || stopPrimaryHeld) return "sendAndStop";
  return "stop";
}
