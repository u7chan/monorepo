import { getConnInfo } from "hono/bun";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthService } from "./auth";
import type { HealthReport } from "./health";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { clearSessionCookie, sessionCookie } from "./session";

/** login の body は 1 KiB まで。PIN は 6 桁なので、これ以上は壊れた入力として扱う。 */
const MAX_BODY_BYTES = 1024;

export type AppDeps = {
  health: () => HealthReport;
  auth: AuthService;
  rateLimiter?: RateLimiter;
  clientKey?: (c: Context) => string;
  now?: () => number;
};

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const rateLimiter = deps.rateLimiter ?? createRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000, now });
  const clientKey = deps.clientKey ?? defaultClientKey;
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
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

  app.post("/api/auth/setup", async (c) => {
    const blocked = sameOriginViolation(c);

    if (blocked) {
      return blocked;
    }

    const body = await readPinBody(c);

    if (!body.ok) {
      return c.json({ error: body.error }, body.status);
    }

    const result = await deps.auth.setup(body.pin);

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

  app.post("/api/auth/login", async (c) => {
    const blocked = sameOriginViolation(c);

    if (blocked) {
      return blocked;
    }

    const body = await readPinBody(c);

    if (!body.ok) {
      return c.json({ error: body.error }, body.status);
    }

    const key = clientKey(c);
    const retryAfterSeconds = rateLimiter.retryAfterSeconds(key);

    if (retryAfterSeconds !== null) {
      c.header("Retry-After", String(retryAfterSeconds));

      return c.json({ error: "rate_limited" as const, retryAfterSeconds }, 429);
    }

    const result = await deps.auth.login(body.pin);

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

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearSessionCookie());

    return c.body(null, 204);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;

/**
 * ブラウザからの POST は同一 origin だけ受け付ける。`Origin` が無い要求 (curl など) は通す。
 * 認証は cookie の同一 site 制約に依存しないため、ここで弾くのはクロスサイト送信の入口だけ。
 */
function sameOriginViolation(c: Context): Response | null {
  const origin = c.req.header("origin");

  if (!origin) {
    return null;
  }

  try {
    return new URL(origin).host === new URL(c.req.url).host ? null : c.json({ error: "origin_mismatch" as const }, 403);
  } catch {
    return c.json({ error: "origin_mismatch" as const }, 403);
  }
}

type PinBody = { ok: true; pin: string } | { ok: false; error: "invalid_request"; status: 400 | 413 };

async function readPinBody(c: Context): Promise<PinBody> {
  const declared = Number(c.req.header("content-length") ?? "0");

  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, error: "invalid_request", status: 413 };
  }

  const raw = await c.req.text();

  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, error: "invalid_request", status: 413 };
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || !("pin" in parsed)) {
      return { ok: false, error: "invalid_request", status: 400 };
    }

    const pin = (parsed as { pin: unknown }).pin;

    return typeof pin === "string" ? { ok: true, pin } : { ok: false, error: "invalid_request", status: 400 };
  } catch {
    return { ok: false, error: "invalid_request", status: 400 };
  }
}

function defaultClientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // app.request() など Bun.serve 以外からの呼び出しでは接続情報が無い。
    return "unknown";
  }
}
