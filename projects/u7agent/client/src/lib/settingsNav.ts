/**
 * サイドバーのモードと設定のセクション定義。DOM に依存しない純粋なロジック。
 * 画面の切替は URL (lib/route.ts) が決め、ここはその語彙 (モード / セクション) と保存値を検証する。
 */

export type SidebarMode = "nav" | "settings";

// 並び順はサイドバーの表示順
export type SettingsSection = "agents" | "skills" | "files" | "appearance" | "runtime" | "notifications";

export const SETTINGS_SECTIONS: { section: SettingsSection; label: string }[] = [
  { section: "agents", label: "エージェント" },
  { section: "skills", label: "スキル" },
  { section: "files", label: "ファイル" },
  { section: "appearance", label: "外観" },
  { section: "runtime", label: "ランタイム" },
  { section: "notifications", label: "通知" },
];

/** URL にセクションが無いときの行き先 (「設定」の導線と、保存値が読めないときの既定) */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "agents";

/** 「設定」で最後に開いていたセクションの保存先。画面の正は URL で、これは `/` から戻るための補助 */
export const SETTINGS_SECTION_KEY = "u7agent-settings-section";

/** 保存済みの生値を検証する。未知の値 (削除したセクション等) は既定へ畳む */
export function parseStoredSettingsSection(raw: string | null): SettingsSection {
  return SETTINGS_SECTIONS.find((item) => item.section === raw)?.section ?? DEFAULT_SETTINGS_SECTION;
}
