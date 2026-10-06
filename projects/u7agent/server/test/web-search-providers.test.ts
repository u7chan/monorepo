// web_search の provider adapter。endpoint・request / response の形式・失敗分類を provider 単位で固定する。
// 実 API は呼ばず、fetchImpl のスタブだけを使う。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  EXA_API_TOOL_NAME,
  EXA_ENDPOINT,
  parseExaResponseBody,
  TAVILY_ENDPOINT,
  tavilyFailureKind,
  WEB_SEARCH_NUM_RESULTS,
  WEB_SEARCH_PROVIDER_IDS,
  webSearchProvider,
  webSearchProviderCatalog,
  webSearchProviderIdOf,
  type WebSearchProviderContext,
  type WebSearchProviderOutcome,
} from "../src/web-search-providers";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function searchWith(
  id: "exa" | "tavily",
  query: string,
  options: { fetchImpl: typeof fetch; apiKey?: string },
): Promise<WebSearchProviderOutcome> {
  const context: WebSearchProviderContext = {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    signal: new AbortController().signal,
  };
  return webSearchProvider(id).search(query, context);
}

/** Exa の advanced ツールが返す形: result.content[0].text が JSON 文字列 */
function jsonRpcResponse(inner: unknown, extra: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }], ...extra } };
}

function responseOf(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

test("provider の一覧は id / 名前 / 送信先 / キーの要否を持ち、未知の id は既定へ畳む", () => {
  assert.deepEqual(webSearchProviderCatalog(), [
    { id: "exa", name: "Exa", host: "mcp.exa.ai", keyless: true },
    { id: "tavily", name: "Tavily", host: "api.tavily.com", keyless: false },
  ]);
  assert.deepEqual([...WEB_SEARCH_PROVIDER_IDS], ["exa", "tavily"]);
  assert.equal(DEFAULT_WEB_SEARCH_PROVIDER, "exa", "既存の keyless Exa を既定のままにする");
  assert.equal(webSearchProviderIdOf("tavily"), "tavily");
  assert.equal(webSearchProviderIdOf(undefined), "exa");
  assert.equal(webSearchProviderIdOf("brave"), "exa", "未知の保存値は既定へ畳む");
  assert.equal(webSearchProviderIdOf(null), "exa");
  assert.equal(webSearchProvider("nope" as never).id, "exa");
});

test("Exa: tools/call を tools/call 1 回で送り、URL と Accept と固定引数を組む", async () => {
  const stub = stubFetch(() => responseOf(JSON.stringify(jsonRpcResponse({ results: [] }))));
  const outcome = await searchWith("exa", "typescript 7.0", { fetchImpl: stub.fetchImpl });
  assert.deepEqual(outcome, { ok: true, items: [] });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, EXA_ENDPOINT);
  assert.equal(stub.calls[0].init.method, "POST");
  const headers = stub.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "application/json, text/event-stream", "片方だけだと Exa は 406 で拒否する");
  assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: EXA_API_TOOL_NAME,
      arguments: {
        query: "typescript 7.0",
        type: "auto",
        numResults: WEB_SEARCH_NUM_RESULTS,
        enableHighlights: true,
        textMaxCharacters: 2_000,
      },
    },
  });
});

test("Exa: 応答本文は data 行 → その連結 → 本文全体の順に解釈する", () => {
  const payload = { jsonrpc: "2.0", result: { ok: true } };
  assert.deepEqual(parseExaResponseBody(`event: message\nid: 1\ndata: ${JSON.stringify(payload)}\n\n`), payload);
  // 1 イベントが複数の data 行へ分かれて届くケース
  assert.deepEqual(
    parseExaResponseBody(['data: {"jsonrpc":"2.0",', 'data: "result":{"ok":true}}', ""].join("\n")),
    payload,
  );
  // Accept で両方を要求するため、data 行の無い素の JSON も受ける
  assert.deepEqual(parseExaResponseBody(JSON.stringify(payload)), payload);
  assert.equal(parseExaResponseBody("<html>502 Bad Gateway</html>"), undefined);
  assert.equal(parseExaResponseBody(""), undefined);
});

