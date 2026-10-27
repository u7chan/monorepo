// 設定 → Web 検索（`/settings/web-search`）の表示変換。provider の一覧・送信先・キー状態・文言を純関数で固定する
// (画面の描画は webSearchSettingsTab.test.ts)。

import assert from "node:assert/strict";
import test from "node:test";
import type { WebSearchProvider, WebSearchTestResponse } from "../src/types";
import {
  deleteWebSearchKeyConfirmRequest,
  WEB_SEARCH_KEY_ENCRYPTED_NOTE,
  WEB_SEARCH_TEST_DEFAULT_QUERY,
  WEB_SEARCH_TEST_QUERY_MAX_LENGTH,
  WEB_SEARCH_NO_LOGIN_NOTE,
  WEB_SEARCH_SETTINGS_NOTE,
  WEB_SEARCH_TOOL_NAME,
  webSearchDataFlowNotice,
  webSearchKeyBadge,
  webSearchKeyErrorNotice,
  webSearchKeyDeletedNote,
  webSearchKeyMissingNotice,
  webSearchKeySavedNote,
  webSearchNoticeSummary,
  webSearchProviderDef,
  webSearchProviderOptions,
  webSearchProviderSavedNote,
  webSearchSavedNote,
  createSettingsGeneration,
  webSearchStatusBadge,
  webSearchTestCountLabel,
  webSearchTestDisabledReason,
  webSearchTestDurationLabel,
  webSearchTestElapsedLabel,
  webSearchTestFailure,
  webSearchTestNotice,
  webSearchTestOutputSizeLabel,
  webSearchTestQueryError,
  runWebSearchTest,
} from "../src/lib/webSearchSettings";

const EXA: WebSearchProvider = {
  id: "exa",
  name: "Exa",
  host: "mcp.exa.ai",
  keyless: true,
  configured: true,
  keyStored: false,
  keyAvailable: true,
  keyEvaluated: true,
  keyErrorMessage: null,
};
const TAVILY: WebSearchProvider = {
  id: "tavily",
  name: "Tavily",
  host: "api.tavily.com",
  keyless: false,
  configured: false,
  keyStored: false,
  keyAvailable: false,
  keyEvaluated: true,
  keyErrorMessage: null,
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
    { value: "tavily", label: "Tavily", detail: "api.tavily.com", description: "APIキーが必要（暗号化して保存）" },
  ]);
  assert.deepEqual(
    webSearchProviderOptions([{ ...TAVILY, configured: true, keyStored: true, keyAvailable: true }])[0].description,
    "APIキー設定済み（暗号化して保存）",
  );
});

test("キーの状態バッジは keyless を固定にし、キー付きは保存と利用可否を分ける", () => {
  assert.deepEqual(webSearchKeyBadge(EXA), { label: "キー不要", tone: "muted" });
  assert.deepEqual(webSearchKeyBadge(TAVILY), { label: "未設定", tone: "muted" });
  assert.deepEqual(webSearchKeyBadge({ ...TAVILY, configured: true, keyStored: true, keyAvailable: true }), {
    label: "設定済み",
    tone: "ok",
  });
  // 保存済みでも復号できないキーは「設定済み」と出さない
  assert.deepEqual(
    webSearchKeyBadge({ ...TAVILY, configured: true, keyStored: true, keyAvailable: false }),
    { label: "利用不可", tone: "warn" },
    "復号できないキーを設定済みと表示しない",
  );
});

test("データの流れは、実行したときだけ外へ出ることを明示する", () => {
  assert.equal(
    webSearchDataFlowNotice(EXA, true),
    "web_search ツールかテスト検索を実行したときだけ、クエリは既定の Exa（mcp.exa.ai）へ送信されます。取得した抜粋は、ツールならモデル（LLM プロバイダー）へ、テスト検索ならこの画面にだけ渡ります。",
  );
  assert.equal(
    webSearchDataFlowNotice(TAVILY, false),
    "検索は無効です。web_search もテスト検索も実行できず、クエリは Tavily（api.tavily.com）へ送信されません。",
  );
});

test("折りたたみの 1 行は、そのまま送信先とキーの保存を見せる", () => {
  assert.equal(
    webSearchNoticeSummary(EXA, true),
    "web_search ツールかテスト検索の実行時にだけ、クエリは Exa（mcp.exa.ai）へ送信されます。",
  );
  assert.equal(
    webSearchNoticeSummary(TAVILY, true),
    "web_search ツールかテスト検索の実行時にだけ、クエリは Tavily（api.tavily.com）へ送信されます。キーは暗号化して保存されます。",
  );
  assert.equal(
    webSearchNoticeSummary(TAVILY, false),
    "検索は無効です。クエリは Tavily（api.tavily.com）へ送信されません。",
  );
});

test("キー未設定の警告は、キー付きで未設定のときだけ出す", () => {
  assert.equal(webSearchKeyMissingNotice(EXA), null);
  assert.equal(webSearchKeyMissingNotice({ ...TAVILY, configured: true, keyStored: true, keyAvailable: true }), null);
  assert.equal(
    webSearchKeyMissingNotice(TAVILY),
    "既定の Tavily のAPIキーが未設定です。この状態で検索するとキー無効エラーになります。",
  );
  // 保存済みだが復号できないときは、未設定と混同せずサーバーの固定文言を出す
  assert.equal(
    webSearchKeyMissingNotice({ ...TAVILY, keyStored: true, keyAvailable: false, keyErrorMessage: "復号できません" }),
    "復号できません",
  );
});

