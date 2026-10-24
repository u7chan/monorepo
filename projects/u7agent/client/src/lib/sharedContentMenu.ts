import { rowMenuAnchorVisible, rowMenuPlacement, type RowMenuRect } from "./rowMenu";

/**
 * 共有物カードの ⋯ の位置。アンカーが viewport と一覧のスクロール枠の両方に見えているときだけ座標を返す。
 * 一覧の更新でカードが枠の外へ動いたときは null にしてメニューを閉じる (見えていない共有物の操作を残さない)。
 */
export function sharedContentMenuPosition(
  anchor: RowMenuRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  clips: readonly RowMenuRect[],
): { left: number; top: number } | null {
  if (!rowMenuAnchorVisible(anchor, clips)) return null;
  return rowMenuPlacement(anchor, menu, viewport);
}
