/**
 * 設定 → モデル（Web 検索タブ）の表示変換と文言。DOM に依存しない純関数だけを置く。
 * provider の一覧・送信先・キーの要否はサーバー（`GET /api/settings/web-search`）が返し、ここは語彙だけを持つ。
 * 有効 / 無効と既定 provider の正はサーバー（`web_search_settings`）で、キーは provider ごとの行（docs/web-search.md）。
 */
import type { WebSearchProvider, WebSearchProviderId, WebSearchSettingsResponse } from "../types";
import type { ConfirmRequest } from "./confirmDialog";
import type { ProviderBadge } from "./modelSettings";

/** セッションの `tools` ではなく `customTools` 側に載る名前（BFF ローカル） */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const WEB_SEARCH_SETTINGS_NOTE = "Web 検索の設定はサーバーに保存され、再起動後も残ります。";

/** キーの保存方式。画像生成と同じで、保存時に暗号化しないことを隠さない */
export const WEB_SEARCH_KEY_PLAINTEXT_NOTE =
  "APIキーはアプリのデータベース（SQLite）へ平文で保存し、再起動後も使われます。保存したキーは再表示しません。";

export const WEB_SEARCH_NO_LOGIN_NOTE =
  "この GUI にはログインがありません。BFF をインターネットや LAN へ公開しないでください。";

/** 実行中の操作。null なら操作なし */
export type WebSearchSavingAction = "enabled" | "provider" | "key" | "delete";

/** ツール全体の有効 / 無効。設定 → モデル の他のタブと同じチップで出す */
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
      : provider.configured
        ? "APIキー設定済み（平文で保存）"
        : "APIキーが必要（平文で保存）",
  }));
}

/** provider ごとのキー状態。keyless の provider は「キー不要」で固定する */
export function webSearchKeyBadge(provider: WebSearchProvider): ProviderBadge {
  if (provider.keyless) return { label: "キー不要", tone: "muted" };
  return provider.configured ? { label: "設定済み", tone: "ok" } : { label: "未設定", tone: "muted" };
}

/**
 * データの流れの 1 行。外へ出るのは **web_search ツールを実行したときだけ** であることを落とさない
 * （有効にしただけで送られる、と読ませない）。送信先は既定の provider に追随する。
 */
export function webSearchDataFlowNotice(provider: WebSearchProvider, enabled: boolean): string {
  return enabled
    ? `${WEB_SEARCH_TOOL_NAME} ツールを実行したときだけ、クエリは既定の ${provider.name}（${provider.host}）へ送信され、取得した抜粋はモデル（LLM プロバイダー）へ渡ります。`
    : `検索は無効です。検索のクエリは ${provider.name}（${provider.host}）へ送信されません。`;
}

/**
 * 既定の provider を選んでいるのにキーが未設定のときの注意。選択とキーの登録が別の行にあるため、
 * 「選んだだけで検索できる」と誤解されたまま保存されるのを防ぐ。
 */
export function webSearchKeyMissingNotice(provider: WebSearchProvider): string | null {
  if (provider.keyless || provider.configured) return null;
  return `既定の ${provider.name} のAPIキーが未設定です。この状態で検索するとキー無効エラーになります。`;
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
