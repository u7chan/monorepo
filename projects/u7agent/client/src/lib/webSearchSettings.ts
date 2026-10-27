/**
 * 設定 → Web 検索の表示変換と文言、テスト検索 1 回分の調停。DOM に依存しない関数だけを置く
 * (送信そのものは API 層が持ち、ここへは関数として渡す)。
 * provider の一覧・送信先・キーの要否はサーバー（`GET /api/settings/web-search`）が返し、ここは語彙だけを持つ。
 * 有効 / 無効と既定 provider の正はサーバー（`web_search_settings`）で、キーは provider ごとの行（docs/web-search.md）。
 */
import type {
  WebSearchProvider,
  WebSearchProviderId,
  WebSearchSettingsResponse,
  WebSearchTestResponse,
} from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import type { ProviderBadge } from "./modelSettings";
import { messageFor } from "./settingsResource";

/** セッションの `tools` ではなく `customTools` 側に載る名前（BFF ローカル） */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const WEB_SEARCH_SETTINGS_NOTE = "Web 検索の設定はサーバーに保存され、再起動後も残ります。";

/** キーの保存方式。master key が無いと復号できず、利用できないことも伝える */
export const WEB_SEARCH_KEY_ENCRYPTED_NOTE =
  "APIキーは暗号化してアプリのデータベース（SQLite）へ保存し、再起動後も使われます。保存したキーは再表示しません。master key（U7AGENT_SECRET_MASTER_KEY）が未設定の間は、保存済みのキーを使えません。";

export const WEB_SEARCH_NO_LOGIN_NOTE =
  "この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。";

/** 実行中の操作。null なら操作なし */
export type WebSearchSavingAction = "enabled" | "provider" | "key" | "delete";

/**
 * テスト検索の初期値。年を入れないのは、年依存の質問でモデルの記憶を使わせない
 * `WEB_SEARCH_TOOL_GUIDELINES` と同じ理由 (現在日時行は結果の先頭に付く)。
 */
export const WEB_SEARCH_TEST_DEFAULT_QUERY = "今日は何の日？";

/** テスト検索の入力の上限。サーバー (server/src/schema.ts) と同じ値で、超える入力は送れない */
export const WEB_SEARCH_TEST_QUERY_MAX_LENGTH = 500;

/** ツール全体の有効 / 無効。設定の他のページと同じチップで出す */
export function webSearchStatusBadge(enabled: boolean): ProviderBadge {
  return enabled ? { label: "有効", tone: "ok" } : { label: "停止中", tone: "warn" };
}

/** 表示する provider。未知 / 未取得でも表示を空にしないため、先頭へ畳む */
export function webSearchProviderDef(
  settings: Pick<WebSearchSettingsResponse, "provider" | "providers">,
  id: WebSearchProviderId = settings.provider,
): WebSearchProvider {
  return settings.providers.find((provider) => provider.id === id) ?? settings.providers[0];
}

export interface WebSearchProviderOption {
  value: WebSearchProviderId;
  label: string;
  /** 右端に出す送信先ホスト */
  detail: string;
  description: string;
}

/**
 * provider 選択（`components/SelectMenu.tsx`）の行。選ぶ前に「どこへ送るか」「何が要るか」が
 * 読めるようにし、選択肢を選んでから分かる状態にしない。
 */
export function webSearchProviderOptions(providers: readonly WebSearchProvider[]): WebSearchProviderOption[] {
  return providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    detail: provider.host,
    description: provider.keyless
      ? "キー不要（keyless の共有エンドポイント）"
      : provider.keyStored
        ? "APIキー設定済み（暗号化して保存）"
        : "APIキーが必要（暗号化して保存）",
  }));
}

/**
 * provider ごとのキー状態。keyless の provider は「キー不要」で固定する。
 * 保存の有無 (`keyStored`) と利用可否 (`keyAvailable`) を分け、復号できないキーを「設定済み」と出さない。
 */
export function webSearchKeyBadge(provider: WebSearchProvider): ProviderBadge {
  if (provider.keyless) return { label: "キー不要", tone: "muted" };
  if (!provider.keyStored) return { label: "未設定", tone: "muted" };
  return provider.keyAvailable ? { label: "設定済み", tone: "ok" } : { label: "利用不可", tone: "warn" };
}

