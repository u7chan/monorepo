import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthService } from "./auth";
import type { CookieSecureMode } from "./config";
import type { ConnectionService, KeyService } from "./connections";
import { parseName } from "./connections";
import type { Store } from "./db";
import { AdminError, UpstreamError } from "./errors";
import { readBearer } from "./keys";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import type { Relay } from "./relay";
import { clearSessionCookie, sessionCookie } from "./session";

/** 中継する本文の上限。上流の 20,000 文字に余白を足した JSON が収まる大きさ。 */
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 20_000;
/** 管理画面の入力は名前と URL だけ。 */
const MAX_ADMIN_BODY_BYTES = 16 * 1024;
/** 6 桁 PIN の JSON には十分で、これ以上は壊れた入力として扱う。 */
const MAX_AUTH_BODY_BYTES = 1024;

/**
 * API は JSON しか返さないので、読み込みも実行もさせない。文書の CSP は index.html の meta で指定する
 * （Bun の HTML ルートはハンドラを通らず、応答ヘッダーを足せないため）。
 */
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

export type AppDeps = {
  auth: AuthService;
  store: Store;
  relay: Relay;
  connections: ConnectionService;
  keys: KeyService;
  version: string;
  now?: () => number;
  rateLimiter?: RateLimiter;
  clientKey?: (c: Context) => string;
  /** 前段の TLS 終端を信頼し、X-Forwarded-* を読むか。既定は読まない。 */
  trustProxy?: boolean;
  /** auto は要求が HTTPS のとき、always は常に cookie へ Secure を付ける。 */
  cookieSecure?: CookieSecureMode;
  appOrigin?: string | null;
};

