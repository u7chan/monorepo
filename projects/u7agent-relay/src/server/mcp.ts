import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { AdminError, UpstreamError } from "./errors";
import { readBearer } from "./keys";
import type { AuthenticatedKey, Relay } from "./relay";

/** 上流の本文上限に合わせる。`/v1/messages` と同じ値で、MCP からだけ緩めない。 */
const MAX_TEXT_LENGTH = 20_000;

export type McpDeps = {
  relay: Relay;
  version: string;
  /** ブラウザからの要求を許すオリジン。未設定なら Origin 付きの要求はすべて拒否する。 */
  appOrigin?: string | null;
};

/**
 * MCP の Streamable HTTP 入口。`/v1` の置き換えではなく、同じサービス層を呼ぶ 2 つ目の入口にする。
 * stateless で動かし、キーと会話の対応は毎リクエストの Bearer から引き直す。
 */
export function createMcpHandler(deps: McpDeps) {
  return async (c: Context): Promise<Response> => {
    // ブラウザからは叩かせない。Origin を持たない CLI / ボットだけを通し、DNS rebinding を塞ぐ。
    if (!isAllowedOrigin(c.req.header("origin") ?? null, deps.appOrigin ?? null)) {
      return c.json({ error: "origin_mismatch" as const }, 403);
    }

    // stateless ではセッション単位の SSE を持たない。GET を通すと閉じない stream になる。
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0" as const, error: { code: -32000, message: "Method Not Allowed" }, id: null }, 405);
    }

    const token = readBearer(c.req.header("authorization"));
    const authenticated = token ? deps.relay.authenticate(token) : null;

    if (!authenticated) {
      c.header("WWW-Authenticate", "Bearer");

      return c.json({ error: "unauthorized" as const }, 401);
    }

    // 要求ごとに作り直す。前の要求の状態を残すと、キーをまたいだ使い回しが起きうる。
    const server = createMcpServer(deps.version, deps.relay, authenticated);
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    try {
      return (await transport.handleRequest(c)) ?? c.body(null, 202);
    } catch (error) {
      // transport は Accept / Content-Type の不備を HTTPException で返す。app の onError は中継の code だけを扱う。
      if (error instanceof HTTPException) {
        return error.getResponse();
      }

      throw error;
    } finally {
      await transport.close();
    }
  };
}

function createMcpServer(version: string, relay: Relay, authenticated: AuthenticatedKey): McpServer {
  const { keyId, connection } = authenticated;
  const server = new McpServer({ name: "u7agent-relay", version });

  server.registerTool(
    "submit_task",
    {
      title: "u7agent に依頼を投稿する",
      description:
        "固定した会話へ依頼を投稿する。実行は非同期なので、返った runId を get_task で照会する。" +
        "409 session_busy は会話が実行中か回答待ちで、投稿は受理されていない。再送せず get_task で待つ。",
      inputSchema: {
        text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("会話へ送る本文。"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text }) => call(() => relay.post(connection, keyId, text)),
  );

  server.registerTool(
    "get_task",
    {
      title: "実行結果を取得する",
      description:
        "runId の実行結果を返す。running / awaiting_answer の間は間隔を空けて呼ぶ。" +
        "awaiting_answer は人間が会話を開いて答える必要があり、待ち続けても進まない。" +
        "completed の files は path と kind の一覧で、実体は relay の HTTP API から取得する。",
      inputSchema: {
        runId: z.string().min(1).max(64).describe("submit_task が返した runId。"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ runId }) => call(() => relay.reply(connection, keyId, runId)),
  );

  return server;
}

/** `/v1` と同じ payload をそのまま返す。MCP 側だけ別の形にすると、2 つの入口で意味がずれる。 */
async function call(fn: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
  } catch (error) {
    // コード文字列は HTTP 側と共通にする。MCP の transport error にせず、ツール結果として返す。
    if (error instanceof AdminError || error instanceof UpstreamError) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.code }) }], isError: true };
    }

    throw error;
  }
}

/** Origin を持たない要求（CLI / ボット）だけを通す。設定したオリジンだけは同一 origin として許可する。 */
function isAllowedOrigin(origin: string | null, appOrigin: string | null): boolean {
  return origin === null || (appOrigin !== null && origin === appOrigin);
}
