import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "hono/bun";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthService } from "./auth";
import type { HealthReport } from "./health";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { clearSessionCookie, sessionCookie } from "./session";

/** login / setup の body は 1 KiB まで。6 桁 PIN の JSON には十分で、これ以上は壊れた入力として扱う。 */
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
  const tooLarge = (c: Context) => c.json({ error: "invalid_request" as const }, 413);
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");

    // 状態を変える入口は同一 origin からの POST だけ受け付ける。Origin が無い要求 (curl など) も拒否する。
    if (c.req.method === "POST" && !isSameOrigin(c)) {
      return c.json({ error: "origin_mismatch" as const }, 403);
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

    const key = clientKey(c);

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
  try {
    const parsed: unknown = await c.req.json();

    if (typeof parsed !== "object" || parsed === null || !("pin" in parsed)) {
      return null;
    }

    const pin = (parsed as { pin: unknown }).pin;

    return typeof pin === "string" ? pin : null;
  } catch {
    return null;
  }
}

function defaultClientKey(c: Context): string {
  try {
    // Bun.serve の第 2 引数 (server) が c.env に渡る前提。渡らないと requestIP を引けない。
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
