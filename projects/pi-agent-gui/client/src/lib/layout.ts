/** レイアウトモードの判定。
 *
 * 幅だけの判定だと横向きスマホ (例: 844x390) が幅 720px を超えて desktop 扱いになり、
 * 高さを失った 2 カラムでチャット領域が潰れる。そこで desktop shell には
 * 幅と高さの両方を要求し、足りない側に応じて portrait / landscape を選ぶ。
 */

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
