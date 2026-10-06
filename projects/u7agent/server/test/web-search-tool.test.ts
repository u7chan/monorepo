// web_search ツールの要求・応答解釈・整形・失敗分類。実 API は呼ばず、fetchImpl のスタブで検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMutableSecretMasker, type SecretMasker } from "../src/redact";
import { UnknownRemoteToolError, createRemoteToolDefinitions } from "../src/sandbox/remote-tools";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox/service";
import {
  createWebSearchToolDefinitions,
  formatWebSearchResults,
  parseWebSearchResponseBody,
  WEB_SEARCH_ABORTED_MESSAGE,
  WEB_SEARCH_API_TOOL_NAME,
  WEB_SEARCH_DISABLED_MESSAGE,
  WEB_SEARCH_ENDPOINT,
  WEB_SEARCH_EXCERPT_MAX_LENGTH,
  WEB_SEARCH_NETWORK_ERROR_MESSAGE,
  WEB_SEARCH_NO_RESULTS_MESSAGE,
  WEB_SEARCH_OUTPUT_MAX_LENGTH,
  WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
  WEB_SEARCH_RATE_LIMITED_MESSAGE,
  WEB_SEARCH_TIMEOUT_MESSAGE,
  WEB_SEARCH_TOOL_GUIDELINES,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
  withWebSearchTool,
} from "../src/web-search-tool";

type AnyTool = ToolDefinition<any, any, any>;

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

/** Exa の advanced ツールが返す形: result.content[0].text が JSON 文字列 */
function jsonRpcResponse(inner: unknown, extra: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }], ...extra } };
}

function sseResponse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responseOf(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

function tool(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; masker?: SecretMasker; readEnabled?: () => boolean } = {},
): AnyTool {
  const definitions = createWebSearchToolDefinitions({
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error("fetch が呼ばれました");
      }),
    masker: options.masker ?? createMutableSecretMasker([]),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.readEnabled === undefined ? {} : { readEnabled: options.readEnabled }),
  });
  assert.equal(definitions.length, 1);
  return definitions[0];
}

async function run(tool: AnyTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const result = (await tool.execute("call-1", params, signal, undefined, {} as never)) as {
    content: { type: string; text?: string }[];
  };
  const text = result.content[0]?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

/** execute の throw を message で比較する (スタブの原文が混ざったら失敗させる) */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("成功してしまいました");
    },
    (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      return error;
    },
  );
}

test("web_search は常時公開で、サンドボックスへ送るツールではない", () => {
  assert.deepEqual(withWebSearchTool(["read", "bash"]), ["read", "bash", WEB_SEARCH_TOOL_NAME]);
  assert.ok(!(SANDBOX_TOOL_NAMES as readonly string[]).includes(WEB_SEARCH_TOOL_NAME));
  assert.throws(
    () =>
      createRemoteToolDefinitions({
        cwd: "/workspace",
        rootCwd: "/workspace",
        sandboxCwd: "",
        client: {} as never,
        masker: createMutableSecretMasker([]),
        tools: ["read", WEB_SEARCH_TOOL_NAME],
      }),
    UnknownRemoteToolError,
  );
});

test("引数は query だけで、説明とガイドラインは web_search と curl の使い分けを指示する", () => {
  const definition = tool();
  assert.equal(definition.name, WEB_SEARCH_TOOL_NAME);
  assert.equal(definition.label, WEB_SEARCH_TOOL_NAME);
  const parameters = definition.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(parameters.properties), ["query"]);
  assert.deepEqual(parameters.required, ["query"]);
  assert.match(definition.description, /Search the web/);
  assert.match(definition.description, /`curl`/);
  assert.deepEqual(definition.promptGuidelines, [...WEB_SEARCH_TOOL_GUIDELINES]);
  assert.match(WEB_SEARCH_TOOL_GUIDELINES.join("\n"), /`curl`/);
});

test("query は空文字と空白のみを SDK の引数検証で弾く (execute は呼ばれない)", () => {
  const definition = tool();
  const validate = (query: string): unknown =>
    validateToolArguments(definition, {
      type: "toolCall",
      id: "call-1",
      name: WEB_SEARCH_TOOL_NAME,
      arguments: { query },
    });
  assert.deepEqual(validate("typescript 7.0"), { query: "typescript 7.0" });
  assert.throws(() => validate(""), /query/);
  assert.throws(() => validate("   "), /query/);
  assert.throws(() => validate("\n\t "), /query/);
});

