// web_search ツールの共通契約（引数・整形・上限・timeout / abort・provider 選択・失敗の写し）。
// provider ごとの request / response は web-search-providers.test.ts が持つ。実 API は呼ばず、
// fetchImpl のスタブで検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMutableSecretMasker, type SecretMasker } from "../src/redact";
import { UnknownRemoteToolError, createRemoteToolDefinitions } from "../src/sandbox/remote-tools";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox/service";
import { EXA_ENDPOINT, TAVILY_ENDPOINT, type WebSearchProviderId } from "../src/web-search-providers";
import {
  createWebSearchToolDefinitions,
  formatWebSearchResults,
  WEB_SEARCH_ABORTED_MESSAGE,
  WEB_SEARCH_DISABLED_MESSAGE,
  WEB_SEARCH_EXCERPT_MAX_LENGTH,
  WEB_SEARCH_KEY_MISSING_MESSAGE,
  WEB_SEARCH_KEY_REJECTED_MESSAGE,
  WEB_SEARCH_NETWORK_ERROR_MESSAGE,
  WEB_SEARCH_NO_RESULTS_MESSAGE,
  WEB_SEARCH_OUTPUT_MAX_LENGTH,
  WEB_SEARCH_PROVIDER_ERROR_MESSAGE,
  WEB_SEARCH_QUOTA_EXCEEDED_MESSAGE,
  WEB_SEARCH_RATE_LIMITED_MESSAGE,
  WEB_SEARCH_SETTINGS_UNAVAILABLE_MESSAGE,
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

/** Exa の結果 1 件 (title / url / text) を返す応答 */
function exaResults(items: { title?: string; url?: string; text?: string; highlights?: string[] }[]): Response {
  return sseResponse(jsonRpcResponse({ results: items }));
}

function tool(
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    masker?: SecretMasker;
    readEnabled?: () => boolean;
    readProvider?: () => WebSearchProviderId;
    readApiKey?: (provider: WebSearchProviderId) => string | undefined;
  } = {},
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
    ...(options.readProvider === undefined ? {} : { readProvider: options.readProvider }),
    ...(options.readApiKey === undefined ? {} : { readApiKey: options.readApiKey }),
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
  // provider は設定で変わるため、schema の説明へ送信先ホストを埋め込まない
  assert.equal(JSON.stringify(parameters).includes("exa.ai"), false);
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

test("既定は Exa で、出典一覧を先頭に置いて highlights を優先する", async () => {
  const stub = stubFetch(() =>
    exaResults([
      { title: "First", url: "https://example.com/a", text: "full text", highlights: ["one", "two"] },
      { title: "", url: "https://example.com/b", text: "fallback text" },
    ]),
  );
  const text = await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" });
  assert.equal(stub.calls[0].url, EXA_ENDPOINT);
  assert.ok(text.startsWith("出典:\n[1] First — https://example.com/a\n[2] (no title) — https://example.com/b"), text);
  assert.ok(text.includes("[1] First — https://example.com/a\none\ntwo"), text);
  assert.ok(text.includes("[2] (no title) — https://example.com/b\nfallback text"), text);
  assert.ok(!text.includes("full text"), "highlights があるときは text を使わない");
});

test("1 件の抜粋は 1,500 字、合計は 12,000 字で切る", async () => {
  const single = stubFetch(() =>
    exaResults([{ title: "T", url: "https://example.com", highlights: ["あ".repeat(4_000)] }]),
  );
  const one = await run(tool({ fetchImpl: single.fetchImpl }), { query: "q" });
  assert.ok(one.includes(`${"あ".repeat(WEB_SEARCH_EXCERPT_MAX_LENGTH)}…`), "上限で切って … を付ける");
  assert.ok(!one.includes("あ".repeat(WEB_SEARCH_EXCERPT_MAX_LENGTH + 1)), "上限を超えて残っている");

  const many = stubFetch(() =>
    exaResults(
      Array.from({ length: 5 }, (_, index) => ({
        title: `T${index} ${"t".repeat(500)}`,
        url: `https://example.com/${index}`,
        highlights: ["h".repeat(4_000)],
      })),
    ),
  );
  const all = await run(tool({ fetchImpl: many.fetchImpl }), { query: "q" });
  assert.equal(all.length, WEB_SEARCH_OUTPUT_MAX_LENGTH);
  assert.ok(all.endsWith("... [truncated]"));
  assert.ok(all.startsWith("出典:\n"), "出典一覧は残す");
});

test("既定 provider が次の検索から使われ、キーは Authorization へ入る", async () => {
  // provider ごとに期待する応答の形が違う (Exa は JSON-RPC、Tavily は素の JSON)
  const stub = stubFetch((url) =>
    url === EXA_ENDPOINT
      ? exaResults([{ title: "T", url: "https://example.com" }])
      : responseOf(JSON.stringify({ results: [{ title: "T", url: "https://example.com" }] })),
  );
  // 実行のたびに読む (セッション作成時の値で凍結しない)
  let provider: WebSearchProviderId = "exa";
  const definition = tool({
    fetchImpl: stub.fetchImpl,
    readProvider: () => provider,
    readApiKey: () => "tvly-secret",
  });

  assert.ok((await run(definition, { query: "q" })).includes("出典:"));
  assert.equal(stub.calls[0].url, EXA_ENDPOINT);

  provider = "tavily";
  assert.ok((await run(definition, { query: "q" })).includes("出典:"));
  assert.equal(stub.calls[1].url, TAVILY_ENDPOINT);
  const headers = stub.calls[1].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tvly-secret");
  assert.deepEqual(JSON.parse(String(stub.calls[1].init.body)), {
    query: "q",
    search_depth: "basic",
    max_results: 5,
  });
});

test("provider が失敗しても他の provider へは暗黙に fallback しない", async () => {
  const stub = stubFetch(() => responseOf("upstream detail", { status: 500 }));
  const error = await rejection(
    run(tool({ fetchImpl: stub.fetchImpl, readProvider: () => "tavily", readApiKey: () => "k" }), { query: "q" }),
  );
  assert.equal(error.message, WEB_SEARCH_PROVIDER_ERROR_MESSAGE);
  assert.equal(stub.calls.length, 1, "別 provider で再検索しない");
  assert.equal(stub.calls[0].url, TAVILY_ENDPOINT);
  assert.ok(!stub.calls.some((call) => call.url === EXA_ENDPOINT));
});

test("キーが未設定 / 拒否されたときは固定文言で失敗し、上流へは送らない", async () => {
  const stub = stubFetch(() => responseOf("upstream detail", { status: 401 }));
  let apiKey: string | undefined;
  const definition = tool({ fetchImpl: stub.fetchImpl, readProvider: () => "tavily", readApiKey: () => apiKey });

  const missing = await rejection(run(definition, { query: "q" }));
  assert.equal(missing.message, WEB_SEARCH_KEY_MISSING_MESSAGE);
  assert.equal(stub.calls.length, 0, "キー無しの Authorization を送らない");

  apiKey = "tvly-secret";
  const rejected = await rejection(run(definition, { query: "q" }));
  assert.equal(rejected.message, WEB_SEARCH_KEY_REJECTED_MESSAGE);
  assert.equal(stub.calls.length, 1);
  assert.ok(!rejected.message.includes("tvly-secret"));
});

test("失敗の種類は固定文言へ写し、上流の本文を出さない", async () => {
  const exaRateLimited = stubFetch(() =>
    responseOf(
      JSON.stringify(
        jsonRpcResponse({}, { _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text: "slow down" }] }),
      ),
    ),
  );
  const rateLimited = await rejection(run(tool({ fetchImpl: exaRateLimited.fetchImpl }), { query: "q" }));
  assert.equal(rateLimited.message, WEB_SEARCH_RATE_LIMITED_MESSAGE);

  const quota = stubFetch(() =>
    responseOf(JSON.stringify({ detail: { error: "plan limit detail" } }), { status: 432 }),
  );
  const quotaError = await rejection(
    run(tool({ fetchImpl: quota.fetchImpl, readProvider: () => "tavily", readApiKey: () => "k" }), { query: "q" }),
  );
  assert.equal(quotaError.message, WEB_SEARCH_QUOTA_EXCEEDED_MESSAGE);
  assert.ok(!quotaError.message.includes("plan limit detail"));

  const unexpected = stubFetch(() => responseOf(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } })));
  const unexpectedError = await rejection(run(tool({ fetchImpl: unexpected.fetchImpl }), { query: "q" }));
  assert.equal(unexpectedError.message, WEB_SEARCH_UNEXPECTED_RESPONSE_MESSAGE);
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
  const stub = stubFetch(() => exaResults([]));
  assert.equal(await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" }), WEB_SEARCH_NO_RESULTS_MESSAGE);
  assert.equal(formatWebSearchResults([], createMutableSecretMasker([])), WEB_SEARCH_NO_RESULTS_MESSAGE);
});