test("Exa: results[] を共通形式へ正規化し、highlights を優先して text へ落とし、publishedDate は string のときだけ取る", async () => {
  const body = {
    results: [
      {
        id: "a",
        title: "First",
        url: "https://example.com/a",
        text: "full text",
        highlights: ["one", "two"],
        image: "https://example.com/a.png",
        publishedDate: "2026-01-01",
      },
      { title: "", url: "https://example.com/b", text: " fallback text " },
      { title: "Third", url: "https://example.com/c", text: "t", publishedDate: 20260405 },
      { title: "Fourth", url: "https://example.com/d", text: "t", publishedDate: "" },
      "not a record",
    ],
  };
  const stub = stubFetch(() => responseOf(JSON.stringify(jsonRpcResponse(body))));
  const outcome = await searchWith("exa", "q", { fetchImpl: stub.fetchImpl });
  assert.deepEqual(outcome, {
    ok: true,
    items: [
      { title: "First", url: "https://example.com/a", excerpt: "one\ntwo", publishedDate: "2026-01-01" },
      { title: "", url: "https://example.com/b", excerpt: "fallback text" },
      { title: "Third", url: "https://example.com/c", excerpt: "t" },
      { title: "Fourth", url: "https://example.com/d", excerpt: "t", publishedDate: "" },
    ],
  });
});

test("Exa: 失敗は HTTP ステータスを先に見て種類へ分類し、0 件は正常系にする", async () => {
  const cases: { name: string; response: () => Response; kind: string }[] = [
    {
      name: "JSON-RPC の error",
      response: () => responseOf(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "detail" } })),
      kind: "unexpected_response",
    },
    {
      name: "result.isError (HTTP 200)",
      response: () =>
        responseOf(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { isError: true, content: [{ type: "text", text: "Unknown tool upstream detail" }] },
          }),
        ),
      kind: "provider_error",
    },
    {
      name: "レート制限 (HTTP 200)",
      response: () =>
        responseOf(
          JSON.stringify(
            jsonRpcResponse(
              {},
              { _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text: "slow down" }] },
            ),
          ),
        ),
      kind: "rate_limited",
    },
    {
      name: "content[0].text が JSON でない",
      response: () =>
        responseOf(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } }),
        ),
      kind: "unexpected_response",
    },
    {
      name: "result.content が無い",
      response: () => responseOf(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
      kind: "unexpected_response",
    },
    {
      name: "results が配列でない",
      response: () => responseOf(JSON.stringify(jsonRpcResponse({ results: "nope" }))),
      kind: "unexpected_response",
    },
    {
      name: "HTTP 406 (本文に結果があってもステータスで分類する)",
      response: () =>
        responseOf(JSON.stringify(jsonRpcResponse({ results: [{ title: "T", url: "https://example.com" }] })), {
          status: 406,
        }),
      kind: "provider_error",
    },
    { name: "HTTP 500", response: () => responseOf("upstream detail", { status: 500 }), kind: "provider_error" },
    // Exa のレート制限は HTTP 200 で返るため、HTTP 429 は 5xx と同じ扱いにする (実測に合わせる)
    { name: "HTTP 429", response: () => responseOf("upstream detail", { status: 429 }), kind: "provider_error" },
  ];

  for (const item of cases) {
    const stub = stubFetch(item.response);
    const outcome = await searchWith("exa", "q", { fetchImpl: stub.fetchImpl });
    assert.deepEqual(outcome, { ok: false, kind: item.kind }, item.name);
  }

  const empty = stubFetch(() => responseOf(JSON.stringify(jsonRpcResponse({ results: [] }))));
  assert.deepEqual(await searchWith("exa", "q", { fetchImpl: empty.fetchImpl }), { ok: true, items: [] });
});

test("Tavily: /search へ Bearer で送り、query と固定の検索条件だけを組む", async () => {
  const stub = stubFetch(() => responseOf(JSON.stringify({ results: [] })));
  const outcome = await searchWith("tavily", "typescript 7.0", {
    fetchImpl: stub.fetchImpl,
    apiKey: "tvly-secret",
  });
  assert.deepEqual(outcome, { ok: true, items: [] });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, TAVILY_ENDPOINT);
  assert.equal(stub.calls[0].init.method, "POST");
  const headers = stub.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.authorization, "Bearer tvly-secret");
  assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), {
    query: "typescript 7.0",
    search_depth: "basic",
    max_results: WEB_SEARCH_NUM_RESULTS,
  });
});

