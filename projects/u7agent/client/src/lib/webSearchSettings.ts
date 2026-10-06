/**
 * 設定 → モデル（Web 検索タブ）の表示変換と文言。DOM に依存しない純関数だけを置く。
 * 有効 / 無効の正はサーバー（`web_search_settings`）で、ここは表示の語彙だけを持つ（docs/web-search.md）。
 */
import type { ProviderBadge } from "./modelSettings";

/** セッションの `tools` ではなく `customTools` 側に載る名前（BFF ローカル） */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/** v1 は keyless な Exa 固定（切り替えは #1776）。外部送信先を隠さないためホストも持つ */
export const WEB_SEARCH_PROVIDER = { name: "Exa", host: "mcp.exa.ai" } as const;

/** ツール全体の有効 / 無効。設定 → モデル の他のタブと同じチップで出す */
export function webSearchStatusBadge(enabled: boolean): ProviderBadge {
  return enabled ? { label: "有効", tone: "ok" } : { label: "停止中", tone: "warn" };
}

/**
 * データの流れの 1 行。外へ出るのは **web_search ツールを実行したときだけ** であることを落とさない
 * （有効にしただけで送られる、と読ませない）。
 */
export function webSearchDataFlowNotice(enabled: boolean): string {
  const { name, host } = WEB_SEARCH_PROVIDER;
  return enabled
    ? `${WEB_SEARCH_TOOL_NAME} ツールを実行したときだけ、クエリは ${name}（${host}）へ送信され、取得した抜粋はモデル（LLM プロバイダー）へ渡ります。`
    : `検索は無効です。${name}（${host}）へ検索のクエリを送信しません。`;
}

/** トグルの変更が保存されたときの注記。即時反映であることを伝える */
export function webSearchSavedNote(enabled: boolean): string {
  return enabled
    ? "Web 検索を有効にしました。既存の会話でも次の呼び出しから使えます。"
    : "Web 検索を無効にしました。既存の会話でも次の呼び出しから失敗します。";
}

/** 読み込み時の注記。再起動後も残ることを最初に伝える */
export const WEB_SEARCH_SETTINGS_NOTE = "Web 検索の設定はサーバーに保存され、再起動後も残ります。";
