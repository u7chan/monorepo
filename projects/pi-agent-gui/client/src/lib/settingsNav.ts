/**
 * サイドバーのモードと メイン領域に出すもの の対応。DOM に依存しない純粋なロジック。
 * 設定ページは dialog を被せずメイン領域に出すため、サイドバーのモードがそのまま表示の切替になる。
 */

export type SidebarMode = "nav" | "settings";

// 並び順はサイドバーの表示順
export type SettingsSection = "agents" | "skills" | "files" | "appearance";

export const SETTINGS_SECTIONS: { section: SettingsSection; label: string }[] = [
  { section: "agents", label: "エージェント" },
  { section: "skills", label: "スキル" },
  { section: "files", label: "ファイル" },
  { section: "appearance", label: "外観" },
];

export type MainView = "chat" | "settings";

export function mainViewFor(mode: SidebarMode): MainView {
  return mode === "settings" ? "settings" : "chat";
}