type AppEnv = { Variables: { clientKey: string } };

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const rateLimiter = deps.rateLimiter ?? createRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000, now });
  const trustProxy = deps.trustProxy ?? false;
  const cookieSecure = deps.cookieSecure ?? "auto";
  const clientKey = deps.clientKey ?? ((c: Context) => defaultClientKey(c, trustProxy));
  const secureCookie = (c: Context) => cookieSecure === "always" || requestIsSecure(c, trustProxy);
  const tooLarge = (c: Context) => c.json({ error: "invalid_request" as const }, 413);
  const app = new Hono<AppEnv>();

  // 認証が必要な管理 API。auth の設定が壊れているときはデータを返さず 503 にする。
  const requireSession = async (c: Context, next: () => Promise<void>) => {
    const status = deps.auth.status();

    if (status === "misconfigured") {
      return c.json({ error: "misconfigured" as const }, 503);
    }

    if (!deps.auth.readSession(c.req.header("cookie") ?? null)) {
      return c.json({ error: "unauthorized" as const }, 401);
    }

    await next();
  };

  app.use("*", async (c, next) => {
    await next();

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }
  });

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // bodyLimit は Request を作り直すため、接続元は書き換え前の Request で確定させる。
      c.set("clientKey", clientKey(c));

      // 状態を変える入口は同一 origin からの要求だけ受け付ける。Origin が無い要求 (curl など) も拒否する。
      if (!isSameOrigin(c, trustProxy, deps.appOrigin ?? null)) {
        return c.json({ error: "origin_mismatch" as const }, 403);
      }
    }

    await next();
  });

  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");

    return c.text("u7agent-relay-ok\n", 200);
  });

  app.use("/v1/*", async (c, next) => {
    c.header("Cache-Control", "no-store");

    await next();
  });
  app.use("/messages", async (c, next) => {
    c.header("Cache-Control", "no-store");

    await next();
  });
  app.use("/replies/*", async (c, next) => {
    c.header("Cache-Control", "no-store");

    await next();
  });

  app.get("/api/auth/session", (c) => {
    const session = deps.auth.readSession(c.req.header("cookie") ?? null);

    if (session) {
      return c.json({ state: "authenticated" as const, expiresAt: session.expiresAt, version: deps.version });
    }

    return c.json({
      state: deps.auth.status() === "setup_required" ? ("setup_required" as const) : ("unauthenticated" as const),
      version: deps.version,
    });
  });

  app.post("/api/auth/setup", bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: tooLarge }), async (c) => {
    const pin = await readPinBody(c);

    if (pin === null) {
      return c.json({ error: "invalid_request" as const }, 400);
    }

    const result = await deps.auth.setup(pin);

    if (!result.ok) {
      switch (result.reason) {
        case "invalid_pin":
          return c.json({ error: "invalid_pin" as const }, 400);
        case "already_configured":
          return c.json({ error: "already_configured" as const }, 409);
        default:
          return c.json({ error: "misconfigured" as const }, 503);
      }
    }

    c.header("Set-Cookie", sessionCookie(result.token, { secure: secureCookie(c) }));

    return c.json({ state: "authenticated" as const }, 201);
  });

  app.post("/api/auth/login", bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: tooLarge }), async (c) => {
    const pin = await readPinBody(c);

    if (pin === null) {
      return c.json({ error: "invalid_request" as const }, 400);
    }

    const key = c.get("clientKey");

    return rateLimiter.exclusive(key, async () => {
      const retryAfterSeconds = rateLimiter.retryAfterSeconds(key);

      if (retryAfterSeconds !== null) {
        c.header("Retry-After", String(retryAfterSeconds));

        return c.json({ error: "rate_limited" as const, retryAfterSeconds }, 429);
      }

      const result = await deps.auth.login(pin);

      if (!result.ok) {
        switch (result.reason) {
          case "invalid_pin":
            rateLimiter.recordFailure(key);

            return c.json({ error: "invalid_pin" as const }, 401);
          case "setup_required":
            return c.json({ error: "setup_required" as const }, 409);
          default:
            return c.json({ error: "misconfigured" as const }, 503);
        }
      }

      rateLimiter.reset(key);
      c.header("Set-Cookie", sessionCookie(result.token, { secure: secureCookie(c) }));

      return c.json({ state: "authenticated" as const }, 200);
    });
  });

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearSessionCookie({ secure: secureCookie(c) }));

    return c.body(null, 204);
  });

  app.get("/api/state", requireSession, (c) =>
    c.json({
      version: deps.version,
      connections: deps.connections.list(),
      keys: deps.keys.list(),
      runs: deps.store.listRuns(50),
    }),
  );

  app.post(
    "/api/connections",
    requireSession,
    bodyLimit({ maxSize: MAX_ADMIN_BODY_BYTES, onError: tooLarge }),
    async (c) => {
      const body = await readJsonObject(c);

      if (!body) {
        return c.json({ error: "invalid_request" as const }, 400);
      }

      const connection = deps.connections.addFromUrl(
        parseName(body.name),
        typeof body.sessionUrl === "string" ? body.sessionUrl : "",
      );

      return c.json({ connection: deps.connections.view(connection) }, 201);
    },
  );

  app.post(
    "/api/connections/create",
    requireSession,
    bodyLimit({ maxSize: MAX_ADMIN_BODY_BYTES, onError: tooLarge }),
    async (c) => {
      const body = await readJsonObject(c);

      if (!body) {
        return c.json({ error: "invalid_request" as const }, 400);
      }

      const connection = await deps.connections.addByCreatingSession(
        parseName(body.name),
        typeof body.origin === "string" ? body.origin : "",
        typeof body.spaceId === "string" ? body.spaceId : "default",
      );

      return c.json({ connection: deps.connections.view(connection) }, 201);
    },
  );

  app.patch(
    "/api/connections/:id",
    requireSession,
    bodyLimit({ maxSize: MAX_ADMIN_BODY_BYTES, onError: tooLarge }),
    async (c) => {
      const body = await readJsonObject(c);

      if (!body) {
        return c.json({ error: "invalid_request" as const }, 400);
      }

      const connection = deps.connections.update(idParam(c), body);

      return c.json({ connection: deps.connections.view(connection) });
    },
  );

  app.delete("/api/connections/:id", requireSession, (c) => c.json(deps.connections.remove(idParam(c))));

  app.post("/api/connections/:id/check", requireSession, async (c) => c.json(await deps.connections.check(idParam(c))));

  app.post("/api/keys", requireSession, bodyLimit({ maxSize: MAX_ADMIN_BODY_BYTES, onError: tooLarge }), async (c) => {
    const body = await readJsonObject(c);

    if (!body) {
      return c.json({ error: "invalid_request" as const }, 400);
    }

    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    const result = deps.keys.create({ name: parseName(body.name), connectionId });

    return c.json(result, 201);
  });

  app.post("/api/keys/:id/revoke", requireSession, (c) => c.json({ key: deps.keys.revoke(idParam(c)) }));

  app.delete("/api/keys/:id", requireSession, (c) => {
    deps.keys.remove(idParam(c));

    return c.body(null, 204);
  });

  const postMessage = async (c: Context) => {
    const authenticated = authenticate(c);

    if (!authenticated) {
      return unauthorized(c);
    }

    const text = await readMessageBody(c);

    return c.json(await deps.relay.post(authenticated.connection, authenticated.keyId, text), 202);
  };

  const messageLimit = bodyLimit({ maxSize: MAX_MESSAGE_BYTES, onError: tooLarge });
  app.post("/v1/messages", messageLimit, postMessage);
  app.post("/messages", messageLimit, postMessage);

  const readReply = async (c: Context) => {
    const authenticated = authenticate(c);

    if (!authenticated) {
      return unauthorized(c);
    }

    return c.json(await deps.relay.reply(authenticated.connection, authenticated.keyId, c.req.param("runId") ?? ""));
  };

  app.get("/v1/replies/:runId", readReply);
  app.get("/replies/:runId", readReply);

  app.notFound((c) => c.json({ error: "not_found" as const }, 404));

  app.onError((error, c) => {
    if (error instanceof AdminError) {
      return c.json({ error: error.code }, error.status as ContentfulStatusCode);
    }

    if (error instanceof UpstreamError) {
      return c.json({ error: error.code }, error.status as ContentfulStatusCode);
    }

    if (!(error instanceof Error) || error.message !== "Malformed JSON in request body") {
      console.error("[u7agent-relay]", error);
    }

    return c.json({ error: "internal_error" as const }, 500);
  });

  function authenticate(c: Context) {
    const token = readBearer(c.req.header("authorization"));

    return token ? deps.relay.authenticate(token) : null;
  }

  return app;
}

