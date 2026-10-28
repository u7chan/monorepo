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
 * 定義の一覧と詳細を並べる最小幅。CSS の `--breakpoint-wide` (`client/src/styles/index.css`) と同じ値で、
 * これ未満の desktop と singleColumn はページ内の一覧 ⇄ 詳細にする (同じ数字を 2 箇所に持つので、
 * 片方を変えたらもう片方も変える。`docs-check` では検出できない)。viewport で判定してよいのは、
 * 1200px 未満では左バーが overlay になり viewport ≒ 内容幅になるため (SIDEBAR_OVERLAY_WIDTH の上の説明と同じ帯)。
 */
export const WIDE_MIN_WIDTH = 900;

/** 一覧と詳細を並べてよい幅か。CSS の `wide:` と対で使う */
export function resolveWide(width: number): boolean {
  return width >= WIDE_MIN_WIDTH;
}

/**
 * 実行状況 ( `/activity` ) を docked にする幅。Issue の「901px 以上は docked / 641–900px は
 * モバイルヘッダ」に合わせ、既存の `WIDE_MIN_WIDTH` (900px 以上で wide) より 1px 広い境界を持つ。
 * チャットの 1200px 判定 (`resolveSidebarPlacement`) は変えない。
 */
export const ACTIVITY_DOCKED_MIN_WIDTH = WIDE_MIN_WIDTH + 1;

/**
 * 実行状況の左バーの置き方。singleColumn は常に overlay で、desktop でも 901px 未満は overlay
 * (641–900px はモバイルヘッダを出す)。overlay のときは 44px のタップ領域を当てる。
 */
export function resolveActivitySidebarPlacement(width: number, mode: LayoutMode): SidebarPlacement {
  if (mode !== "desktop") return "overlay";
  return width >= ACTIVITY_DOCKED_MIN_WIDTH ? "docked" : "overlay";
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