test("tools/call を 1 回だけ送り、URL と Accept と固定引数を組む", async () => {
  const stub = stubFetch(() => sseResponse(jsonRpcResponse({ results: [] })));
  const definition = tool({ fetchImpl: stub.fetchImpl });
  assert.equal(await run(definition, { query: "typescript 7.0" }), WEB_SEARCH_NO_RESULTS_MESSAGE);

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, WEB_SEARCH_ENDPOINT);
  assert.equal(stub.calls[0].init.method, "POST");
  const headers = stub.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "application/json, text/event-stream");
  assert.deepEqual(JSON.parse(String(stub.calls[0].init.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: WEB_SEARCH_API_TOOL_NAME,
      arguments: {
        query: "typescript 7.0",
        type: "auto",
        numResults: 5,
        enableHighlights: true,
        textMaxCharacters: 2_000,
      },
    },
  });
});

test("応答本文は data 行 → その連結 → 本文全体の順に解釈する", () => {
  const payload = { jsonrpc: "2.0", result: { ok: true } };
  assert.deepEqual(parseWebSearchResponseBody(`event: message\nid: 1\ndata: ${JSON.stringify(payload)}\n\n`), payload);
  // 1 イベントが複数の data 行へ分かれて届くケース
  assert.deepEqual(
    parseWebSearchResponseBody(['data: {"jsonrpc":"2.0",', 'data: "result":{"ok":true}}', ""].join("\n")),
    payload,
  );
  // Accept で両方を要求するため、data 行の無い素の JSON も受ける
  assert.deepEqual(parseWebSearchResponseBody(JSON.stringify(payload)), payload);
  assert.equal(parseWebSearchResponseBody("<html>502 Bad Gateway</html>"), undefined);
  assert.equal(parseWebSearchResponseBody(""), undefined);
});

test("出典一覧を先頭に置き、highlights を優先して text へ落とす", async () => {
  const stub = stubFetch(() =>
    sseResponse(
      jsonRpcResponse({
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
          { title: "", url: "https://example.com/b", text: "fallback text" },
        ],
      }),
    ),
  );
  const text = await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" });
  assert.ok(text.startsWith("出典:\n[1] First — https://example.com/a\n[2] (no title) — https://example.com/b"), text);
  assert.ok(text.includes("[1] First — https://example.com/a\none\ntwo"), text);
  assert.ok(text.includes("[2] (no title) — https://example.com/b\nfallback text"), text);
  assert.ok(!text.includes("full text"), "highlights があるときは text を使わない");
  assert.ok(!text.includes("publishedDate"), text);
});

test("1 件の抜粋は 1,500 字で切る", async () => {
  const stub = stubFetch(() =>
    sseResponse(
      jsonRpcResponse({ results: [{ title: "T", url: "https://example.com", highlights: ["あ".repeat(4_000)] }] }),
    ),
  );
  const text = await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" });
  assert.ok(text.includes(`${"あ".repeat(WEB_SEARCH_EXCERPT_MAX_LENGTH)}…`), "上限で切って … を付ける");
  assert.ok(!text.includes("あ".repeat(WEB_SEARCH_EXCERPT_MAX_LENGTH + 1)), "上限を超えて残っている");
});

test("合計 12,000 字を超えたら末尾を落として ... [truncated] を付ける", async () => {
  const results = Array.from({ length: 5 }, (_, index) => ({
    title: `T${index} ${"t".repeat(500)}`,
    url: `https://example.com/${index}`,
    highlights: ["h".repeat(4_000)],
  }));
  const stub = stubFetch(() => sseResponse(jsonRpcResponse({ results })));
  const text = await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" });
  assert.equal(text.length, WEB_SEARCH_OUTPUT_MAX_LENGTH);
  assert.ok(text.endsWith("... [truncated]"));
  assert.ok(text.startsWith("出典:\n"), "出典一覧は残す");
});

test("失敗は HTTP ステータスを先に見て固定文言へ分類し、上流の本文を出さない", async () => {
  const cases: { name: string; response: () => Response; message: string }[] = [
    {
      name: "JSON-RPC の error",
      response: () =>
        responseOf(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "upstream detail" } })),
      message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
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
      message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
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
      message: WEB_SEARCH_RATE_LIMITED_MESSAGE,
    },
    {
      name: "content[0].text が JSON でない",
      response: () =>
        responseOf(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } }),
        ),
      message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
    },
    {
      name: "result.content が無い",
      response: () => responseOf(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
      message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
    },
    {
      name: "results が配列でない",
      response: () => sseResponse(jsonRpcResponse({ results: "nope" })),
      message: WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE,
    },
    {
      name: "HTTP 406 (本文に結果があってもステータスで分類する)",
      response: () =>
        responseOf(JSON.stringify(jsonRpcResponse({ results: [{ title: "T", url: "https://example.com" }] })), {
          status: 406,
        }),
      message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
    },
    {
      name: "HTTP 500",
      response: () => responseOf("upstream detail", { status: 500 }),
      message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
    },
    {
      name: "HTTP 429",
      response: () => responseOf("upstream detail", { status: 429 }),
      message: WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
    },
  ];

  for (const item of cases) {
    const stub = stubFetch(item.response);
    const error = await rejection(run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" }));
    assert.equal(error.message, item.message, item.name);
    assert.ok(!error.message.includes("upstream detail"), item.name);
  }
});

