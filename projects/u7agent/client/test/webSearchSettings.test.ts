// 設定 → Web 検索（`/settings/web-search`）の表示変換。provider の一覧・送信先・キー状態・文言を純関数で固定する
// (画面の描画は webSearchSettingsTab.test.ts)。

import assert from "node:assert/strict";
import test from "node:test";
import type { WebSearchProvider } from "../src/types";
import {
  deleteWebSearchKeyConfirmRequest,
  WEB_SEARCH_KEY_PLAINTEXT_NOTE,
  WEB_SEARCH_NO_LOGIN_NOTE,
  WEB_SEARCH_SETTINGS_NOTE,
  WEB_SEARCH_TOOL_NAME,
  webSearchDataFlowNotice,
  webSearchKeyBadge,
  webSearchKeyDeletedNote,
  webSearchKeyMissingNotice,
  webSearchKeySavedNote,
  webSearchNoticeSummary,
  webSearchProviderDef,
  webSearchProviderOptions,
  webSearchProviderSavedNote,
  webSearchSavedNote,
  webSearchStatusBadge,
} from "../src/lib/webSearchSettings";

const EXA: WebSearchProvider = { id: "exa", name: "Exa", host: "mcp.exa.ai", keyless: true, configured: true };
const TAVILY: WebSearchProvider = {
  id: "tavily",
  name: "Tavily",
  host: "api.tavily.com",
  keyless: false,
  configured: false,
};

const BASE = { provider: "exa" as const, providers: [EXA, TAVILY] };

test("モデルへ公開するツール名は web_search のまま", () => {
  assert.equal(WEB_SEARCH_TOOL_NAME, "web_search");
});

test("状態バッジは有効 / 停止中を分ける", () => {
  assert.deepEqual(webSearchStatusBadge(true), { label: "有効", tone: "ok" });
  assert.deepEqual(webSearchStatusBadge(false), { label: "停止中", tone: "warn" });
});

test("表示する provider は既定に追随し、未知の値でも先頭へ畳む", () => {
  assert.deepEqual(webSearchProviderDef(BASE), EXA);
  assert.deepEqual(webSearchProviderDef(BASE, "tavily"), TAVILY);
  assert.deepEqual(webSearchProviderDef({ provider: "exa", providers: [EXA] }, "brave" as never), EXA);
  assert.deepEqual(webSearchProviderDef({ provider: "exa", providers: [EXA, TAVILY] }, "tavily"), TAVILY);
});

test("選択肢は送信先とキーの要否を選ぶ前に読ませる", () => {
  assert.deepEqual(webSearchProviderOptions([EXA, TAVILY]), [
    { value: "exa", label: "Exa", detail: "mcp.exa.ai", description: "キー不要（keyless の共有エンドポイント）" },
    { value: "tavily", label: "Tavily", detail: "api.tavily.com", description: "APIキーが必要（平文で保存）" },
  ]);
  assert.deepEqual(
    webSearchProviderOptions([{ ...TAVILY, configured: true }])[0].description,
    "APIキー設定済み（平文で保存）",
  );
});

test("キーの状態バッジは keyless を固定にし、キー付きは設定済み / 未設定を分ける", () => {
  assert.deepEqual(webSearchKeyBadge(EXA), { label: "キー不要", tone: "muted" });
  assert.deepEqual(webSearchKeyBadge(TAVILY), { label: "未設定", tone: "muted" });
  assert.deepEqual(webSearchKeyBadge({ ...TAVILY, configured: true }), { label: "設定済み", tone: "ok" });
});

test("データの流れは、実行したときだけ外へ出ることを明示する", () => {
  assert.equal(
    webSearchDataFlowNotice(EXA, true),
    "web_search ツールを実行したときだけ、クエリは既定の Exa（mcp.exa.ai）へ送信され、取得した抜粋はモデル（LLM プロバイダー）へ渡ります。",
  );
  assert.equal(
    webSearchDataFlowNotice(TAVILY, false),
    "検索は無効です。検索のクエリは Tavily（api.tavily.com）へ送信されません。",
  );
});

test("折りたたみの 1 行は、そのまま送信先とキーの保存を見せる", () => {
  assert.equal(
    webSearchNoticeSummary(EXA, true),
    "web_search ツールの実行時にだけ、クエリは Exa（mcp.exa.ai）へ送信されます。",
  );
  assert.equal(
    webSearchNoticeSummary(TAVILY, true),
    "web_search ツールの実行時にだけ、クエリは Tavily（api.tavily.com）へ送信されます。キーは平文で保存されます。",
  );
  assert.equal(
    webSearchNoticeSummary(TAVILY, false),
    "検索は無効です。クエリは Tavily（api.tavily.com）へ送信されません。",
  );
});

test("キー未設定の警告は、キー付きで未設定のときだけ出す", () => {
  assert.equal(webSearchKeyMissingNotice(EXA), null);
  assert.equal(webSearchKeyMissingNotice({ ...TAVILY, configured: true }), null);
  assert.equal(
    webSearchKeyMissingNotice(TAVILY),
    "既定の Tavily のAPIキーが未設定です。この状態で検索するとキー無効エラーになります。",
  );
});

test("保存の文言は、既存の会話にも効くことと暗黙に切り替えないことを落とさない", () => {
  assert.equal(webSearchSavedNote(true), "Web 検索を有効にしました。既存の会話でも次の呼び出しから使えます。");
  assert.equal(webSearchSavedNote(false), "Web 検索を無効にしました。既存の会話でも次の呼び出しから失敗します。");
  assert.match(webSearchProviderSavedNote("Tavily"), /Tavily/);
  assert.match(webSearchProviderSavedNote("Tavily"), /他の provider へは切り替えません/);
  assert.match(webSearchKeySavedNote("Tavily"), /保存しました/);
  assert.match(webSearchKeyDeletedNote("Tavily"), /削除しました/);
  assert.match(WEB_SEARCH_SETTINGS_NOTE, /再起動後も残ります/);
  assert.match(WEB_SEARCH_KEY_PLAINTEXT_NOTE, /平文で保存/);
  assert.match(WEB_SEARCH_NO_LOGIN_NOTE, /公開しないでください/);
});

test("キー削除の確認は、対象と結果が分かる文言にする", () => {
  const request = deleteWebSearchKeyConfirmRequest("Tavily");
  assert.equal(request.kind, "confirm");
  assert.match(request.title, /Tavily のAPIキーを削除/);
  assert.deepEqual(request.subject, { label: "検索プロバイダー", value: "Tavily" });
  assert.equal(request.confirmLabel, "削除する");
  assert.equal(request.danger, undefined, "再登録できる操作なので danger にはしない");
});
