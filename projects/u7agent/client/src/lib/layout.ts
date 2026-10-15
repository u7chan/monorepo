/** レイアウトモードの判定。閾値の理由は docs/ui-layout.md を参照。 */

export const DESKTOP_MIN_WIDTH = 720;
export const DESKTOP_MIN_HEIGHT = 560;
/**
 * 左バー (Sidebar) の既定幅。docked の grid は CSS 変数 `--sidebar-width` を使うので、
 * 実際の表示幅は利用者が選んだ値 (bounds の下限 = この値。lib/sidebarWidth.ts) になる
 */
export const SIDEBAR_WIDTH = 252;
/**
 * 左バーを overlay へ退避する幅。右パネルの幅 `min(360px, 30vw)` が縮み始める幅 (30vw = 360px) と
 * 同じ数字で、「狭くなるとパネルもチャットも苦しい帯」の入口を表す
 */
export const SIDEBAR_OVERLAY_WIDTH = 1200;

/**
 * 定義の一覧と編集面を並べる最小幅。CSS の `--breakpoint-wide` (`client/src/styles/index.css`) と同じ値で、
 * 狭い desktop では一覧ページ + 全画面シートにする (同じ数字を 2 箇所に持つので、片方を変えたらもう片方も変える。
 * `docs-check` では検出できない)。viewport で判定してよいのは、1200px 未満では左バーが overlay になり
 * viewport ≒ 内容幅になるため (SIDEBAR_OVERLAY_WIDTH の上の説明と同じ帯)。
 */
export const WIDE_MIN_WIDTH = 900;

/** 一覧と編集面を並べてよい幅か。CSS の `wide:` と対で使う */
export function resolveWide(width: number): boolean {
  return width >= WIDE_MIN_WIDTH;
}

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
 * 左バーの置き方。singleColumn (portrait / landscape) は従来どおり常に overlay で、
 * 開く導線は SingleColumnBar の ☰。desktop は左バーを畳んで main へ回すため width < 1200 で overlay にする
 * (幅は選べるようになったが、狭い窓では main が足りないので閾値は据え置き。docs/ui-layout.md)。
 */
export function resolveSidebarPlacement(width: number, mode: LayoutMode): SidebarPlacement {
  if (mode !== "desktop") return "overlay";
  return width < SIDEBAR_OVERLAY_WIDTH ? "overlay" : "docked";
}