test("Tavily: results[] を共通形式へ正規化し、published_date は string のときだけ取る", async () => {
  const body = {
    query: "q",
    answer: "unused",
    results: [
      {
        title: "First",
        url: "https://example.com/a",
        content: " excerpt one ",
        score: 0.81,
        raw_content: "full",
        published_date: "Tue, 11 Mar 2025 17:00:00 GMT",
      },
      { url: "https://example.com/b" },
      { title: "Third", url: "https://example.com/c", content: "c", published_date: 20260405 },
      { title: "Fourth", url: "https://example.com/d", content: "d", published_date: "" },
    ],
    response_time: "1.67",
  };
  const stub = stubFetch(() => responseOf(JSON.stringify(body)));
  const outcome = await searchWith("tavily", "q", { fetchImpl: stub.fetchImpl, apiKey: "tvly-secret" });
  assert.deepEqual(outcome, {
    ok: true,
    items: [
      {
        title: "First",
        url: "https://example.com/a",
        excerpt: "excerpt one",
        publishedDate: "Tue, 11 Mar 2025 17:00:00 GMT",
      },
      { title: "", url: "https://example.com/b", excerpt: "" },
      { title: "Third", url: "https://example.com/c", excerpt: "c" },
      { title: "Fourth", url: "https://example.com/d", excerpt: "d", publishedDate: "" },
    ],
  });
});

test("Tavily: ステータスを種類へ写し、応答本文の詳細は返さない", async () => {
  assert.equal(tavilyFailureKind(429), "rate_limited");
  assert.equal(tavilyFailureKind(432), "quota_exceeded");
  assert.equal(tavilyFailureKind(433), "quota_exceeded");
  assert.equal(tavilyFailureKind(401), "key_rejected");
  assert.equal(tavilyFailureKind(403), "key_rejected");
  assert.equal(tavilyFailureKind(400), "provider_error");
  assert.equal(tavilyFailureKind(422), "provider_error");
  assert.equal(tavilyFailureKind(500), "provider_error");

  const cases: { status: number; kind: string }[] = [
    { status: 400, kind: "provider_error" },
    { status: 401, kind: "key_rejected" },
    { status: 422, kind: "provider_error" },
    { status: 429, kind: "rate_limited" },
    { status: 432, kind: "quota_exceeded" },
    { status: 433, kind: "quota_exceeded" },
    { status: 500, kind: "provider_error" },
  ];
  for (const item of cases) {
    const stub = stubFetch(() =>
      responseOf(JSON.stringify({ detail: { error: "upstream detail tvly-secret" } }), { status: item.status }),
    );
    const outcome = await searchWith("tavily", "q", { fetchImpl: stub.fetchImpl, apiKey: "tvly-secret" });
    assert.deepEqual(outcome, { ok: false, kind: item.kind }, `HTTP ${item.status}`);
  }
});

test("Tavily: 応答が JSON でない / results が配列でないときは想定外の応答にする", async () => {
  const invalidJson = stubFetch(() => responseOf("<html>502 Bad Gateway</html>"));
  assert.deepEqual(await searchWith("tavily", "q", { fetchImpl: invalidJson.fetchImpl, apiKey: "tvly-secret" }), {
    ok: false,
    kind: "unexpected_response",
  });
  const invalidShape = stubFetch(() => responseOf(JSON.stringify({ results: "nope" })));
  assert.deepEqual(await searchWith("tavily", "q", { fetchImpl: invalidShape.fetchImpl, apiKey: "tvly-secret" }), {
    ok: false,
    kind: "unexpected_response",
  });
});

test("Tavily: キー未設定は上流へ送らずに分類する", async () => {
  const stub = stubFetch(() => {
    throw new Error("fetch が呼ばれました");
  });
  assert.deepEqual(await searchWith("tavily", "q", { fetchImpl: stub.fetchImpl }), { ok: false, kind: "key_missing" });
  assert.equal(stub.calls.length, 0);
});
