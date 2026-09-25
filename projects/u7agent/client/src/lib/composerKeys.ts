/** 入力欄の Enter の分け方 (送信 / 改行) と、その理由は docs/ui-layout.md を参照。 */
import type { LayoutMode } from "./layout";

/** keydown から読む分だけ (React の合成イベントでも native でも渡せる) */
export type EnterKeyState = {
  key: string;
  shiftKey: boolean;
  /** event.nativeEvent.isComposing */
  isComposing: boolean;
  /** event.nativeEvent.keyCode。compositionend が keydown より先に来る実装の保険で見る */
  keyCode: number;
};

/** 通常の Enter で送信するか。true のときだけ呼び出し側が preventDefault して送信する */
export function shouldSubmitOnEnter(state: EnterKeyState, mode: LayoutMode): boolean {
  // compact は Enter を改行に残す (タッチ入力では Shift+Enter を前提にできない)。送信は送信ボタンだけ
  if (mode !== "desktop") return false;
  if (state.key !== "Enter" || state.shiftKey) return false;
  // IME の変換確定 Enter。keyCode 229 は isComposing が false で届く実装がある
  return !state.isComposing && state.keyCode !== 229;
}
