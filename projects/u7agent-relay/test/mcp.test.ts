// MCP 入口の契約。`/v1` と同じサービス層を呼び、認証と Origin の扱いだけが違うことを固定する。
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "../src/server/upstream";
import {
  bearer,
  createHarness,
  jsonResponse,
  RUN_ID,
  SESSION_ID,
  SPACE_ID,
  seedConnection,
  type Harness,
} from "./harness";

type Call = { url: string; method: string; body: string | null };

function createUpstream() {
  const calls: Call[] = [];
  let session: Record<string, unknown> = {
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    status: "idle",
    queueDepth: 0,
    messages: [],
  };
  let accepted: unknown = { sessionId: SESSION_ID, queued: false, runId: RUN_ID };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";

    calls.push({ url: String(input), method, body: typeof init?.body === "string" ? init.body : null });

    return method === "GET" ? jsonResponse(session) : jsonResponse(accepted, 202);
  };

  return {
    calls,
    fetchImpl,
    setSession(next: Record<string, unknown>) {
      session = next;
    },
  };
}

async function setup(fetchImpl: FetchLike): Promise<Harness> {
  return createHarness({ fetchImpl });
}

/** SDK のクライアントを Hono の app へ直結する。実クライアントの handshake を通すのが目的。 */
async function connect(harness: Harness, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://relay.test/mcp"), {
    fetch: async (input, init) => await harness.app.request(String(input), init as RequestInit),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "mcp-test", version: "0.0.0" });

  await client.connect(transport);

  return client;
}

/** ツール結果の本文は JSON 文字列 1 件に固定している。 */
function payload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];

  if (first?.type !== "text") {
    throw new Error("text content を期待しました");
  }

  return JSON.parse(first.text);
}

describe("MCP 入口", () => {
  test("Bearer が無い要求とブラウザからの要求は上流へ行かない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

      const anonymous = await harness.app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");

      const browser = await harness.app.request("/mcp", {
        method: "POST",
        headers: { ...bearer(token), Origin: "http://evil.example" },
        body,
      });

      expect(browser.status).toBe(403);

      // 中継自身のオリジンでも同じ。MCP はブラウザから叩ける入口にしない。
      const sameOrigin = await harness.app.request("/mcp", {
        method: "POST",
        headers: { ...bearer(token), Origin: "http://localhost" },
        body,
      });

      expect(sameOrigin.status).toBe(403);
      expect(upstream.calls).toHaveLength(0);
    } finally {
      harness.cleanup();
    }
  });

  test("GET は受け付けない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const response = await harness.app.request("/mcp", { headers: bearer(token) });

      expect(response.status).toBe(405);
    } finally {
      harness.cleanup();
    }
  });

  test("クライアントが initialize してツール一覧を取得できる", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const client = await connect(harness, token);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual(["submit_task", "get_task"]);
      expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

      await client.close();
    } finally {
      harness.cleanup();
    }
  });

  test("submit_task と get_task で 1 往復できる", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const client = await connect(harness, token);

      const submitted = await client.callTool({ name: "submit_task", arguments: { text: "  調べて  " } });

      expect(payload(submitted)).toEqual({ runId: RUN_ID });
      expect(upstream.calls[1]?.body).toBe(JSON.stringify({ text: "調べて" }));

      upstream.setSession({
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        status: "completed",
        queueDepth: 0,
        run: { id: RUN_ID, status: "completed" },
        messages: [{ role: "assistant", text: "最終応答", assistantId: `${RUN_ID}:0` }],
      });

      const replied = await client.callTool({ name: "get_task", arguments: { runId: RUN_ID } });

      expect(payload(replied)).toEqual({ status: "completed", text: "最終応答", files: [] });

      await client.close();
    } finally {
      harness.cleanup();
    }
  });

  test("本文の長さと空文字は /v1 と同じ判定になる", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const client = await connect(harness, token);

      // trim 後の長さで判定する。ちょうど上限 + 改行は /v1 と同じく受理する。
      const accepted = await client.callTool({
        name: "submit_task",
        arguments: { text: `${"a".repeat(20_000)}\n` },
      });

      expect(payload(accepted)).toEqual({ runId: RUN_ID });

      const tooLarge = await client.callTool({ name: "submit_task", arguments: { text: "a".repeat(20_001) } });

      expect(tooLarge.isError).toBe(true);
      expect(payload(tooLarge)).toEqual({ error: "message_too_large" });

      const blank = await client.callTool({ name: "submit_task", arguments: { text: "   " } });

      expect(blank.isError).toBe(true);
      expect(payload(blank)).toEqual({ error: "text_required" });

      await client.close();
    } finally {
      harness.cleanup();
    }
  });

  test("実行中の会話への投稿は session_busy を isError で返す", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { token } = seedConnection(harness);
      const client = await connect(harness, token);

      upstream.setSession({ sessionId: SESSION_ID, spaceId: SPACE_ID, status: "running", queueDepth: 1 });

      const result = await client.callTool({ name: "submit_task", arguments: { text: "調べて" } });

      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({ error: "session_busy" });

      await client.close();
    } finally {
      harness.cleanup();
    }
  });

  test("同じ接続先でも、別のキーが発行した実行は読めない", async () => {
    const upstream = createUpstream();
    const harness = await setup(upstream.fetchImpl);

    try {
      const { connectionId, token } = seedConnection(harness);
      const other = harness.keys.create({ name: "別キー", connectionId }).token;
      const client = await connect(harness, other);

      const submitted = await harness.app.request("/v1/messages", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ text: "調べて" }),
      });

      expect(submitted.status).toBe(202);

      const result = await client.callTool({ name: "get_task", arguments: { runId: RUN_ID } });

      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({ error: "run_not_found" });

      await client.close();
    } finally {
      harness.cleanup();
    }
  });
});