/** 保存済みのキーを使えない理由。未評価 / 復号失敗の文言はサーバーが返したものをそのまま出す */
export function webSearchKeyErrorNotice(provider: WebSearchProvider): string | null {
  if (provider.keyless || !provider.keyStored || provider.keyAvailable) return null;
  return provider.keyErrorMessage;
}

/**
 * データの流れの 1 行。外へ出るのは **web_search ツールを実行したときだけ** であることを落とさない
 * （有効にしただけで送られる、と読ませない）。送信先は既定の provider に追随する。
 */
export function webSearchDataFlowNotice(provider: WebSearchProvider, enabled: boolean): string {
  return enabled
    ? `${WEB_SEARCH_TOOL_NAME} ツールかテスト検索を実行したときだけ、クエリは既定の ${provider.name}（${provider.host}）へ送信されます。取得した抜粋は、ツールならモデル（LLM プロバイダー）へ、テスト検索ならこの画面にだけ渡ります。`
    : `検索は無効です。${WEB_SEARCH_TOOL_NAME} もテスト検索も実行できず、クエリは ${provider.name}（${provider.host}）へ送信されません。`;
}

/** 注意書きを畳んだときの 1 行。送信先は展開前から読めるようにし、切り替えで見落とさないようにする */
export function webSearchNoticeSummary(provider: WebSearchProvider, enabled: boolean): string {
  if (!enabled) return `検索は無効です。クエリは ${provider.name}（${provider.host}）へ送信されません。`;
  const key = provider.keyless ? "" : "キーは暗号化して保存されます。";
  return `${WEB_SEARCH_TOOL_NAME} ツールかテスト検索の実行時にだけ、クエリは ${provider.name}（${provider.host}）へ送信されます。${key}`;
}

/**
 * 既定の provider を選んでいるのにキーが未設定のときの注意。選択とキーの登録が別の行にあるため、
 * 「選んだだけで検索できる」と誤解されたまま保存されるのを防ぐ。
 */
export function webSearchKeyMissingNotice(provider: WebSearchProvider): string | null {
  if (provider.keyless) return null;
  // 保存済みだが使えない状態は、未設定と混同せずサーバーの固定文言を出す
  if (provider.keyStored && !provider.keyAvailable) return provider.keyErrorMessage;
  if (provider.keyStored) return null;
  return `既定の ${provider.name} のAPIキーが未設定です。この状態で検索するとキー無効エラーになります。`;
}

/** テスト検索の入力の誤り。空 / 上限超過は送らない (サーバーも 400 で拒否する) */
export function webSearchTestQueryError(query: string): string | undefined {
  const trimmed = query.trim();
  if (trimmed === "") return "検索するテキストを入力してください。";
  if (trimmed.length > WEB_SEARCH_TEST_QUERY_MAX_LENGTH) {
    return `テスト検索は ${WEB_SEARCH_TEST_QUERY_MAX_LENGTH} 文字以内で入力してください。`;
  }
  return undefined;
}

/** テスト検索を押せない理由。OFF の間は送らない (kill switch をテストだけ迂回させない) */
export function webSearchTestDisabledReason(settings: Pick<WebSearchSettingsResponse, "enabled">): string | undefined {
  return settings.enabled ? undefined : "Web 検索を有効にするとテスト検索できます。";
}

/**
 * テスト検索の 1 行。押す前に「どこへ送るか」「課金されるか」が読めるようにする
 * (クエリの送信先を隠さないのは畳んだ注意書きと同じ方針)。無効の間は押せない理由だけを出す。
 */
export function webSearchTestNotice(provider: WebSearchProvider): string {
  return `テスト検索も実際の検索なので、クエリは ${provider.name}（${provider.host}）へ送信され、provider の課金対象になります。`;
}

/**
 * 設定の世代。テスト検索の開始時と応答時で世代が変わっていたら、その結果は捨てる。
 * 検索待ちの間に OFF / provider / キーが変わっても、旧設定の結果を新しい設定の証拠として出さない。
 */
