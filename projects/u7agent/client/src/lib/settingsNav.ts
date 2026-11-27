/**
 * サイドバーのモードと設定のセクション定義。DOM に依存しない純粋なロジック。
 * 画面の切替は URL (lib/route.ts) が決め、ここはその語彙 (モード / セクション) と保存値を検証する。
 */

export type SidebarMode = "nav" | "settings";

// 並び順はサイドバーの表示順
export type SettingsSection =
  | "agents"
  | "prompts"
  | "skills"
  | "files"
  | "git"
  | "backup"
  | "appearance"
  | "models"
  | "content"
  | "web-search"
  | "voice-input"
  | "session-title"
  | "sharing"
  | "runtime"
  | "notifications"
  | "spaces";

export const SETTINGS_SECTIONS: { section: SettingsSection; label: string }[] = [
  // 会話を組み立てる設定 (エージェント / スキル / モデル / コンテンツ生成 / Web 検索) を先、
  // アプリ全体と見るだけの設定を後に置く
  { section: "spaces", label: "会話スペース" },
  { section: "agents", label: "エージェント" },
  // 定型プロンプトはエージェントから独立したマスタなので、エージェントのタブではなく次の行に置く
  { section: "prompts", label: "定型プロンプト" },
  { section: "skills", label: "スキル" },
  { section: "models", label: "モデル" },
  // コンテンツ生成と Web 検索はモデルと同じ「外部サービスとキー」の面だが、対象そのものが別なので
  // モデルのタブにはせず、ルートのセクションに置く（コンテンツ生成の中は画像 / 音声のタブへ分ける）
  { section: "content", label: "コンテンツ生成" },
  { section: "web-search", label: "Web 検索" },
  // 音声入力は OpenAI Platform のキーを使う別の外部サービス面。コンテンツ生成（OpenRouter）とは
  // キーも用途も別なので、そのタブにはせず、並びも外部サービス面の末尾に置く
  { section: "voice-input", label: "音声入力" },
  // 会話タイトルの AI 要約は、本会話のモデル (設定 → モデル) とは独立したモデルを選ぶ別の設定。
  // 対象は「会話の見出し」なので、モデルやコンテンツ生成のタブにはせずルートのセクションに置く
  { section: "session-title", label: "会話タイトル" },
  // 共有は公開先の接続と、公開した成果物の管理を同じ画面に置く。接続は外部サービスとキーの面だが、
  // 対象は「共有」そのもので、モデル / コンテンツ生成 / Web 検索とは別
  { section: "sharing", label: "共有" },
  { section: "notifications", label: "通知" },
  { section: "appearance", label: "外観" },
  { section: "files", label: "ファイル" },
  // Git の identity はファイルと同じ「エージェントの作業環境」の設定。commit の前提なので、
  // 定義の持ち出し (バックアップ) より前に置く
  { section: "git", label: "Git" },
  // 定義の持ち出しと復元は「ファイル」の隣に置く (対象はワークスペースではなくアプリの定義)。
  // 破壊的な全削除を持つため、編集を持つ設定の列には混ぜない
  { section: "backup", label: "バックアップ" },
  // 編集を持たない診断だけの画面なので最後に置く
  { section: "runtime", label: "ランタイム" },
];

/**
 * 設定 → 外観 のタブ。テーマとアイコンは同じ見た目の設定だが、テーマの一覧が縦に長いため分ける。
 * URL は `/settings/appearance` と `<sub>` を正とし、既定タブ (theme) はパスへ出さない。
 */
export type AppearanceSubsection = "theme" | "icons";

export const APPEARANCE_SUBSECTIONS: { subsection: AppearanceSubsection; label: string }[] = [
  { subsection: "theme", label: "テーマ" },
  { subsection: "icons", label: "アイコン" },
];

export const DEFAULT_APPEARANCE_SUBSECTION: AppearanceSubsection = "theme";

/**
 * 設定 → モデル のタブ。既定タブ (models) はパスへ出さず、タブにするのは同じ対象を別の面から見る
 * ときと、読み取り専用で面ごとに取得と操作が閉じているときだけ (対象が別ならルートのセクション)。
 */
export type ModelsSubsection = "models" | "providers";

export const MODELS_SUBSECTIONS: { subsection: ModelsSubsection; label: string }[] = [
  { subsection: "models", label: "モデルを選ぶ" },
  { subsection: "providers", label: "プロバイダー" },
];

export const DEFAULT_MODELS_SUBSECTION: ModelsSubsection = "models";

/**
 * 設定 → コンテンツ生成 のタブ。画像・音声・BGM は同じ行・APIキー・有効化ゲートを共有するので
 * 1 つの対象の別の面として分ける (規則は MODELS_SUBSECTIONS と同じ)。`history` は試行の横断面。
 */
export type ContentSubsection = "image" | "speech" | "bgm" | "history";

