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
  | "content"
  | "web-search"
  | "runtime"
  | "notifications"
  | "spaces";

export const SETTINGS_SECTIONS: { section: SettingsSection; label: string }[] = [
  // 会話を組み立てる設定 (エージェント / スキル / モデル / コンテンツ生成 / Web 検索) を先、
  // アプリ全体と見るだけの設定を後に置く
  { section: "spaces", label: "会話スペース" },
  { section: "agents", label: "エージェント" },
  { section: "skills", label: "スキル" },
  { section: "models", label: "モデル" },
  // コンテンツ生成と Web 検索はモデルと同じ「外部サービスとキー」の面だが、独自の API と hook を持つ
  { section: "content", label: "コンテンツ生成" },
  { section: "web-search", label: "Web 検索" },
  { section: "notifications", label: "通知" },
  { section: "appearance", label: "外観" },
  { section: "files", label: "ファイル" },
  // ファイルの次に置く (ツリーの行のダウンロード導線と対になる設定のため)
  { section: "archive", label: "ダウンロード" },
  // 編集を持たない診断だけの画面なので最後に置く
  { section: "runtime", label: "ランタイム" },
];

/**
 * 設定 → モデル のタブ。URL は `/settings/models` と `/settings/models/<sub>` を正とし、
 * 既定タブ (models) はパスへ出さない (lib/route.ts の routePath)。
 *
 * タブにするのは、同じデータを同じ hook で見方を切り替えるとき (モデルの選択と、そのモデルの
 * プロバイダー認証) と、読み取り専用で面ごとに取得が閉じているとき (ランタイムのサービス / 環境 /
 * 診断) だけ。編集を伴う独自の API と hook を持つ面はルートのセクション (content / web-search) に置く。
 */
export type ModelsSubsection = "models" | "providers";

export const MODELS_SUBSECTIONS: { subsection: ModelsSubsection; label: string }[] = [
  { subsection: "models", label: "モデルを選ぶ" },
  { subsection: "providers", label: "プロバイダー" },
];

export const DEFAULT_MODELS_SUBSECTION: ModelsSubsection = "models";

/**
 * 設定 → ランタイム のタブ。URL は `/settings/runtime` と `/settings/runtime/<sub>` を正とし、
 * 既定タブ (service) はパスへ出さない (lib/route.ts の routePath)。
 */
export type RuntimeSubsection = "service" | "environment" | "diagnostics";

export const RUNTIME_SUBSECTIONS: { subsection: RuntimeSubsection; label: string }[] = [
  { subsection: "service", label: "サービス" },
  { subsection: "environment", label: "環境" },
  { subsection: "diagnostics", label: "診断" },
];

export const DEFAULT_RUNTIME_SUBSECTION: RuntimeSubsection = "service";

/** URL にセクションが無いときの行き先 (「設定」の導線と、保存値が読めないときの既定) */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "agents";

/** 「設定」で最後に開いていたセクションの保存先。画面の正は URL で、これは `/` から戻るための補助 */
export const SETTINGS_SECTION_KEY = "u7agent-settings-section";

/** 保存済みの生値を検証する。未知の値 (削除したセクション等) は既定へ畳む */
export function parseStoredSettingsSection(raw: string | null): SettingsSection {
  return SETTINGS_SECTIONS.find((item) => item.section === raw)?.section ?? DEFAULT_SETTINGS_SECTION;
}