test("保存済みのキーを使えない理由は、サーバーの固定文言をそのまま出す", () => {
  assert.equal(webSearchKeyErrorNotice(EXA), null);
  assert.equal(webSearchKeyErrorNotice(TAVILY), null);
  assert.equal(
    webSearchKeyErrorNotice({ ...TAVILY, keyStored: true, keyAvailable: true, keyErrorMessage: "使えない" }),
    null,
    "使えるキーには警告を出さない",
  );
  assert.equal(
    webSearchKeyErrorNotice({ ...TAVILY, keyStored: true, keyAvailable: false, keyErrorMessage: "使えない" }),
    "使えない",
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
  assert.match(WEB_SEARCH_KEY_ENCRYPTED_NOTE, /暗号化して/);
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

test("テスト検索の既定値と入力の規則", () => {
  assert.equal(WEB_SEARCH_TEST_DEFAULT_QUERY, "今日は何の日？");
  assert.equal(WEB_SEARCH_TEST_QUERY_MAX_LENGTH, 500);
  assert.equal(webSearchTestQueryError("   "), "検索するテキストを入力してください。");
  assert.equal(webSearchTestQueryError(" 今日は何の日？ "), undefined);
  assert.equal(webSearchTestQueryError("あ".repeat(WEB_SEARCH_TEST_QUERY_MAX_LENGTH)), undefined);
  assert.ok(webSearchTestQueryError("あ".repeat(WEB_SEARCH_TEST_QUERY_MAX_LENGTH + 1))?.includes("500 文字以内"));
});

test("テスト検索は OFF のとき押せず、押す前に送信先と課金対象を見せる", () => {
  assert.equal(webSearchTestDisabledReason({ enabled: true }), undefined);
  assert.equal(webSearchTestDisabledReason({ enabled: false }), "Web 検索を有効にするとテスト検索できます。");
  assert.ok(webSearchTestNotice(EXA).includes("Exa（mcp.exa.ai）"));
  assert.ok(webSearchTestNotice(EXA).includes("課金対象"), "押す前に課金を伝える");
});

test("テスト検索の結果は、通信の失敗も同じ形に畳んで秒・件数・文字数を出す", () => {
  assert.deepEqual(webSearchTestFailure("HTTP 503"), {
    ok: false,
    output: "HTTP 503",
    provider: null,
    resultCount: 0,
    durationMs: 0,
  });
  assert.equal(webSearchTestDurationLabel(0), undefined, "測っていない 0 は出さない");
  assert.equal(webSearchTestDurationLabel(1234), "1.2 秒");
  assert.equal(webSearchTestElapsedLabel(12_800), "12 秒");
  assert.equal(webSearchTestCountLabel(0), "0 件");
  assert.equal(webSearchTestOutputSizeLabel("abc"), "3 文字");
});

const TEST_RESULT: WebSearchTestResponse = {
  ok: true,
  output: "現在日時: 2026-02-11 (Asia/Tokyo)\n検索プロバイダー: Exa\n出典:",
  provider: { id: "exa", name: "Exa", host: "mcp.exa.ai" },
  resultCount: 1,
  durationMs: 12,
};

/** 送信を保留して、検索待ちの間に設定を変える状況を作る */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("テスト検索は検索待ちの間に設定が変わったら、成功も失敗も採用しない", async () => {
  const generation = createSettingsGeneration();

  // 応答が返る前に OFF / provider / キーが変わった (onApply が世代を進める)
  const success = pending<WebSearchTestResponse>();
  const successRun = runWebSearchTest("q", { generation, request: () => success.promise });
  generation.invalidate();
  success.resolve(TEST_RESULT);
  assert.equal(await successRun, null, "旧設定の成功を新しい設定の証拠にしない");

  const failure = pending<WebSearchTestResponse>();
  const failureRun = runWebSearchTest("q", { generation, request: () => failure.promise });
  generation.invalidate();
  failure.reject(new Error("HTTP 503"));
  assert.equal(await failureRun, null, "旧設定の失敗も出さない");

  // 設定が変わった後の検索は採用する (捨てるのは跨いだ応答だけ)
  assert.deepEqual(await runWebSearchTest(" q ", { generation, request: async () => TEST_RESULT }), {
    query: "q",
    result: TEST_RESULT,
  });
});

test("テスト検索は設定が変わらなければ、成功も失敗も採用する", async () => {
  const generation = createSettingsGeneration();
  assert.deepEqual(await runWebSearchTest(" 今日は何の日？ ", { generation, request: async () => TEST_RESULT }), {
    query: "今日は何の日？",
    result: TEST_RESULT,
  });

  const failed = await runWebSearchTest("q", {
    generation,
    request: async () => {
      throw new Error("HTTP 503");
    },
  });
  assert.deepEqual(failed, { query: "q", result: webSearchTestFailure("HTTP 503") });
});

test("空のテスト検索は送らない", async () => {
  let calls = 0;
  const generation = createSettingsGeneration();
  const request = async (): Promise<WebSearchTestResponse> => {
    calls += 1;
    return TEST_RESULT;
  };
  assert.equal(await runWebSearchTest("   ", { generation, request }), null);
  assert.equal(calls, 0);
});
