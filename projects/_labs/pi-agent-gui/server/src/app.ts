// BFF アプリケーション本体 (port of src/server.js)。
// 起動 (listen) は src/index.ts が担い、テストは app.request() で行う。

import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import { AUTH_REQUIRED_MESSAGE, createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { createAgentCatalog } from "./agents";
import { SessionStore } from "./sessions";
import {
  CreateSessionBodySchema,
  PostMessageBodySchema,
  ReplaceCatalogBodySchema,
  UpdateSessionSettingsBodySchema,
} from "./schema";

// client は "server" (本ファイル) を型ソースとして import type するため DTO 型を再配布する
export * from "./schema";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CLIENT_DIST_DIR = resolve(ROOT_DIR, "client", "dist");
const MAX_BODY_BYTES = 64 * 1024;
// port 元 src/server.js の HTTP 層と同じ 20_000 (sessions 側の上限は別)
const MAX_MESSAGE_CHARS = 20_000;
const SSE_HEARTBEAT_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const STATIC_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  return undefined;
}

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message);
  (error as { statusCode?: number }).statusCode = statusCode;
  return error;
}

function modelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

/** port 元 readJson 相当: 空ボディは {} として扱い、壊れた JSON は 400。 */
async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

/** port 元 readJson のバイト数上限チェック相当。body を先頭から読みながら上限を見る。 */
async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw httpError(413, "Request body is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * /api/* の POST/PATCH/PUT に適用するボディガード。
 * 読み取ったテキストを Hono の bodyCache に戻すことで、後段の
 * zValidator / readJsonBody にボディの再読み込みを許す。
 */
async function bodyGuard(c: Context, next: () => Promise<void>) {
  const method = c.req.method;
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "Request body is too large" }, 413);
    }
    const text = await readBodyText(c.req.raw, MAX_BODY_BYTES);
    // 空ボディは port 元 readJson と同じく {} として扱う。
    // bodyCache の型は解決後の値だがランタイムは Promise を期待するため型を吐く。
    (c.req.bodyCache as { text?: unknown }).text = Promise.resolve(text.trim() ? text : "{}");
  }
  await next();
}

export type CreateBffAppOptions = {
  cwd?: string;
  /** テストは明示的な pi (null も含む) を渡してランタイム構築をスキップする */
  pi?: PiBff | null;
  /** テスト用: 静的配信のルートディレクトリ (既定は client/dist) */
  clientDistDir?: string;
};

