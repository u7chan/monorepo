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
  // コンテンツ生成と Web 検索はモデルと同じ「外部サービスとキー」の面だが、対象そのものが別なので
  // モデルのタブにはせず、ルートのセクションに置く（コンテンツ生成の中は画像 / 音声のタブへ分ける）
  { section: "content", label: "コンテンツ生成" },
  { section: "web-search", label: "Web 検索" },
  { section: "notifications", label: "通知" },
  { section: "appearance", label: "外観" },
  { section: "files", label: "ファイル" },
  // 編集を持たない診断だけの画面なので最後に置く
  { section: "runtime", label: "ランタイム" },
];

/**
 * 設定 → モデル のタブ。URL は `/settings/models` と `/settings/models/<sub>` を正とし、
 * 既定タブ (models) はパスへ出さない (lib/route.ts の routePath)。
 *
 * タブにするのは、同じ対象を別の面から見るとき (モデルの選択とプロバイダー認証、画像生成と
 * 音声（TTS）、ファイルツリーとダウンロードの除外) と、読み取り専用で面ごとに取得と操作が
 * 閉じているとき (ランタイムのサービス / 環境 / 診断) だけ。どちらも hook / API が分かれてよいが、
 * 対象そのものが別の面 (web-search とモデル) はルートのセクションに置く。
 */
export type ModelsSubsection = "models" | "providers";

export const MODELS_SUBSECTIONS: { subsection: ModelsSubsection; label: string }[] = [
  { subsection: "models", label: "モデルを選ぶ" },
  { subsection: "providers", label: "プロバイダー" },
];

export const DEFAULT_MODELS_SUBSECTION: ModelsSubsection = "models";

/**
 * 設定 → コンテンツ生成 のタブ。画像と音声は同じ行 (`content_settings`)・同じ APIキー・同じ
 * 有効化ゲートを共有するため、1 つの対象の別の面として分ける。規則は MODELS_SUBSECTIONS と同じ。
 */
export type ContentSubsection = "image" | "speech" | "bgm";

export const CONTENT_SUBSECTIONS: { subsection: ContentSubsection; label: string }[] = [
  { subsection: "image", label: "画像生成" },
  { subsection: "speech", label: "音声（TTS）" },
  { subsection: "bgm", label: "音楽（BGM）" },
];

export const DEFAULT_CONTENT_SUBSECTION: ContentSubsection = "image";

/** 設定 → ファイル のタブ。同じ対象 (ワークスペースのファイル) の別の面で、規則は MODELS_SUBSECTIONS と同じ */
export type FilesSubsection = "files" | "archive";

export const FILES_SUBSECTIONS: { subsection: FilesSubsection; label: string }[] = [
  { subsection: "files", label: "ファイルツリー" },
  { subsection: "archive", label: "ダウンロードの除外" },
];

export const DEFAULT_FILES_SUBSECTION: FilesSubsection = "files";

/**
 * 設定 → ランタイム のタブ。同じ画面に積むと表示領域を超える読み取り専用の面を分ける。
 * URL は `/settings/runtime` と `/settings/runtime/<sub>` を正とし、既定タブ (service) はパスへ出さない。
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

/**
 * 保存済みの生値を検証する。未知の値 (削除したセクション等) は既定へ畳む。
 * 旧 設定 → ダウンロード ("archive") は 設定 → ファイル の「ダウンロードの除外」タブへ移したため、
 * 保存値だけ files へ読み替える (タブまでは覚えない。URL の読み替えは lib/route.ts が持つ)
 */
export function parseStoredSettingsSection(raw: string | null): SettingsSection {
  const section = raw === "archive" ? "files" : raw;
  return SETTINGS_SECTIONS.find((item) => item.section === section)?.section ?? DEFAULT_SETTINGS_SECTION;
}
