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

/**
 * IME の変換中か。`compositionend` が keydown より先に届くと `isComposing` が false のまま確定のキーが
 * 来る実装があるため keyCode 229 も見る。key を見ないので、キーごとの判定 (Enter / Backspace) から呼べる。
 */
export function isImeComposing(state: Pick<EnterKeyState, "isComposing" | "keyCode">): boolean {
  return state.isComposing || state.keyCode === 229;
}

/**
 * IME の変換確定 Enter か。送信 / 「次へ」に使ってはいけない Enter (docs/ui-layout.md の入力欄の契約)。
 * Enter を確定に使う UI が増えたらこの判定を通す (片方だけ直すと変換の確定で送ってしまう)。
 */
export function isImeComposingEnter(state: Pick<EnterKeyState, "isComposing" | "keyCode">): boolean {
  return isImeComposing(state);
}

/** 通常の Enter で送信するか。true のときだけ呼び出し側が preventDefault して送信する */
export function shouldSubmitOnEnter(state: EnterKeyState, mode: LayoutMode): boolean {
  // singleColumn は Enter を改行に残す (タッチ入力では Shift+Enter を前提にできない)。送信は送信ボタンだけ
  if (mode !== "desktop") return false;
  if (state.key !== "Enter" || state.shiftKey) return false;
  return !isImeComposingEnter(state);
}
