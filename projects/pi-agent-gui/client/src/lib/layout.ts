/** レイアウトモードの判定。閾値の理由は docs/ui-layout.md を参照。 */

/** desktop shell (252px sidebar + main) を出す下限 */
export const DESKTOP_MIN_WIDTH = 720;
export const DESKTOP_MIN_HEIGHT = 560;

export type LayoutMode = "desktop" | "portrait" | "landscape";

/**
 * - desktop: 幅と高さの両方が足りるとき。既存の 2 カラム
 * - landscape: 高さが足りないとき。横向きスマホのほか、低いウィンドウも含む
 * - portrait: 幅が足りないとき (縦向きスマホ)
 */
export function resolveLayoutMode(width: number, height: number): LayoutMode {
  if (width >= DESKTOP_MIN_WIDTH && height >= DESKTOP_MIN_HEIGHT) return "desktop";
  if (height < DESKTOP_MIN_HEIGHT) return "landscape";
  return "portrait";
}
