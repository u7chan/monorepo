// classic script / CSS との同期は themeSync.test.ts、定義の追加手順は docs/frontend.md。
// 並びはダーク → ライト。設定 → 外観の一覧はこの並びをそのまま 2 群に割る (選択欄も同じ順になる)。
// SYSTEM_DARK_ID / SYSTEM_LIGHT_ID の 2 つは system の解決先なので、各群の先頭から動かさない。
export const THEMES = [
  { id: "midnight", label: "ミッドナイト", appearance: "dark" },
  { id: "mocha", label: "モカ", appearance: "dark" },
  { id: "forest", label: "フォレスト", appearance: "dark" },
  { id: "catppuccin-mocha", label: "カプチーノ モカ", appearance: "dark" },
  { id: "catppuccin-frappe", label: "カプチーノ フラペ", appearance: "dark" },
  { id: "nord", label: "ノルド", appearance: "dark" },
  { id: "tokyo-night", label: "トーキョーナイト", appearance: "dark" },
  { id: "kanagawa", label: "カナガワ", appearance: "dark" },
  { id: "gruvbox-dark", label: "グルーヴボックス ダーク", appearance: "dark" },
  { id: "everforest-dark", label: "エバーフォレスト ダーク", appearance: "dark" },
  { id: "dracula", label: "ドラキュラ", appearance: "dark" },
  { id: "daylight", label: "デイライト", appearance: "light" },
  { id: "sakura", label: "サクラ", appearance: "light" },
  { id: "sky", label: "スカイ", appearance: "light" },
  { id: "catppuccin-latte", label: "カプチーノ ラテ", appearance: "light" },
  { id: "gruvbox-light", label: "グルーヴボックス ライト", appearance: "light" },
  { id: "rose-pine-dawn", label: "ローズパイン ドーン", appearance: "light" },
  { id: "everforest-light", label: "エバーフォレスト ライト", appearance: "light" },
  { id: "one-light", label: "ワン ライト", appearance: "light" },
  { id: "solarized-light", label: "ソラライズド ライト", appearance: "light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

// theme-init.js の FALLBACK / prefersLight 分岐と一致させること
export const SYSTEM_DARK_ID: ThemeId = "midnight";
export const SYSTEM_LIGHT_ID: ThemeId = "daylight";

export type ThemeChoice = ThemeId | "system";

export const DEFAULT_THEME: ThemeChoice = "system";

export const THEME_STORAGE_KEY = "u7agent-theme";

/** 任意の値 (localStorage 等) が有効なテーマ id か */
export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/** 保存済みの生値を選択へ解決する。削除されたテーマ id は system と同じ扱いにする (保存値は書き換えない) */
export function parseStoredThemeChoice(raw: string | null): ThemeChoice {
  return raw === "system" || isThemeId(raw) ? raw : DEFAULT_THEME;
}
