/**
 * サンドボックス ツール実行サービス (HTTP)。
 *
 * pi SDK の作業用ツール (bash / read / edit / write / grep / find / ls) を
 * このプロセス内のローカル実装で実行し、結果を NDJSON ストリームで返す。
 * BFF はこのAPIだけを経由してツールを実行し、自前のローカル実行へ
 * フォールバックしない。LLM 認証情報はこのプロセスへ渡さない (環境変数の
 * 許可リストはデプロイ側の責務。このサービスは Bearer トークンのみを要求する)。
 *
 * 認証: すべての /v1/* に `Authorization: Bearer <PI_SANDBOX_TOKEN>` を要求し、
 * 未認証要求は 401 で拒否する。/healthz は Compose healthcheck 用で無認証
 * (ツール実行の情报を含まない)。
 */
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import {
  SANDBOX_MAX_BODY_BYTES,
  encodeSandboxEvent,
  type SandboxExecuteRequestBody,
  type SandboxEvent,
} from "./protocol";

/** サンドボックスが提供する作業用ツール一覧 (bash のみローカル出力をストリームする)。 */
export const SANDBOX_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ExecuteUpdateCallback = NonNullable<Parameters<AnyToolDefinition["execute"]>[3]>;

export interface SandboxServiceOptions {
  /** Bearer トークン (空や短すぎる値は起動側で弾く。ここでは二重確認する)。 */
  token: string;
  /** ツール実行の既定 cwd (サンドボックス内の作業領域)。 */
  rootCwd?: string;
}

export interface SandboxService {
  app: Hono;
  /** 実行中の executionId → AbortController (診断・テスト用)。 */
  executions: Map<string, AbortController>;
  /** 全実行を中断して終了する (shutdown 用)。 */
  close: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 長さを漏らさない定数時間比較 (sha256 で同じ長さに揃える)。 */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** toolCallId として妥当な文字列か (対応付けのキーにだけ使う任意値)。 */
function normalizeToolCallId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

/** ボディを上限付きで読み、JSON として解釈する。 */
async function readJsonBody(request: Request): Promise<unknown> {
  const body = request.body;
  if (!body) return {};
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SANDBOX_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return parsed;
}

/**
 * ツール実行サービスを構築する。listen は呼び出し側 (@hono/node-server) が
 * 行い、テストは app.request() で検証する。
 */
export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const token = options.token;
  if (!token || token.trim().length < 16) {
    throw new Error("PI_SANDBOX_TOKEN must be set to a non-trivial value (16+ chars)");
  }
  const rootCwd = options.rootCwd || "/workspace";

  // SDK のツール実装をこのプロセスの実ファイルシステムに対して使う。
  // bash はセッション環境変数 (PI_SESSION_ID 等) を注入しない — サンドボックスに
  // セッションはなく、BFF のモデル/セッション情報を子プロセスへ渡さない。
  // SDK の bash は process.env を子プロセスへ継承する。サンドボックス内の唯一の
  // 秘密値は共有トークンなので、spawnHook で剥がしてツール出力へ現れないようにする
  // (セッションメタ変数 PI_* は exposeSessionEnvironment: false が除外する)。
  const stripSandboxToken = (context: BashSpawnContext): BashSpawnContext => {
    const env: NodeJS.ProcessEnv = { ...context.env };
    delete env.PI_SANDBOX_TOKEN;
    return { ...context, env };
  };

  const definitions: AnyToolDefinition[] = [
    createBashToolDefinition(rootCwd, {
      exposeSessionEnvironment: false,
      spawnHook: stripSandboxToken,
    }),
    createReadToolDefinition(rootCwd),
    createEditToolDefinition(rootCwd),
    createWriteToolDefinition(rootCwd),
    createGrepToolDefinition(rootCwd),
    createFindToolDefinition(rootCwd),
    createLsToolDefinition(rootCwd),
  ];
  const registry = new Map<string, AnyToolDefinition>(definitions.map((def) => [def.name, def]));

  const executions = new Map<string, AbortController>();

  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      tools: [...registry.keys()],
      cwd: rootCwd,
      runningExecutions: executions.size,
    });
  });

  // /v1/* は Bearer 認証を要求する (未認証要求はここで 401 になる)。
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !tokensEqual(match[1], token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.post("/v1/tools/:tool/execute", async (c) => {
    const toolName = c.req.param("tool") ?? "";
    const definition = registry.get(toolName);
    if (!definition) {
      return c.json({ error: `Unknown tool: ${toolName}` }, 404);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      return c.json({ error: messageFor(error) }, statusCode as 400);
    }
    const { toolCallId, params } = (body ?? {}) as SandboxExecuteRequestBody;
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return c.json({ error: "params must be an object" }, 400);
    }
    const executionId = randomUUID();
    const abort = new AbortController();
    executions.set(executionId, abort);

    const encoder = new TextEncoder();
    let closed = false;
    const write = (event: SandboxEvent): boolean => {
      if (closed) return false;
      try {
        controller.enqueue(encoder.encode(encodeSandboxEvent(event)));
        return true;
      } catch {
        return false;
      }
    };

    // クライアント切断 (BFF 死亡・cancel 前の abort) でも実行を止める。
    const signal = c.req.raw.signal;
    const onClientAbort = () => abort.abort();
    signal?.addEventListener("abort", onClientAbort, { once: true });

    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        void (async () => {
          write({ type: "start", executionId });
          const onUpdate: ExecuteUpdateCallback = (payload) => {
            write({ type: "update", payload: { content: payload?.content, details: payload?.details } });
          };
          try {
            const ctx = { cwd: rootCwd } as Parameters<AnyToolDefinition["execute"]>[4];
            const result = await definition.execute(
              normalizeToolCallId(toolCallId),
              (params ?? {}) as Record<string, never>,
              abort.signal,
              onUpdate,
              ctx,
            );
            write({
              type: "result",
              payload: {
                content: result?.content ?? [],
                details: result?.details,
              },
            });
          } catch (error) {
            write({ type: "error", message: messageFor(error) });
          } finally {
            executions.delete(executionId);
            signal?.removeEventListener("abort", onClientAbort);
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed by cancel()
            }
          }
        })();
      },
      cancel() {
        // BFF がストリームを読み捨てた (切断・abort) 場合も実行を止める。
        closed = true;
        abort.abort();
        executions.delete(executionId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.post("/v1/executions/:id/cancel", (c) => {
    const id = c.req.param("id") ?? "";
    const abort = executions.get(id);
    if (!abort) {
      return c.json({ error: "Execution not found" }, 404);
    }
    abort.abort();
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return {
    app,
    executions,
    close: () => {
      for (const abort of executions.values()) abort.abort();
      executions.clear();
    },
  };
}
