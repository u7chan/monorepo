/** 定型プロンプト (エージェント定義の suggestions) のチップ。送信本文の組み立てと、外す操作の判定だけを持ち、
 * 文面の正はエージェント定義に残す (prompt の中身を UI で見せない決定に合わせる)。 */
import { isImeComposing } from "./composerKeys";

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

/** チップを持つ下書きの範囲 */
export type SuggestionScope = {
  agentId: string | undefined;
  /** newChat / 別の会話を開くで進む世代。添付の暗黙の会話作成では進まない */
  selectionSeq: number;
  /** 会話 id。未作成チャットは "" で、添付が会話を作った時点で新しい id になる */
  sessionId: string;
};

export type SuggestionScopeChange = "keep" | "drop";

/**
 * チップの範囲が変わったか。
 * - エージェント切替 / 利用者が会話を選び直した (世代が進んだ): 捨てる
 * - 未作成チャットの添付が会話を暗黙に作った (世代は同じで "" から新しい id): 同じ下書きの続きとして残す
 * - それ以外の会話 id の移りは、下書きを持ち越さない側に倒して捨てる
 */
export function suggestionScopeChange(prev: SuggestionScope, next: SuggestionScope): SuggestionScopeChange {
  if (prev.agentId !== next.agentId) return "drop";
  if (prev.selectionSeq !== next.selectionSeq) return "drop";
  if (prev.sessionId === next.sessionId) return "keep";
  return prev.sessionId === "" ? "keep" : "drop";
}

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
 * タイトル用に送る本文。チップ (定型プロンプト) を結合する前の入力を trim するだけで、
 * 送信本文の組み立て (suggestionSendText) とは別に持つ (タイトルから固定文を外すため)。
 * 空なら undefined を返し、サーバーに従来の判定 (本文全体) をさせる。
 */
export function suggestionTitleSource(text: string): string | undefined {
  const body = text.trim();
  return body === "" ? undefined : body;
}

/**
 * 本文の先頭 (位置 0・選択なし) の backspace でチップを外すか。位置 0 以外と全選択はテキストの削除に残す
 * (チップは本文の左に接する要素なので、左上で削り始めたときだけをチップの操作として引き取る)。
 */
export function shouldClearSuggestionOnBackspace(state: SuggestionKeyState): boolean {
  // IME の変換中の削除を奪わない (key を見ない判定を使い、Enter 側の変更に巻き込まれないようにする)
  if (state.key !== "Backspace" || isImeComposing(state)) return false;
  return state.selectionStart === 0 && state.selectionEnd === 0;
}
