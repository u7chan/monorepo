// 設定 → モデル（Web 検索タブ）の表示変換。状態バッジ・データの流れ・保存の文言を純関数で固定する
// (画面の描画は webSearchSettingsTab.test.ts)。

import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_SEARCH_PROVIDER,
  WEB_SEARCH_SETTINGS_NOTE,
  WEB_SEARCH_TOOL_NAME,
  webSearchDataFlowNotice,
  webSearchSavedNote,
  webSearchStatusBadge,
} from "../src/lib/webSearchSettings";

test("モデルへ公開するツール名は web_search のまま", () => {
  assert.equal(WEB_SEARCH_TOOL_NAME, "web_search");
});

test("v1 の provider は keyless な Exa 固定で、送信先のホストを画面に出せる", () => {
  assert.deepEqual(WEB_SEARCH_PROVIDER, { name: "Exa", host: "mcp.exa.ai" });
});

test("状態バッジは有効 / 停止中を分ける", () => {
  assert.deepEqual(webSearchStatusBadge(true), { label: "有効", tone: "ok" });
  assert.deepEqual(webSearchStatusBadge(false), { label: "停止中", tone: "warn" });
});

test("データの流れは、実行したときだけ外へ出ることを明示する", () => {
  assert.equal(
    webSearchDataFlowNotice(true),
    "web_search ツールを実行したときだけ、クエリは Exa（mcp.exa.ai）へ送信され、取得した抜粋はモデル（LLM プロバイダー）へ渡ります。",
  );
  assert.equal(webSearchDataFlowNotice(false), "検索は無効です。Exa（mcp.exa.ai）へ検索のクエリを送信しません。");
});

test("保存の文言は、既存の会話にも効くことを落とさない", () => {
  assert.equal(webSearchSavedNote(true), "Web 検索を有効にしました。既存の会話でも次の呼び出しから使えます。");
  assert.equal(webSearchSavedNote(false), "Web 検索を無効にしました。既存の会話でも次の呼び出しから失敗します。");
  assert.match(WEB_SEARCH_SETTINGS_NOTE, /再起動後も残ります/);
});
