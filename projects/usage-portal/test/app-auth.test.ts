// 認証 API の HTTP 契約（status / body / cookie / ヘッダー）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { buildHealthReport } from "../src/server/health";
import { SESSION_COOKIE_NAME } from "../src/server/session";

const dirs: string[] = [];
const PIN = "123456";
const BASE_NOW = 1_800_000_000_000;

function harness() {
  let clock = BASE_NOW;
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-app-"));

  dirs.push(dataDir);

  const auth = createAuthService({ dataDir, now: () => clock });

  auth.ensureSessionKey();

  const app = createApp({
    auth,
    health: () => buildHealthReport("ok", auth.status()),
    clientKey: () => "test-client",
    now: () => clock,
  });

  return {
    app,
    auth,
    dataDir,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function post(
  app: ReturnType<typeof harness>["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0] ?? "";

  return value;
}

async function setupPin(app: ReturnType<typeof harness>["app"]): Promise<string> {
  const response = await post(app, "/api/auth/setup", { pin: PIN });

  expect(response.status).toBe(201);

  return cookieOf(response);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/auth/session", () => {
  test("PIN 未設定なら setup_required を返し、health は 200 のまま", async () => {
    const { app } = harness();

    const session = await app.request("/api/auth/session");
    const health = await app.request("/api/health");

    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ state: "setup_required" });
    expect(health.status).toBe(200);
    expect((await health.json()) as Record<string, unknown>).toMatchObject({ ok: true, auth: "setup_required" });
  });

  test("cookie が無ければ unauthenticated、あれば expiresAt を返す", async () => {
    const { app } = harness();
    const cookie = await setupPin(app);

    const anonymous = await app.request("/api/auth/session");

    expect(await anonymous.json()).toEqual({ state: "unauthenticated" });

    const authenticated = await app.request("/api/auth/session", { headers: { cookie } });

    expect(await authenticated.json()).toEqual({
      state: "authenticated",
      expiresAt: BASE_NOW + 30 * 24 * 60 * 60 * 1000,
    });
  });
});

describe("POST /api/auth/setup", () => {
  test("登録するとセッション cookie を発行する", async () => {
    const { app } = harness();
    const response = await post(app, "/api/auth/setup", { pin: PIN });
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ state: "authenticated" });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("設定済みなら 409、6 桁でない PIN は 400", async () => {
    const { app } = harness();

    expect((await post(app, "/api/auth/setup", { pin: "12345" })).status).toBe(400);

    await setupPin(app);

    const again = await post(app, "/api/auth/setup", { pin: "654321" });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_configured" });
  });

  test("body が JSON でない / 大きすぎる場合は 400 / 413", async () => {
    const { app } = harness();

    const broken = await app.request("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(broken.status).toBe(400);

    const huge = await post(app, "/api/auth/setup", { pin: "1".repeat(2000) });

    expect(huge.status).toBe(413);
  });
});

describe("POST /api/auth/login", () => {
  test("違う PIN は 401、一致すれば 200 と cookie", async () => {
    const { app } = harness();

    await setupPin(app);

    const wrong = await post(app, "/api/auth/login", { pin: "654321" });

    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_pin" });

    const ok = await post(app, "/api/auth/login", { pin: PIN });

    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  test("PIN 未設定なら 409 setup_required", async () => {
    const { app } = harness();
    const response = await post(app, "/api/auth/login", { pin: PIN });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "setup_required" });
  });

  test("5 回失敗すると 429 と Retry-After を返し、窓が過ぎれば再び通る", async () => {
    const { app, advance } = harness();

    await setupPin(app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post(app, "/api/auth/login", { pin: "654321" })).status).toBe(401);
    }

    const locked = await post(app, "/api/auth/login", { pin: PIN });

    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect(await locked.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 900 });

    advance(15 * 60 * 1000);

    expect((await post(app, "/api/auth/login", { pin: PIN })).status).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  test("cookie を消す応答を返す", async () => {
    const { app } = harness();
    const response = await app.request("/api/auth/logout", { method: "POST" });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("共通の防御", () => {
  test("Origin が別 host の POST は 403", async () => {
    const { app } = harness();
    const response = await post(app, "/api/auth/setup", { pin: PIN }, { origin: "http://example.invalid" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_mismatch" });
  });

  test("認証 API の応答に Cache-Control: no-store を付ける", async () => {
    const { app } = harness();
    const response = await app.request("/api/auth/session");

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("PIN のリセット", () => {
  test("pin-hash を消すと setup_required に戻り、既存 cookie は通らない", async () => {
    const { app, dataDir } = harness();
    const cookie = await setupPin(app);

    rmSync(join(dataDir, "pin-hash"));

    const session = await app.request("/api/auth/session", { headers: { cookie } });

    expect(await session.json()).toEqual({ state: "setup_required" });
  });
});

describe("壊れた保存状態", () => {
  test("pin-hash が壊れていれば health は 503 misconfigured", async () => {
    const { app, dataDir } = harness();

    writeFileSync(join(dataDir, "pin-hash"), "garbage\n");

    const health = await app.request("/api/health");

    expect(health.status).toBe(503);
    expect((await health.json()) as Record<string, unknown>).toMatchObject({ ok: false, auth: "misconfigured" });
  });
});
