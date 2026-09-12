// テーマ定義の単一ソース。id と system の解決先は client/public/theme-init.js にも (CSP 対応の
// classic script のため)、light / dark は index.css プリセットの color-scheme にも重複して存在する。
// ずれても型エラーにならないため themeSync テストで突き合わせる。
export const THEMES = [
  { id: "midnight", label: "ミッドナイト", appearance: "dark" },
  { id: "daylight", label: "デイライト", appearance: "light" },
  { id: "mocha", label: "モカ", appearance: "dark" },
  { id: "forest", label: "フォレスト", appearance: "dark" },
  { id: "sakura", label: "サクラ", appearance: "light" },
  { id: "sky", label: "スカイ", appearance: "light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

// theme-init.js の FALLBACK / prefersLight 分岐と一致させること
export const SYSTEM_DARK_ID: ThemeId = "midnight";
export const SYSTEM_LIGHT_ID: ThemeId = "daylight";

export type ThemeChoice = ThemeId | "system";

export const DEFAULT_THEME: ThemeChoice = "system";

export const THEME_STORAGE_KEY = "pi-agent-theme";

/** 任意の値 (localStorage 等) が有効なテーマ id か */
export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/** 保存済みの生値を選択へ解決する。削除されたテーマ id は system と同じ扱いにする (保存値は書き換えない) */
export function parseStoredThemeChoice(raw: string | null): ThemeChoice {
  return raw === "system" || isThemeId(raw) ? raw : DEFAULT_THEME;
}
