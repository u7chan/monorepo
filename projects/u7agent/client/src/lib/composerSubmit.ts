/**
 * 入力欄の送信 1 回分。Enter・フォーム submit・送信ボタンはすべてここを通る。
 * 音声の操作中と終了直後の保留中は入口で止め、下書きも定型チップも消さない
 * （ボタンの `disabled` だけに頼ると、別の入口から押せないはずの送信が通る）。
 */
import { suggestionSendText, suggestionTitleSource } from "./suggestion";
import { voiceInputComposerBusy, type VoiceInputComposerPhase } from "./voiceInput/composer";

export type ComposerSubmitInput = {
  /** 入力欄の本文 */
  value: string;
  /** 選択中の定型プロンプト（本文へ結合する） */
  suggestionPrompt: string;
  hasAttachment: boolean;
  runtimeReady: boolean;
  sending: boolean;
  settingsChanging: boolean;
  /** 実行中以外の理由で送れないときの理由 */
  sendBlockedReason?: string;
  attachmentsBusy: boolean;
  /** 音声の操作中の phase（待機は `idle`） */
  voicePhase: VoiceInputComposerPhase;
  /** 録音の終了直後の保留中（主スロットの入れ替えを遅らせている間） */
  voiceHold: boolean;
};

export type ComposerSubmitHandlers = {
  /** 本文を空にする（送信が決まってから呼ぶ） */
  clearDraft: () => void;
  /** 主スロットの入れ替えを保留する */
  holdStopPromotion: () => void;
  /** 定型チップを外す */
  clearSuggestion: () => void;
  /** 結合後の本文と、定型プロンプトを結合する前の本文 */
  send: (text: string, titleSource: string | undefined) => void;
};

/**
 * 送れたら true。止めたときは false を返し、本文もチップも触らない（下書きを消してから捨てない）。
 */
export function submitComposer(input: ComposerSubmitInput, handlers: ComposerSubmitHandlers): boolean {
  // 録音中・接続中・確定待ち・終了直後の保留中は送らない。Enter / submit / 送信ボタンが同じ経路へ
  // 合流するので、入口のここで止める
  if (voiceInputComposerBusy(input.voicePhase) || input.voiceHold) return false;
  // 設定変更中は送信を待たせる (サーバー側でも 409)。チップ / 添付だけの送信は許可する
  if (input.attachmentsBusy) return false;
  const text = suggestionSendText(input.suggestionPrompt, input.value);
  if (
    (!text && !input.hasAttachment) ||
    !input.runtimeReady ||
    input.sending ||
    input.settingsChanging ||
    input.sendBlockedReason
  ) {
    return false;
  }
  handlers.clearDraft();
  handlers.holdStopPromotion();
  handlers.clearSuggestion();
  // 結合後の本文だけを渡すとタイトルが定型プロンプトの先頭で埋まるため、個別の依頼を別に渡す
  handlers.send(text, suggestionTitleSource(input.value));
  return true;
}