function idParam(c: Context): string {
  return c.req.param("id") ?? "";
}

function unauthorized(c: Context) {
  c.header("WWW-Authenticate", 'Bearer realm="u7agent-relay"');

  return c.json({ error: "unauthorized" as const }, 401);
}

async function readMessageBody(c: Context): Promise<string> {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AdminError(415, "json_required");
  }

  const body = await readJsonObject(c);

  if (!body || Object.keys(body).length !== 1 || typeof body.text !== "string") {
    throw new AdminError(400, "text_required");
  }

  const text = body.text.trim();

  if (text.length === 0) {
    throw new AdminError(400, "text_required");
  }

  if (text.length > MAX_TEXT_LENGTH) {
    throw new AdminError(413, "message_too_large");
  }

  return text;
}

async function readPinBody(c: Context): Promise<string | null> {
  const body = await readJsonObject(c);

  return typeof body?.pin === "string" ? body.pin : null;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json();

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstForwarded(c: Context, name: string): string | null {
  const first = c.req.header(name)?.split(",")[0]?.trim();

  return first ? first : null;
}

/**
 * 直接公開している間はクライアントが X-Forwarded-* を偽装できる。TLS 終端を
 * 前段に置いた構成だけで読むよう、TRUST_PROXY=1 のときだけ参照する。
 */
function requestProtocol(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstForwarded(c, "x-forwarded-proto")?.toLowerCase();

    if (forwarded === "http" || forwarded === "https") {
      return forwarded;
    }
  }

  return new URL(c.req.url).protocol.slice(0, -1);
}

function requestHost(c: Context, trustProxy: boolean): string {
  const forwarded = trustProxy ? firstForwarded(c, "x-forwarded-host") : null;

  return forwarded ?? new URL(c.req.url).host;
}

function isSameOrigin(c: Context, trustProxy: boolean, appOrigin: string | null): boolean {
  const origin = c.req.header("origin");

  if (!origin) {
    return false;
  }

  try {
    const given = new URL(origin).origin;

    return given === `${requestProtocol(c, trustProxy)}://${requestHost(c, trustProxy)}` || given === appOrigin;
  } catch {
    return false;
  }
}

function requestIsSecure(c: Context, trustProxy: boolean): boolean {
  return requestProtocol(c, trustProxy) === "https";
}

function defaultClientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstForwarded(c, "x-forwarded-for");

    if (forwarded) {
      return forwarded;
    }
  }

  try {
    // Bun.serve の第 2 引数 (server) が c.env に渡る前提。渡らないと requestIP を引けない。
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
