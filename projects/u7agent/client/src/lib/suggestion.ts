/** 定型プロンプト (エージェント定義の suggestions) のチップ。送信本文の組み立てと、外す操作の判定だけを持ち、
 * 文面の正はエージェント定義に残す (prompt の中身を UI で見せない決定に合わせる)。 */
import { isImeComposingEnter } from "./composerKeys";

/** チップを外すかの判定材料。keydown と textarea の選択範囲から読む分だけ */
export type SuggestionKeyState = {
  key: string;
  /** event.nativeEvent.isComposing */
  isComposing: boolean;
  /** event.nativeEvent.keyCode。compositionend が keydown より先に来る実装の保険で見る */
  keyCode: number;
  selectionStart: number | null;
  selectionEnd: number | null;
};

/**
 * 送信本文を 1 通へ組み立てる。本文の前後の空白はここで落とし、本文が空なら prompt だけを送る。
 * 順序はチップと本文の見た目と同じ (prompt → 空行 → 本文) にして、順序の規約を持たない。
 */
export function suggestionSendText(prompt: string, text: string): string {
  const body = text.trim();
  if (body === "") return prompt;
  return prompt === "" ? body : `${prompt}\n\n${body}`;
}

/**
 * 本文の先頭 (位置 0・選択なし) の backspace でチップを外すか。位置 0 以外と全選択はテキストの削除に残す
 * (チップは本文の左に接する要素なので、左上で削り始めたときだけをチップの操作として引き取る)。
 */
export function shouldClearSuggestionOnBackspace(state: SuggestionKeyState): boolean {
  // IME の変換中の削除を奪わない
  if (state.key !== "Backspace" || isImeComposingEnter(state)) return false;
  return state.selectionStart === 0 && state.selectionEnd === 0;
}
