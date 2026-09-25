/** レイアウトモードの判定。閾値の理由は docs/ui-layout.md を参照。 */

export const DESKTOP_MIN_WIDTH = 720;
export const DESKTOP_MIN_HEIGHT = 560;
/** 左バー (Sidebar) の幅。App の grid クラス `grid-cols-[252px_minmax(0,1fr)]` と同じ値にする */
export const SIDEBAR_WIDTH = 252;
/**
 * 左バーを overlay へ退避する幅。右パネルの幅 `min(360px, 30vw)` が縮み始める幅 (30vw = 360px) と
 * 同じ数字で、「狭くなるとパネルもチャットも苦しい帯」の入口を表す
 */
export const SIDEBAR_OVERLAY_WIDTH = 1200;

export type LayoutMode = "desktop" | "portrait" | "landscape";

export type SidebarPlacement = "docked" | "overlay";

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

/**
 * 左バーの置き方。compact (portrait / landscape) は従来どおり常に overlay で、
 * 開く導線は CompactBar の ☰。desktop は 252px をコンテンツへ回すため width < 1200 で overlay にする。
 */
export function resolveSidebarPlacement(width: number, mode: LayoutMode): SidebarPlacement {
  if (mode !== "desktop") return "overlay";
  return width < SIDEBAR_OVERLAY_WIDTH ? "overlay" : "docked";
}
