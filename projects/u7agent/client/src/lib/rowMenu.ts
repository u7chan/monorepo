/**
 * 行の ⋯ メニューの共通部。項目の型と、メニューの位置 / キーボード移動の計算だけを持つ純関数を集める
 * (描画と popover の操作は `client/src/components/RowMenu.tsx`、画面ごとの出し分けは
 * `client/src/lib/fileRowMenu.ts` / `client/src/lib/sidebarRowMenu.ts`)。
 */

/** 画面ごとに出せる種別が違うため、メニュー項目の型は種別を型引数に取る (出し分け側が種別を狭める) */
export type RowMenuActionKind = "download" | "rename" | "pin" | "move" | "delete" | "new-chat";

export type RowMenuAction<K extends RowMenuActionKind = RowMenuActionKind> = {
  kind: K;
  label: string;
  /** 2 行目。押す前に開示したい条件がある操作だけ持つ */
  description?: string;
  danger?: boolean;
};

export type RowMenuRect = Pick<DOMRect, "top" | "left" | "right" | "bottom">;

/** メニューの入れ物と ⋯ の間隔 / viewport の端からの余白 (px) */
export const ROW_MENU_GAP = 4;
export const ROW_MENU_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * メニューの `fixed` 座標。既定は ⋯ の右下 (右端をそろえる) に置き、右端 / 下端で収まらないときは
 * 左 / 上へ倒して viewport の内側へ clamp する (メニューが viewport より大きい場合は上 / 左に寄せる)。
 */
export function rowMenuPlacement(
  anchor: RowMenuRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  let left = anchor.right - menu.width;
  if (left < ROW_MENU_MARGIN) left = anchor.left;
  left = clamp(left, ROW_MENU_MARGIN, viewport.width - menu.width - ROW_MENU_MARGIN);

  const below = anchor.bottom + ROW_MENU_GAP;
  const above = anchor.top - ROW_MENU_GAP - menu.height;
  const top = below + menu.height > viewport.height - ROW_MENU_MARGIN && above >= ROW_MENU_MARGIN ? above : below;
  return { left, top: clamp(top, ROW_MENU_MARGIN, viewport.height - menu.height - ROW_MENU_MARGIN) };
}

/** ⋯ が clip (ツリーのスクロール枠 / viewport) の内側に完全に見えているか */
export function rowMenuAnchorVisible(anchor: RowMenuRect, clips: readonly RowMenuRect[]): boolean {
  return clips.every(
    (clip) =>
      anchor.top >= clip.top && anchor.bottom <= clip.bottom && anchor.left >= clip.left && anchor.right <= clip.right,
  );
}

/** ↑↓ の移動先。端では止まる (循環しない)。`index` が -1 (フォーカスが項目の外) のときは端の項目へ入る */
export function nextRowMenuIndex(index: number, length: number, direction: "next" | "previous"): number {
  if (length <= 0) return -1;
  if (index < 0) return direction === "next" ? 0 : length - 1;
  return direction === "next" ? Math.min(index + 1, length - 1) : Math.max(index - 1, 0);
}