test("ネットワーク例外は接続できない旨へ分類し、原文をマスクして添える", async () => {
  const stub = stubFetch(() => {
    throw new Error("connect ECONNREFUSED 127.0.0.1");
  });
  const error = await rejection(run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" }));
  assert.match(error.message, new RegExp(`^${WEB_SEARCH_NETWORK_ERROR_MESSAGE}: `));
  assert.match(error.message, /ECONNREFUSED/);
});

test("タイムアウトは自前タイマーで分類し、ユーザー中断とは別の文言にする", async () => {
  const pendingFetch = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
    });

  const timeoutStub = stubFetch(pendingFetch);
  const timeoutError = await rejection(run(tool({ fetchImpl: timeoutStub.fetchImpl, timeoutMs: 10 }), { query: "q" }));
  assert.equal(timeoutError.message, WEB_SEARCH_TIMEOUT_MESSAGE);

  const controller = new AbortController();
  const abortStub = stubFetch(pendingFetch);
  const pending = run(tool({ fetchImpl: abortStub.fetchImpl }), { query: "q" }, controller.signal);
  controller.abort();
  const abortError = await rejection(pending);
  assert.equal(abortError.message, WEB_SEARCH_ABORTED_MESSAGE);
});

test("results が空配列なら正常系として『結果が見つかりませんでした』を返す", async () => {
  const stub = stubFetch(() => sseResponse(jsonRpcResponse({ results: [] })));
  assert.equal(await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" }), WEB_SEARCH_NO_RESULTS_MESSAGE);
  assert.equal(formatWebSearchResults([], createMutableSecretMasker([])), WEB_SEARCH_NO_RESULTS_MESSAGE);
});

test("秘密値は 1 件の切り詰めより先にマスクし、throw の文言もマスクする", async () => {
  const secret = "sk-live-secret-value-0123456789";
  const masker = createMutableSecretMasker([secret]);
  // 抜粋の上限の位置に秘密値の先頭が乗る。マスクが後だと完全一致で拾えない断片が残る
  const excerpt = `${"x".repeat(1_480)}${secret}${"y".repeat(100)}`;
  const stub = stubFetch(() =>
    sseResponse(jsonRpcResponse({ results: [{ title: "T", url: "https://example.com", highlights: [excerpt] }] })),
  );
  const text = await run(tool({ fetchImpl: stub.fetchImpl, masker }), { query: "q" });
  assert.ok(text.includes("[REDACTED]"), text);
  assert.ok(!text.includes(secret.slice(0, 10)), "切り詰めで欠けた秘密値の断片が残っている");

  const failing = stubFetch(() => {
    throw new Error(`fetch failed with ${secret}`);
  });
  const error = await rejection(run(tool({ fetchImpl: failing.fetchImpl, masker }), { query: "q" }));
  assert.ok(error.message.includes("[REDACTED]"), error.message);
  assert.ok(!error.message.includes(secret), error.message);
});

test("無効の間は検索せず固定文言で失敗し、ON に戻ると同じ定義が検索する", async () => {
  const stub = stubFetch(() => sseResponse(jsonRpcResponse({ results: [{ title: "T", url: "https://example.com" }] })));
  // 実行のたびに読む (セッション作成時の値で凍結しない)
  let enabled = false;
  const definition = tool({ fetchImpl: stub.fetchImpl, readEnabled: () => enabled });

  const off = await rejection(run(definition, { query: "q" }));
  assert.equal(off.message, WEB_SEARCH_DISABLED_MESSAGE);
  assert.equal(stub.calls.length, 0, "無効の間は mcp.exa.ai へ送らない");

  // 同じ定義 (= 既存セッションのツール) のまま ON へ戻すと動く
  enabled = true;
  assert.ok((await run(definition, { query: "q" })).includes("出典:"), "ON に戻すと同じ定義で検索できる");
  assert.equal(stub.calls.length, 1);

  enabled = false;
  const offAgain = await rejection(run(definition, { query: "q" }));
  assert.equal(offAgain.message, WEB_SEARCH_DISABLED_MESSAGE);
  assert.equal(stub.calls.length, 1, "OFF へ戻すと再び送らなくなる");
});

test("readEnabled を渡さない既定は有効", async () => {
  const stub = stubFetch(() => sseResponse(jsonRpcResponse({ results: [{ title: "T", url: "https://example.com" }] })));
  assert.ok((await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" })).includes("出典:"));
  assert.equal(stub.calls.length, 1);
});
