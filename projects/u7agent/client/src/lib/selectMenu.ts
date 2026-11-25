/**
 * 設定画面のプルダウン（自前 listbox）の、位置・幅とフォーカスの決め方。
 * 位置は composer と同じ `popoverPlacement` を使い、向きだけ下優先にする（設定の欄は画面の中ほどにあるため）。
 */
import { POPOVER_GAP, POPOVER_MARGIN, popoverWidth } from "./popoverPlacement";

/** 下に開く余地がこれ未満のときだけ、上へ倒すかを考える (px) */
export const SELECT_MENU_MIN_BELOW = 120;

/** 一覧の幅の下限。説明の 1 行が読める幅を確保する */
export const SELECT_MENU_MIN_WIDTH = 260;

/** 一覧の幅。欄より狭くせず、狭い viewport では左右の余白を残して縮める */
export function selectMenuWidth(anchorWidth: number, viewportWidth: number): number {
  return popoverWidth(Math.max(anchorWidth, SELECT_MENU_MIN_WIDTH), viewportWidth);
}

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

/** 開いたときにフォーカスする行。選択中の行が無ければ先頭 */
export function initialSelectMenuIndex(value: string, values: readonly string[]): number {
  const index = values.indexOf(value);
  return index === -1 ? 0 : index;
}

/**
 * 検索欄の ↑↓ で入る行。↓ は選択中の行 (無ければ先頭)、↑ は末尾へ入る。
 * 一覧が空なら -1 を返し、呼び出し側は焦点を移さない。
 */
export function selectMenuArrowIndex(
  key: "ArrowDown" | "ArrowUp",
  value: string,
  values: readonly string[],
  itemCount: number,
): number {
  const index = key === "ArrowDown" ? initialSelectMenuIndex(value, values) : itemCount - 1;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export type SelectMenuFilterable = {
  label: string;
  detail?: string | undefined;
  description?: string | undefined;
  group?: string | undefined;
};

/**
 * 検索語での絞り込み。行に見えている語（見出し・主表示・副表示・説明）のどれかに含めば残す。
 * 見出しも対象にするのは、見出しの語を前置きしない行（ベンダー名を省いた行）を名前で引けるようにするため。
 */
export function filterSelectMenuOptions<T extends SelectMenuFilterable>(options: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter((option) =>
    [option.label, option.detail ?? "", option.description ?? "", option.group ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}
