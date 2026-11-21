// 外観 (ライト / ダーク) の設定。既定は端末の設定に従う "system" で、
// アプリ内で上書きしたときだけ localStorage に残す。

export type ThemePreference = "system" | "light" | "dark";
export type ThemeScheme = "light" | "dark";

/** index.html の描画前スクリプトも同じキーを読む。両者の一致は theme.test.ts で確認する */
export const THEME_STORAGE_KEY = "portal.appearance";

/**
 * アドレスバーなどブラウザ側の UI に渡す色。index.css の --color-canvas と同じ値にする。
 * CSS の light-dark() は meta の content から参照できないため、値を二重に持っている。
 */
export const THEME_COLORS: Record<ThemeScheme, string> = {
  light: "#f2f2f7",
  dark: "#000000",
};

/** 保存値の解釈。未保存や未知の値は、設定を持たない system として扱う */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * theme-color の meta に入れる色。
 * system のときは meta 自身の media が指す外観の色を残し、アプリ内で選んだときは
 * どちらの meta にも選んだ外観の色を入れる (端末側の外観と食い違っても UI が揃う)。
 */
export function themeColorFor(preference: ThemePreference, metaScheme: ThemeScheme): string {
  return THEME_COLORS[preference === "system" ? metaScheme : preference];
}