export async function createBffApp(opts: CreateBffAppOptions = {}) {
  const { cwd = process.cwd(), clientDistDir = DEFAULT_CLIENT_DIST_DIR } = opts;
  const injectedPi = opts.pi;
  let pi: PiBff | null = injectedPi ?? null;
  let initError: string | undefined;
  // Tests pass an explicit `pi` (possibly null) to skip runtime setup.
  if (injectedPi === undefined) {
    try {
      pi = await createPiBff({ cwd });
    } catch (error) {
      initError = messageFor(error);
      console.error(`[pi-agent-gui] Pi runtime unavailable: ${initError}`);
    }
  }

  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi, catalog });

  const updateAgentHandler = async (c: Context) => {
    const agentId = c.req.param("id") ?? "";
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const agent = catalog.updateAgent(agentId, body);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({ agent });
  };

  const updateSkillHandler = async (c: Context) => {
    const skillId = c.req.param("id") ?? "";
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const skill = catalog.updateSkill(skillId, body);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json({ skill });
  };

  const findSession = (c: Context) => store.get(c.req.param("id") ?? "");

  const stopSessionHandler = async (c: Context) => {
    const record = findSession(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    const result = await store.stop(record);
    return c.json({ sessionId: record.id, ...result });
  };

  const app = new Hono()
  .use("/api/*", bodyGuard)

  // --- health ---

  .get("/api/health", (c) => {
    // ready は「runtime が使え、利用可能モデルが 1 つ以上ある」の意。
    // 明示 PI_MODEL が使えるかどうかとは分離する (defaultModelError)。
    const availableModels = pi?.availableModels ?? [];
    const ready = Boolean(pi) && availableModels.length > 0;
    const authRequired = Boolean(pi && !ready && pi.availabilityError === AUTH_REQUIRED_MESSAGE);
    const errorCode: "authentication_required" | "runtime_unavailable" | undefined = authRequired
      ? "authentication_required"
      : initError || (pi && !ready)
        ? "runtime_unavailable"
        : undefined;
    return c.json({
      ok: true,
      ready,
      cwd: pi?.cwd || resolve(cwd),
      model: modelLabel(pi?.selectedModel),
      availableModels:
        availableModels.map(modelLabel).filter((m): m is string => m != null),
      modelOptions: pi?.modelOptions ?? [],
      defaultThinkingLevel: pi?.defaultThinkingLevel ?? "medium",
      defaultModelError: pi?.defaultModelError,
      tools: pi?.tools || [],
      availabilityError: pi?.availabilityError,
      errorCode,
      error: initError ?? (authRequired ? AUTH_REQUIRED_MESSAGE : pi?.availabilityError),
    });
  })
  .get("/api/agents", (c) => c.json(catalog.snapshot()))
  .put(
    "/api/agents",
    zValidator("json", ReplaceCatalogBodySchema, (result, c) =>
      result.success
        ? undefined
        : c.json({ error: "Definitions must contain skills and agents arrays" }, 400),
    ),
    (c) => {
      const body = c.req.valid("json");
      return c.json(catalog.replace(body));
    },
  )
  .post("/api/agents", async (c) => {
    // catalog 側の正規化・日本語エラー文言が正なので body は pass-through
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    return c.json({ agent: catalog.createAgent(body) }, 201);
  })
  .patch("/api/agents/:id", updateAgentHandler)
  .put("/api/agents/:id", updateAgentHandler)

  .delete("/api/agents/:id", (c) => {
    if (!catalog.removeAgent(c.req.param("id") ?? "")) {
      return c.json({ error: "Agent cannot be deleted (or it is the last agent)" }, 400);
    }
    return c.json({ ok: true });
  })
  .get("/api/skills", (c) => c.json({ skills: catalog.listSkills() }))
  .post("/api/skills", async (c) => {
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    return c.json({ skill: catalog.createSkill(body) }, 201);
  })
  .patch("/api/skills/:id", updateSkillHandler)
  .put("/api/skills/:id", updateSkillHandler)

  .delete("/api/skills/:id", (c) => {
    if (!catalog.removeSkill(c.req.param("id") ?? "")) {
      return c.json({ error: "Skill not found" }, 404);
    }
    return c.json({ ok: true });
  })
  .get("/api/sessions", (c) => c.json({ sessions: store.list() }))
  .post(
    "/api/sessions",
    zValidator("json", CreateSessionBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "Invalid request body" }, 400),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const record = await store.create({
        agentId: body.agentId,
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      return c.json(store.payload(record), 201);
    },
  )
  .patch(
    "/api/sessions/:id/settings",
    zValidator("json", UpdateSessionSettingsBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "Invalid session settings" }, 400),
    ),
    async (c) => {
      const record = findSession(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      if (body.model === undefined && body.thinkingLevel === undefined) {
        return c.json({ error: "model or thinkingLevel is required" }, 400);
      }
      const payload = await store.updateSettings(record, {
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      return c.json(payload);
    },
  )
  .get("/api/sessions/:id", (c) => {
    const record = findSession(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    return c.json(store.payload(record));
  })
  .delete("/api/sessions/:id", async (c) => {
    const record = findSession(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    await store.destroy(record);
    return c.json({ ok: true });
  })
  .post("/api/sessions/:id/stop", stopSessionHandler)
  .post("/api/sessions/:id/abort", stopSessionHandler)

  .post(
    "/api/sessions/:id/messages",
    zValidator("json", PostMessageBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "text is required" }, 400),
    ),
    async (c) => {
      const record = findSession(c);
      if (!record) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      const text = body.text.trim();
      if (!text) return c.json({ error: "text is required" }, 400);
      if (text.length > MAX_MESSAGE_CHARS) {
        return c.json(
          { error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` },
          413,
        );
      }
      // Returns immediately; the run (or the queued position) is managed in
      // the background by the SessionStore.
      const result = store.postMessage(record, text);
      return c.json({ sessionId: record.id, status: store.statusOf(record), ...result }, 202);
    },
  )
  .get("/api/sessions/:id/events", (c) => {
    const record = findSession(c);
    if (!record) return c.json({ error: "Session not found" }, 404);
    // Last-Event-ID ヘッダを優先し、なければ ?after= (port 元と同じ優先順位)
    const lastEventId = c.req.header("Last-Event-ID");
    const rawAfter = lastEventId ?? c.req.query("after");
    const parsedAfter = Number.parseInt(rawAfter ?? "", 10);
    const after = Number.isNaN(parsedAfter) ? undefined : parsedAfter;

    return withSseHeaders(
      streamSSE(c, async (stream) => {
        let requestCleanup: () => void = () => {};
        stream.onAbort(() => requestCleanup());
        await stream.write(": connected\n\n");
        if (stream.aborted) return;
        const unsubscribe = store.subscribe(
          record,
          after,
          (entry) => {
            void stream.writeSSE({
              id: String(entry.seq),
              event: entry.type,
              data: JSON.stringify(entry.data),
            });
          },
          () => requestCleanup(),
        );
        const heartbeat = setInterval(() => {
          void stream.write(": ping\n\n");
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
        // 切断 (onAbort) と store の close コールバックのどちらでも
        // unsubscribe + clearInterval してからストリームを終了する。
        await new Promise<void>((resolveCleanup) => {
          requestCleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
            resolveCleanup();
          };
        });
      }),
    );
  })
  .get("*", async (c) => {
    let pathname = c.req.path;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    const response = await serveStaticPath(pathname, clientDistDir);
    return response ?? c.json({ error: "Not found" }, 404);
  })
  .notFound((c) => c.json({ error: "Not found" }, 404))
  .onError((error, c) => {
    // hono validator の JSON パース失敗 (HTTPException 400) は契約書の文言に寄せる
    if (error instanceof HTTPException && error.status === 400) {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    return c.json(
      { error: messageFor(error) },
      (statusCodeOf(error) ?? 500) as ContentfulStatusCode,
    );
  });
  return {
    app,
    store,
    catalog,
    pi,
    initError,
    close: async () => {
      await store.close();
    },
  };
}

export type AppType = Awaited<ReturnType<typeof createBffApp>>["app"];

/** SSE 用ヘッダを契約書どおりに上書きする (streamSSE は charset 等を設定しないため) */
function withSseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

/** 未ビルドの案内 (port 元 clientBuildMissing) */
function clientBuildMissingResponse(): Response {
  return new Response("Client build missing. Run: pnpm build", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": STATIC_CSP,
    },
  });
}

/** port 元 serveStatic 相当。配信できなければ null (呼び出し元が 404 を返す)。 */
async function serveStaticPath(pathname: string, clientDistDir: string): Promise<Response | null> {
  if (pathname !== "/" && !pathname.startsWith("/")) return null;
  // "/" と "/index.html" は Vite のエントリに、それ以外は client/dist 内の
  // ファイルパスに解決する。
  const relativePath = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  const filePath = resolve(clientDistDir, relativePath);
  // Traversal guard: client/dist の外は絶対に配信しない。
  if (filePath !== clientDistDir && !filePath.startsWith(clientDistDir + sep)) return null;

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch (error) {
    // ビルド産物が無い（未ビルド）場合は案内を出し、それ以外は従来どおり 404。
    const code = (error as NodeJS.ErrnoException).code;
    if (relativePath === "index.html" && (code === "ENOENT" || code === "ENOTDIR")) {
      return clientBuildMissingResponse();
    }
    return null;
  }

  // Vite はハッシュ付きファイルを assets/ 配下に出すため長期キャッシュ、
  // それ以外（index.html や public/ 由来のファイル）は no-cache。
  const isHashedAsset = relativePath.startsWith("assets/");
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": STATIC_CSP,
    },
  });
}
