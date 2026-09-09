// テーマ定義の単一ソース。
// client/public/theme-init.js の id 配列・light 判定と整合させていること:
//   THEMES = ["midnight", "daylight", "mocha", "forest", "sakura", "terminal"]
//   LIGHT_THEMES = ["daylight", "sakura"]
export const THEMES = [
  { id: "midnight", label: "ミッドナイト", appearance: "dark" },
  { id: "daylight", label: "デイライト", appearance: "light" },
  { id: "mocha", label: "モカ", appearance: "dark" },
  { id: "forest", label: "フォレスト", appearance: "dark" },
  { id: "sakura", label: "サクラ", appearance: "light" },
  { id: "terminal", label: "ターミナル", appearance: "dark" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export type ThemeChoice = ThemeId | "system";

export const DEFAULT_THEME: ThemeChoice = "system";

export const THEME_STORAGE_KEY = "pi-agent-theme";

/** localStorage 等から読んだ任意の値が有効なテーマ id かどうか */
export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}
