/**
 * 入力欄の主ボタン (送信 ↑ / 停止 ■) の出し分け。実行中は「送れるものがあるか」で決める:
 * 送るものがあれば ↑ を主に残し、停止は控えの ■ として隣へ出す。無ければ ■ が主スロットへ入る。
 * 停止は待機キューも破棄する破壊操作なので、下書きを書いている間も押せる位置へ残す
 * (ChatGPT は送信が現れると停止を消すが、そこで積むのは中断ではなく待機なので意味が違う)。
 *
 * 実行中以外の理由で送信が止まっているとき (回答待ち / モデル未設定) は主スロットへ上げない。
 * 差し替えた主役の隣に出る理由 (「上の質問に回答してください」) と破壊操作が並ぶと、誘導が逆になるため。
 */

/** 主スロットに出す操作。`send` = ↑ だけ / `stop` = ■ だけ / `sendAndStop` = ■ (控え) + ↑ */
export type ComposerAction = "send" | "stop" | "sendAndStop";

export type ComposerActionInput = {
  /** 実行中 / 圧縮中 / 待機キューあり (停止できる状態か) */
  stopVisible: boolean;
  /** 本文 / 添付 / 定型チップのいずれかがあり、送れる状態か */
  sendable: boolean;
  /** 実行中以外の理由で送信が止まっているか (回答待ちの質問 / モデル未設定) */
  sendBlocked: boolean;
};

export function composerAction({ stopVisible, sendable, sendBlocked }: ComposerActionInput): ComposerAction {
  if (!stopVisible) return "send";
  if (sendable || sendBlocked) return "sendAndStop";
  return "stop";
}