export const CONTENT_SUBSECTIONS: { subsection: ContentSubsection; label: string }[] = [
  { subsection: "image", label: "画像生成" },
  { subsection: "speech", label: "音声（TTS）" },
  { subsection: "bgm", label: "音楽（BGM）" },
  { subsection: "history", label: "履歴" },
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

/**
 * 設定 → 共有 のタブ。公開した成果物・公開対象から落とす名前・公開先の接続を分ける。既定タブは
 * パスへ出さず、「公開の除外」と「接続」は対象が別なのでタブにする。
 */
export type SharingSubsection = "contents" | "exclusions" | "connections";

export const SHARING_SUBSECTIONS: { subsection: SharingSubsection; label: string }[] = [
  { subsection: "contents", label: "共有コンテンツ" },
  { subsection: "exclusions", label: "公開の除外" },
  { subsection: "connections", label: "接続" },
];

export const DEFAULT_SHARING_SUBSECTION: SharingSubsection = "contents";

/**
 * タブ (サブセクション) を持つ設定のセクションと、そのタブの値・`Route` のフィールド名の対応。
 * `Route` のセクションごとのフィールドの型もこの対応で決まる (lib/route.ts)。
 */
type SettingsTabDefinitions = {
  appearance: { subsection: AppearanceSubsection; field: "appearanceSubsection" };
  models: { subsection: ModelsSubsection; field: "modelsSubsection" };
  content: { subsection: ContentSubsection; field: "contentSubsection" };
  files: { subsection: FilesSubsection; field: "filesSubsection" };
  sharing: { subsection: SharingSubsection; field: "sharingSubsection" };
  runtime: { subsection: RuntimeSubsection; field: "runtimeSubsection" };
};

/** タブを持つ設定のセクション */
export type SettingsTabSection = keyof SettingsTabDefinitions;

/** セクションが持ちうるタブの値 (例: 設定 → モデル なら "models" | "providers") */
export type SettingsSubsection<S extends SettingsTabSection> = SettingsTabDefinitions[S]["subsection"];

/** セクションのタブを載せる `Route` のフィールド名 */
export type SettingsTabField<S extends SettingsTabSection> = SettingsTabDefinitions[S]["field"];

/** 表の 1 行 (タブの一覧・既定と、`Route` のフィールド名) */
type SettingsTabSpec<S extends SettingsTabSection> = {
  field: SettingsTabField<S>;
  items: readonly { subsection: SettingsSubsection<S>; label: string }[];
  defaultSubsection: SettingsSubsection<S>;
};

/**
 * セクション → タブの一覧・既定・`Route` のフィールド名。URL の解釈・正準化・現在タブの取り出しは
 * lib/route.ts の関数がこの表だけを引くので、タブを持つ画面を足すときに直すのはこの表と画面だけ。
 */
export const SETTINGS_TABS: { [S in SettingsTabSection]: SettingsTabSpec<S> } = {
  appearance: {
    field: "appearanceSubsection",
    items: APPEARANCE_SUBSECTIONS,
    defaultSubsection: DEFAULT_APPEARANCE_SUBSECTION,
  },
  models: { field: "modelsSubsection", items: MODELS_SUBSECTIONS, defaultSubsection: DEFAULT_MODELS_SUBSECTION },
  content: { field: "contentSubsection", items: CONTENT_SUBSECTIONS, defaultSubsection: DEFAULT_CONTENT_SUBSECTION },
  files: { field: "filesSubsection", items: FILES_SUBSECTIONS, defaultSubsection: DEFAULT_FILES_SUBSECTION },
  sharing: { field: "sharingSubsection", items: SHARING_SUBSECTIONS, defaultSubsection: DEFAULT_SHARING_SUBSECTION },
  runtime: { field: "runtimeSubsection", items: RUNTIME_SUBSECTIONS, defaultSubsection: DEFAULT_RUNTIME_SUBSECTION },
};

/** そのセクションがタブを持つかを、表で判定する */
export function isSettingsTabSection(section: SettingsSection): section is SettingsTabSection {
  return section in SETTINGS_TABS;
}

/** 表から 1 行を引く (セクションを型引数にして、フィールド名とタブの値を対応させる) */
export function settingsTabSpec<S extends SettingsTabSection>(section: S): SettingsTabSpec<S> {
  return SETTINGS_TABS[section];
}

/** URL にセクションが無いときの行き先 (「設定」の導線と、保存値が読めないときの既定) */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "agents";

/** 「設定」で最後に開いていたセクションの保存先。画面の正は URL で、これは `/` から戻るための補助 */
export const SETTINGS_SECTION_KEY = "u7agent-settings-section";

/**
 * 保存済みの生値を検証する。未知の値は既定へ畳み、保存値の "archive" は files の「ダウンロードの
 * 除外」として読み替える (タブまでは覚えない。URL の読み替えは lib/route.ts)。
 */
export function parseStoredSettingsSection(raw: string | null): SettingsSection {
  const section = raw === "archive" ? "files" : raw;
  return SETTINGS_SECTIONS.find((item) => item.section === section)?.section ?? DEFAULT_SETTINGS_SECTION;
}
