/** 送信後の入力欄のフォーカス。判定の理由と端末差は docs/ui-layout.md を参照。 */

/** タッチ入力ではソフトキーボードを閉じるため外し、それ以外は入力欄へ戻す */
export function composerFocusAfterSend(coarsePointer: boolean): "focus" | "blur" {
  return coarsePointer ? "blur" : "focus";
}

/** 今の一次ポインタが粗いか。送信のたびに読む */
export function hasCoarsePointer(read: (query: string) => boolean = defaultRead): boolean {
  return read("(pointer: coarse)");
}

function defaultRead(query: string): boolean {
  return window.matchMedia(query).matches;
}
