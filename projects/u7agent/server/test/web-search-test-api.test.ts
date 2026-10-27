// 設定 → Web 検索のテスト検索 API（POST /api/settings/web-search/test）。実 API は呼ばず、
// fetch のスタブで「モデルへ返る本文と同じ整形」「OFF では送らない」「失敗も 200」を固定する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import {
  WEB_SEARCH_DISABLED_MESSAGE,
  WEB_SEARCH_KEY_MISSING_MESSAGE,
  WEB_SEARCH_RATE_LIMITED_MESSAGE,
} from "../src/web-search-tool";
import { WEB_SEARCH_TEST_UNAVAILABLE_MESSAGE } from "../src/web-search-test";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { asPiBff, createStubPi } from "./stub-pi";

// キーのマスクは保存済みの値で検証する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const SECRET = "tvly-secret-value-0123456789";
const DATE_LINE = /^現在日時: \d{4}-\d{2}-\d{2} \(Asia\/Tokyo\)\n/;

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-web-search-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Exa の advanced ツールの応答 (JSON-RPC を SSE で返す) を組み立てる */
function exaFetch(results: { title?: string; url?: string; text?: string }[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ results }) }] },
    };
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Tavily の応答。本文は provider の結果としてそのまま返る */
function tavilyFetch(response: () => Response): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("テスト検索はモデルへ返る本文と同じ整形を返し、会話も設定も変えない", async () => {
  await withStoreDir(async (dir) => {
    const stub = exaFetch([
      { title: "今日は何の日", url: "https://example.com/today", text: "2月11日は建国記念の日。" },
      { title: "暦の一覧", url: "https://example.com/calendar", text: "2月の記念日。" },
    ]);
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      webSearchTestFetch: stub.fetchImpl,
    });
    try {
      const before = await jsonBody(await bff.app.request("/api/settings/web-search"));
      const response = await bff.app.request(
        "/api/settings/web-search/test",
        jsonPost({ query: "  今日は何の日？  " }),
      );
      assert.equal(response.status, 200);
      const body = await jsonBody(response);
      assert.equal(body.ok, true);
      assert.match(body.output, DATE_LINE, "先頭は現在日時行");
      assert.ok(body.output.includes("検索プロバイダー: Exa\n出典:\n[1] 今日は何の日 — https://example.com/today"));
      assert.ok(body.output.includes("2月11日は建国記念の日。"), "抜粋も本文に含める");
      assert.deepEqual(body.provider, { id: "exa", name: "Exa", host: "mcp.exa.ai" });
      assert.equal(body.resultCount, 2);
      assert.ok(body.durationMs >= 0);
      assert.equal(stub.calls.length, 1, "1 回だけ検索する");
      // 前後の空白は落として送る
      assert.equal(JSON.parse(String(stub.calls[0]?.init.body)).params.arguments.query, "今日は何の日？");
      assert.deepEqual((await jsonBody(await bff.app.request("/api/sessions"))).sessions, [], "会話を作らない");
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), before, "設定を変えない");
    } finally {
      await bff.close();
    }
  });
});

test("OFF の間は上流へ送らず、モデルへ返るのと同じ固定文言を返す", async () => {
  await withStoreDir(async (dir) => {
    const stub = exaFetch([]);
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      webSearchTestFetch: stub.fetchImpl,
    });
    try {
      await bff.app.request("/api/settings/web-search", jsonPut({ enabled: false }));
      const body = await jsonBody(await bff.app.request("/api/settings/web-search/test", jsonPost({ query: "q" })));
      assert.equal(body.ok, false);
      assert.equal(body.output, WEB_SEARCH_DISABLED_MESSAGE, "日時行を付けない固定文言");
      assert.equal(body.provider, null, "送っていないので provider も無い");
      assert.equal(body.resultCount, 0);
      assert.equal(stub.calls.length, 0, "OFF は kill switch なので送らない");
    } finally {
      await bff.close();
    }
  });
});

test("キー未設定は上流へ送らず、provider 行付きの固定文言を返す", async () => {
  await withStoreDir(async (dir) => {
    const stub = tavilyFetch(() => Response.json({ results: [] }));
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      webSearchTestFetch: stub.fetchImpl,
    });
    try {
      await bff.app.request("/api/settings/web-search/provider", jsonPut({ provider: "tavily" }));
      const body = await jsonBody(await bff.app.request("/api/settings/web-search/test", jsonPost({ query: "q" })));
      assert.equal(body.ok, false);
      assert.match(body.output, DATE_LINE);
      assert.ok(body.output.includes("検索プロバイダー: Tavily\n"));
      assert.ok(body.output.includes(WEB_SEARCH_KEY_MISSING_MESSAGE));
      assert.deepEqual(body.provider, { id: "tavily", name: "Tavily", host: "api.tavily.com" });
      assert.equal(stub.calls.length, 0);
    } finally {
      await bff.close();
    }
  });
});

test("上流の失敗は固定文言へ写し、保存済みのキー値を応答に出さない", async () => {
  await withStoreDir(async (dir) => {
    // 429 は provider の応答本文をそのまま返す。本文にキーが混ざっても画面へ出さない
    let status = 429;
    const stub = tavilyFetch(() => Response.json({ detail: `invalid key ${SECRET}` }, { status }));
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      webSearchTestFetch: stub.fetchImpl,
    });
    try {
      await bff.app.request("/api/settings/web-search/provider", jsonPut({ provider: "tavily" }));
      await bff.app.request("/api/settings/web-search/providers/tavily/key", jsonPut({ apiKey: SECRET }));
      const limited = await jsonBody(await bff.app.request("/api/settings/web-search/test", jsonPost({ query: "q" })));
      assert.equal(limited.ok, false);
      assert.ok(limited.output.includes(WEB_SEARCH_RATE_LIMITED_MESSAGE));
      assert.ok(limited.output.includes("検索プロバイダー: Tavily"));
      assert.equal(JSON.stringify(limited).includes(SECRET), false, "キー値を応答に載せない");
    } finally {
      await bff.close();
    }
  });
});

test("本文が契約に合わないテスト検索は 400 で、上流へ送らない", async () => {
  await withStoreDir(async (dir) => {
    const stub = exaFetch([]);
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      webSearchTestFetch: stub.fetchImpl,
    });
    try {
      const invalid: RequestInit[] = [
        jsonPost({ query: "" }),
        jsonPost({ query: "   " }),
        jsonPost({ query: "x".repeat(501) }),
        jsonPost({}),
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" },
      ];
      for (const init of invalid) {
        assert.equal((await bff.app.request("/api/settings/web-search/test", init)).status, 400);
      }
      // 上限ちょうどは通る (400 の境界を片側だけにしない)
      assert.equal(
        (await bff.app.request("/api/settings/web-search/test", jsonPost({ query: "x".repeat(500) }))).status,
        200,
      );
      assert.equal(stub.calls.length, 1);
    } finally {
      await bff.close();
    }
  });
});

test("実行環境を作れない起動では 503 を返す", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await bff.app.request("/api/settings/web-search/test", jsonPost({ query: "q" }));
      assert.equal(response.status, 503);
      assert.equal((await jsonBody(response)).error, WEB_SEARCH_TEST_UNAVAILABLE_MESSAGE);
    } finally {
      await bff.close();
    }
  });
});