export interface SettingsGeneration {
  current(): number;
  /** 設定が適用されたときに呼ぶ。進行中の検索を無効にする */
  invalidate(): void;
}

export function createSettingsGeneration(): SettingsGeneration {
  let generation = 0;
  return {
    current: () => generation,
    invalidate: () => {
      generation += 1;
    },
  };
}

/** テスト検索の結果。送ったクエリと組で持ち、入力の編集後もどのクエリの結果か分かるようにする */
export interface WebSearchTestOutcome {
  /** 送信したクエリ (trim 済み) */
  query: string;
  result: WebSearchTestResponse;
}

/**
 * テスト検索を 1 回実行し、採用してよい結果だけを返す (採用しないときは null)。
 * 送信の途中で設定が変わったら、成功も失敗も捨てる。判断を hook の外に置くのは、
 * 「遅れて届いた応答を出さない」という非同期の契約をテストで固定するため。
 */
export async function runWebSearchTest(
  query: string,
  options: {
    generation: SettingsGeneration;
    /** 送信そのもの。テストでは保留できる Promise を返す */
    request: (query: string) => Promise<WebSearchTestResponse>;
  },
): Promise<WebSearchTestOutcome | null> {
  const trimmed = query.trim();
  if (webSearchTestQueryError(trimmed) !== undefined) return null;
  const startedAt = options.generation.current();
  try {
    const result = await options.request(trimmed);
    return options.generation.current() === startedAt ? { query: trimmed, result } : null;
  } catch (error) {
    if (options.generation.current() !== startedAt) return null;
    return { query: trimmed, result: webSearchTestFailure(messageFor(error)) };
  }
}

/** 通信 / 503 の失敗も結果と同じ形へ畳む。描画側の分岐を成功 / 失敗の 1 つに保つ */
export function webSearchTestFailure(message: string): WebSearchTestResponse {
  return { ok: false, output: message, provider: null, resultCount: 0, durationMs: 0 };
}

/** 結果の所要時間。0 は「測っていない」(無効 / 入力エラー) なので出さない */
export function webSearchTestDurationLabel(durationMs: number): string | undefined {
  return durationMs > 0 ? `${(durationMs / 1000).toFixed(1)} 秒` : undefined;
}

/** 実行中の経過。期限 (60 秒) まで待たされていることが分かるよう秒だけを出す */
export function webSearchTestElapsedLabel(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1000)} 秒`;
}

/** 出典の件数。失敗しても 0 件として出し、成功 / 失敗は ok が担う */
export function webSearchTestCountLabel(resultCount: number): string {
  return `${resultCount} 件`;
}

/** 出力パネルの見出しに添える文字数。長さで整形の切り詰めを疑えるようにする */
export function webSearchTestOutputSizeLabel(output: string): string {
  return `${output.length} 文字`;
}

/** トグルの変更が保存されたときの注記。即時反映であることを伝える */
export function webSearchSavedNote(enabled: boolean): string {
  return enabled
    ? "Web 検索を有効にしました。既存の会話でも次の呼び出しから使えます。"
    : "Web 検索を無効にしました。既存の会話でも次の呼び出しから失敗します。";
}

/** 既定 provider の変更が保存されたときの注記。暗黙に他へ切り替えないことも伝える */
export function webSearchProviderSavedNote(name: string): string {
  return `既定の検索プロバイダーを ${name} にしました。次の検索から使われ、失敗しても他の provider へは切り替えません。`;
}

export function webSearchKeySavedNote(name: string): string {
  return `${name} のAPIキーを保存しました。次の検索から使えます。`;
}

export function webSearchKeyDeletedNote(name: string): string {
  return `${name} のAPIキーを削除しました。この provider を既定にしたまま検索すると失敗します。`;
}

/** キー削除の確認。再登録できる操作なので danger にはしない */
export function deleteWebSearchKeyConfirmRequest(name: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: `${name} のAPIキーを削除`,
    subject: { label: "検索プロバイダー", value: name },
    body: ["削除すると、この provider を既定にした検索はキー無効エラーになります。"],
    confirmLabel: "削除する",
  };
}
