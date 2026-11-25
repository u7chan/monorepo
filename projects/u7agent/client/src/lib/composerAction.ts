/**
 * 入力欄の主ボタン (送信 ↑ / 停止 ■) の出し分け。送れるものがあるときは ↑ を主に残し、■ は控えにする。
 * 例外 (主スロットへ上げない条件) と保留時間の根拠は docs/ui-layout.md を正とする。
 * 録音の状態 (`./voiceInput/composer.ts`) だけは、音声の操作を終えるまで主スロットを占有する。
 */

/** 入力欄の主スロットに出す操作。`send` = ↑ だけ / `stop` = ■ だけ / `sendAndStop` = ■ (控え) + ↑ */
export type ComposerAction =
  | "send"
  | "stop"
  | "sendAndStop"
  /** マイク許可待ち・接続中。主 = 取消 */
  | "voiceCancel"
  /** 録音中。主 = 録音停止 ● */
  | "voiceStop"
  /** 確定待ち。主 = 送信不可 (スピナー) */
  | "voiceFinalizing";

export type ComposerActionInput = {
  /** 実行中 / 圧縮中 / 待機キューあり (停止できる状態か) */
  stopVisible: boolean;
  /** 本文 / 添付 / 定型チップのいずれかがあり、送れる状態か */
  sendable: boolean;
  /** 実行中以外の理由で送信が止まっているか (回答待ち / モデル未設定 / 添付のアップロード中) */
  sendBlocked: boolean;
  /** 送信直後の保留中か (入れ替えた位置を続けて押すと、実行と待機キューが落ちる) */
  stopPrimaryHeld: boolean;
  /** 音声入力の状態。`idle` (音声が待機) のときだけ上の 4 つの規則を使う */
  voicePhase?: "idle" | "connecting" | "recording" | "finalizing";
};

export function composerAction({
  stopVisible,
  sendable,
  sendBlocked,
  stopPrimaryHeld,
  voicePhase = "idle",
}: ComposerActionInput): ComposerAction {
  // 音声が待機の間も本文の規則を使う (録音のために run と待機キューの停止導線を落とさない)
  if (voicePhase === "connecting") return "voiceCancel";
  if (voicePhase === "recording") return "voiceStop";
  if (voicePhase === "finalizing") return "voiceFinalizing";
  if (!stopVisible) return "send";
  if (sendable || sendBlocked || stopPrimaryHeld) return "sendAndStop";
  return "stop";
}

/**
 * 既存の停止 ■ を副スロットへ出すか。音声の操作中も、run / 圧縮 / 待機キューが残っている間は
 * 押せる位置へ残す (主スロットは音声が使い、run を止めたいときの逃げ道を消さない)。
 */
export function composerSecondaryStop(action: ComposerAction): boolean {
  return action === "sendAndStop" || action === "voiceCancel" || action === "voiceStop" || action === "voiceFinalizing";
}

/** 主スロットが ■ (実行の停止) か。録音停止 ● と取り違えないよう、印を分けて持つ */
export function composerPrimaryStop(action: ComposerAction): boolean {
  return action === "stop";
}
