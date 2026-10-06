/**
 * サイドバーのモードと設定のセクション定義。DOM に依存しない純粋なロジック。
 * 画面の切替は URL (lib/route.ts) が決め、ここはその語彙 (モード / セクション) と保存値を検証する。
 */

export type SidebarMode = "nav" | "settings";

// 並び順はサイドバーの表示順
export type SettingsSection =
  | "agents"
  | "skills"
  | "files"
  | "archive"
  | "appearance"
  | "models"
  | "runtime"
  | "notifications";

export const SETTINGS_SECTIONS: { section: SettingsSection; label: string }[] = [
  { section: "agents", label: "エージェント" },
  { section: "skills", label: "スキル" },
  { section: "files", label: "ファイル" },
  // ファイルの次に置く (ツリーの行のダウンロード導線と対になる設定のため)
  { section: "archive", label: "アーカイブ" },
  { section: "appearance", label: "外観" },
  // モデルは編集する設定 (プロバイダー認証)、ランタイムは診断だけの表示画面
  { section: "models", label: "モデル" },
  { section: "runtime", label: "ランタイム" },
  { section: "notifications", label: "通知" },
];

/**
 * 設定 → モデル のタブ。URL は `/settings/models` と `/settings/models/<sub>` を正とし、
 * 既定タブ (models) はパスへ出さない (lib/route.ts の routePath)。
 */
export type ModelsSubsection = "models" | "providers" | "images" | "web-search";

export const MODELS_SUBSECTIONS: { subsection: ModelsSubsection; label: string }[] = [
  { subsection: "models", label: "モデルを選ぶ" },
  { subsection: "providers", label: "プロバイダー" },
  { subsection: "images", label: "画像生成" },
  // 画像生成と同じく「外部サービスとキー」の面。有効 / 無効の kill switch もここに置く (#1775 / #1776)
  { subsection: "web-search", label: "Web 検索" },
];

export const DEFAULT_MODELS_SUBSECTION: ModelsSubsection = "models";

/** URL にセクションが無いときの行き先 (「設定」の導線と、保存値が読めないときの既定) */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "agents";

/** 「設定」で最後に開いていたセクションの保存先。画面の正は URL で、これは `/` から戻るための補助 */
export const SETTINGS_SECTION_KEY = "u7agent-settings-section";

/** 保存済みの生値を検証する。未知の値 (削除したセクション等) は既定へ畳む */
export function parseStoredSettingsSection(raw: string | null): SettingsSection {
  return SETTINGS_SECTIONS.find((item) => item.section === raw)?.section ?? DEFAULT_SETTINGS_SECTION;
}
