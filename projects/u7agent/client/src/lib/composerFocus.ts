/**
 * 送信後の入力欄のフォーカス。タッチ端末ではフォーカスを戻すとソフトキーボードが閉じないため、
 * 送信の時点のポインタで決める。設計と端末差は docs/ui-layout.md を参照。
 */

/**
 * タッチ入力では外してキーボードを閉じ、マウス / トラックパッドでは戻す (送信ボタンのクリックで
 * フォーカスがボタンへ移るため、戻さないと次の入力を書き始められない)。判定にモードを使わないのは、
 * compact でもマウスの狭いウィンドウがあるため。
 */
export function composerFocusAfterSend(coarsePointer: boolean): "focus" | "blur" {
  return coarsePointer ? "blur" : "focus";
}

/**
 * 今の一次ポインタが粗いか。送信のたびに読み直すので、ハイブリッド端末でポインタが変わっても追従し、
 * 購読の state を持たない。読み取りはテストで差し替える。
 */
export function hasCoarsePointer(read: (query: string) => boolean = defaultRead): boolean {
  // `any-pointer: coarse` は見ない。マウス併用のタッチ PC まで粗い扱いになり、マウス操作の連投で
  // フォーカスが落ちるため (docs/ui-layout.md)
  return read("(pointer: coarse)");
}

function defaultRead(query: string): boolean {
  return window.matchMedia(query).matches;
}
