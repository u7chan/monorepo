import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthService } from "./auth";
import type { CodexApi } from "./codex/api";
import { CodexLoginError } from "./codex/login";
import type { HealthReport } from "./health";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { clearSessionCookie, sessionCookie } from "./session";
import type { UsagePayload } from "./usage";

/** login / setup の body は 1 KiB まで。6 桁 PIN の JSON には十分で、これ以上は壊れた入力として扱う。 */
const MAX_BODY_BYTES = 1024;

/** 貼り付け URL は長い（コードや state を含む）が、4 KiB を超えるものは壊れた入力とみなす。 */
const MAX_LOGIN_BODY_BYTES = 4096;

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
  health: () => HealthReport;
  auth: AuthService;
  usage: () => UsagePayload;
  codex: CodexApi;
  rateLimiter?: RateLimiter;
  clientKey?: (c: Context) => string;
  now?: () => number;
};

type AppEnv = { Variables: { clientKey: string } };

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const rateLimiter = deps.rateLimiter ?? createRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000, now });
  const clientKey = deps.clientKey ?? defaultClientKey;
  const tooLarge = (c: Context) => c.json({ error: "invalid_request" as const }, 413);
  const app = new Hono<AppEnv>();

  // 認証が必要な API。auth の設定が壊れているときはデータを返さず 503 にする。
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
      if (!isSameOrigin(c)) {
        return c.json({ error: "origin_mismatch" as const }, 403);
      }
    }

    await next();
  });

  app.get("/api/health", (c) => {
    const report = deps.health();

    return report.ok ? c.json(report, 200) : c.json(report, 503);
  });

  app.get("/api/auth/session", (c) => {
    const session = deps.auth.readSession(c.req.header("cookie") ?? null);

    if (session) {
      return c.json({ state: "authenticated" as const, expiresAt: session.expiresAt });
    }

    return c.json({
      state: deps.auth.status() === "setup_required" ? ("setup_required" as const) : ("unauthenticated" as const),
    });
  });

  app.post("/api/auth/setup", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }), async (c) => {
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

    c.header("Set-Cookie", sessionCookie(result.token));

    return c.json({ state: "authenticated" as const }, 201);
  });

  app.post("/api/auth/login", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }), async (c) => {
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
      c.header("Set-Cookie", sessionCookie(result.token));

      return c.json({ state: "authenticated" as const }, 200);
    });
  });

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearSessionCookie());

    return c.body(null, 204);
  });

  app.get("/api/usage", requireSession, (c) => c.json(deps.usage()));

  app.get("/api/codex/auth", requireSession, (c) => c.json(deps.codex.auth()));

  app.post("/api/codex/login", requireSession, async (c) => {
    try {
      await deps.codex.startLogin();
    } catch (error) {
      return codexError(c, error);
    }

    return c.json(deps.codex.auth(), 202);
  });

  app.post(
    "/api/codex/login/respond",
    requireSession,
    bodyLimit({ maxSize: MAX_LOGIN_BODY_BYTES, onError: tooLarge }),
    async (c) => {
      const value = await readStringBody(c, "value");

      if (value === null) {
        return c.json({ error: "invalid_request" as const }, 400);
      }

      try {
        deps.codex.respond(value);
      } catch (error) {
        return codexError(c, error);
      }

      return c.body(null, 204);
    },
  );

  app.delete("/api/codex/login", requireSession, (c) => {
    deps.codex.cancelLogin();

    return c.body(null, 204);
  });

  app.post("/api/codex/logout", requireSession, async (c) => {
    try {
      await deps.codex.logout();
    } catch {
      return c.json({ error: "logout_failed" as const }, 503);
    }

    return c.body(null, 204);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;

function isSameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");

  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

async function readPinBody(c: Context): Promise<string | null> {
  return readStringBody(c, "pin");
}

async function readStringBody(c: Context, key: string): Promise<string | null> {
  try {
    const parsed: unknown = await c.req.json();

    if (typeof parsed !== "object" || parsed === null || !(key in parsed)) {
      return null;
    }

    const value = (parsed as Record<string, unknown>)[key];

    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function codexError(c: Context, error: unknown): Response {
  if (error instanceof CodexLoginError) {
    switch (error.reason) {
      case "in_progress":
        return c.json({ error: "login_in_progress" as const }, 409);
      case "not_running":
        return c.json({ error: "login_not_running" as const }, 409);
      case "no_prompt":
        return c.json({ error: "no_prompt" as const }, 400);
      case "invalid_response":
        return c.json({ error: "invalid_response" as const }, 400);
      default:
        return c.json({ error: "unavailable" as const }, 503);
    }
  }

  // SDK の例外文は外へ出さない。分類だけを返す。
  return c.json({ error: "unavailable" as const }, 503);
}

function defaultClientKey(c: Context): string {
  try {
    // Bun.serve の第 2 引数 (server) が c.env に渡る前提。渡らないと requestIP を引けない。
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
