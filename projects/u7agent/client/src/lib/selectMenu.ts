/**
 * 設定画面のプルダウン（自前 listbox）の、位置とキーボード移動の計算。
 * 位置は composer と同じ `popoverPlacement` を使い、向きだけ下優先にする（設定の欄は画面の中ほどにあるため）。
 */
import { POPOVER_GAP, POPOVER_MARGIN } from "./popoverPlacement";

/** 下に開く余地がこれ未満のときだけ、上へ倒すかを考える (px) */
export const SELECT_MENU_MIN_BELOW = 120;

export type SelectMenuAnchor = Pick<DOMRect, "top" | "bottom">;

/** 開く向きと、その向きで使える高さの上限。どちらも狭いときは下のまま、一覧の中でスクロールさせる */
export function selectMenuPlacement(
  anchor: SelectMenuAnchor,
  viewportHeight: number,
): { above: boolean; maxHeight: number } {
  const aboveSpace = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  const belowSpace = viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = belowSpace < SELECT_MENU_MIN_BELOW && aboveSpace > belowSpace;
  return { above, maxHeight: Math.max(0, above ? aboveSpace : belowSpace) };
}

/** ↑↓ / Home / End の移動先。端では止まる（循環しない）。`-1`（フォーカスが行の外）からは端へ入る */
export function nextSelectMenuIndex(
  index: number,
  length: number,
  direction: "next" | "previous" | "first" | "last",
): number {
  if (length <= 0) return -1;
  if (direction === "first") return 0;
  if (direction === "last") return length - 1;
  if (index < 0) return direction === "next" ? 0 : length - 1;
  return direction === "next" ? Math.min(index + 1, length - 1) : Math.max(index - 1, 0);
}

/** 開いたときにフォーカスする行。選択中の行が無ければ先頭 */
export function initialSelectMenuIndex(value: string, values: string[]): number {
  const index = values.indexOf(value);
  return index === -1 ? 0 : index;
}