test("秘密値は 1 件の切り詰めより先にマスクし、throw の文言もマスクする", async () => {
  const secret = "sk-live-secret-value-0123456789";
  const masker = createMutableSecretMasker([secret]);
  // 抜粋の上限の位置に秘密値の先頭が乗る。マスクが後だと完全一致で拾えない断片が残る
  const excerpt = `${"x".repeat(1_480)}${secret}${"y".repeat(100)}`;
  const stub = stubFetch(() => exaResults([{ title: "T", url: "https://example.com", highlights: [excerpt] }]));
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
  const stub = stubFetch(() => exaResults([{ title: "T", url: "https://example.com" }]));
  // 実行のたびに読む (セッション作成時の値で凍結しない)
  let enabled = false;
  const definition = tool({ fetchImpl: stub.fetchImpl, readEnabled: () => enabled });

  const off = await rejection(run(definition, { query: "q" }));
  assert.equal(off.message, WEB_SEARCH_DISABLED_MESSAGE);
  assert.equal(stub.calls.length, 0, "無効の間は上流へ送らない");

  // 同じ定義 (= 既存セッションのツール) のまま ON へ戻すと動く
  enabled = true;
  assert.ok((await run(definition, { query: "q" })).includes("出典:"), "ON に戻すと同じ定義で検索できる");
  assert.equal(stub.calls.length, 1);

  enabled = false;
  const offAgain = await rejection(run(definition, { query: "q" }));
  assert.equal(offAgain.message, WEB_SEARCH_DISABLED_MESSAGE);
  assert.equal(stub.calls.length, 1, "OFF へ戻すと再び送らなくなる");
});

test("readEnabled を渡さない既定は有効、readProvider を渡さない既定は Exa", async () => {
  const stub = stubFetch(() => exaResults([{ title: "T", url: "https://example.com" }]));
  assert.ok((await run(tool({ fetchImpl: stub.fetchImpl }), { query: "q" })).includes("出典:"));
  assert.equal(stub.calls[0].url, EXA_ENDPOINT);
  assert.equal(stub.calls.length, 1);
});

test("設定を読めないときは上流へ送らずに固定文言で失敗する", async () => {
  const stub = stubFetch(() => {
    throw new Error("fetch が呼ばれました");
  });
  const error = await rejection(
    run(
      tool({
        fetchImpl: stub.fetchImpl,
        readProvider: () => {
          throw new Error("db boom");
        },
      }),
      { query: "q" },
    ),
  );
  assert.equal(error.message, WEB_SEARCH_SETTINGS_UNAVAILABLE_MESSAGE);
  assert.equal(stub.calls.length, 0);
});
