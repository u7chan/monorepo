// 認証 API の HTTP 契約（status / body / cookie / ヘッダー）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { buildHealthReport } from "../src/server/health";
import { SESSION_COOKIE_NAME } from "../src/server/session";
import { EMPTY_USAGE, stubCodexApi } from "./support";

const dirs: string[] = [];
const PIN = "123456";
const BASE_NOW = 1_800_000_000_000;
const ORIGIN = "http://localhost";

function harness(options: { clientKey?: boolean } = {}) {
  let clock = BASE_NOW;
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-app-"));

  dirs.push(dataDir);

  const auth = createAuthService({ dataDir, now: () => clock });

  auth.ensureSessionKey();

  const app = createApp({
    auth,
    health: () => buildHealthReport("ok", auth.status()),
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    now: () => clock,
    ...(options.clientKey === false ? {} : { clientKey: () => "test-client" }),
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

function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function post(
  app: ReturnType<typeof harness>["app"],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(request(path, body, headers));
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
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

  test("body が JSON でない場合は 400、1 KiB を超える場合は 413", async () => {
    const { app } = harness();

    const broken = await app.request(
      new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{",
      }),
    );

    expect(broken.status).toBe(400);

    // 文字数ではなくバイト数で判定する (日本語は 1 文字 3 bytes)。
    const huge = await post(app, "/api/auth/setup", { pin: "123456", padding: "あ".repeat(400) });

    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: "invalid_request" });
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

  test("同時に届いた誤 PIN でも 5 回を超えて照合しない", async () => {
    const { app } = harness();

    await setupPin(app);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(app, "/api/auth/login", { pin: "654321" })),
    );
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

describe("POST /api/auth/logout", () => {
  test("cookie を消す応答を返す", async () => {
    const { app } = harness();
    const response = await app.request(
      new Request("http://localhost/api/auth/logout", { method: "POST", headers: { origin: ORIGIN } }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("同一 origin の検査", () => {
  test("Origin が無い / 別 host / scheme 違いの POST は 403", async () => {
    const { app } = harness();

    const cases: Array<Record<string, string>> = [
      {},
      { origin: "https://example.invalid" },
      { origin: "https://localhost" },
    ];

    for (const headers of cases) {
      const request = new Request("http://localhost/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ pin: PIN }),
      });
      const response = await app.request(request);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "origin_mismatch" });
    }
  });

  test("logout も別 origin からは受け付けない", async () => {
    const { app } = harness();
    const response = await app.request(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://example.invalid" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("レート制限のキー", () => {
  test("Bun の server を env として渡すと接続元ごとに独立して数える", async () => {
    const { app } = harness({ clientKey: false });
    const serverFor = (address: string) => ({
      requestIP: () => ({ address, family: "IPv4", port: 50000 }),
    });
    const login = (pin: string) => request("/api/auth/login", { pin });

    await setupPin(app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.fetch(login("654321"), { server: serverFor("203.0.113.7") });

      expect(response.status).toBe(401);
    }

    const sameClient = await app.fetch(login("654321"), { server: serverFor("203.0.113.7") });
    const otherClient = await app.fetch(login("654321"), { server: serverFor("203.0.113.8") });

    expect(sameClient.status).toBe(429);
    // 接続元が違えば別のバケツ。ここが unknown に潰れると全端末が巻き添えになる。
    expect(otherClient.status).toBe(401);
  });

  test("Content-Length の無い要求でも同じ接続元として数える", async () => {
    const { app } = harness({ clientKey: false });
    const originals = new Set<Request>();
    const server = {
      // bodyLimit が Request を作り直すと、ここに来る実体は元の Request ではなくなる。
      requestIP: (req: Request) =>
        originals.has(req) ? { address: "203.0.113.9", family: "IPv4", port: 50000 } : null,
    };
    const streamed = (pin: string) => {
      const request = new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ pin })));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);

      originals.add(request);

      return request;
    };
    const plain = (pin: string) => {
      const plainRequest = request("/api/auth/login", { pin });

      originals.add(plainRequest);

      return plainRequest;
    };

    await setupPin(app);

    // chunked (Content-Length なし) の誤 PIN 5 回。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.fetch(streamed("654321"), { server })).status).toBe(401);
    }

    // 転送形式が違っても同じ接続元なら共有される。
    expect((await app.fetch(plain("654321"), { server })).status).toBe(429);
    expect((await app.fetch(streamed("654321"), { server })).status).toBe(429);
  });
});

describe("共通の防御", () => {
  test("認証 API の応答に Cache-Control: no-store を付ける", async () => {
    const { app } = harness();
    const response = await app.request("/api/auth/session");

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("API の応答にセキュリティヘッダーを付ける", async () => {
    const { app } = harness();
    const response = await app.request("/api/health");

    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
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

  test("1 文字切り詰めた pin-hash も misconfigured", async () => {
    const { app, dataDir } = harness();
    // ソルトがランダムだと切り詰めが canonical になる場合があり、生成結果に依存すると不安定になる。
    const hash =
      "$argon2id$v=19$m=65536,t=2,p=1$y6eXe3E686k8eA0nXIhuHe9+Vxb6yCZaVVRDiOZ5Rug$gysjOYMPKtIkNzwpbC/ypxc38v4aR97rSWb+oK/NTAk";

    writeFileSync(join(dataDir, "pin-hash"), `${hash}\n`);

    expect((await app.request("/api/health")).status).toBe(200);

    writeFileSync(join(dataDir, "pin-hash"), `${hash.slice(0, -1)}\n`);

    const health = await app.request("/api/health");

    expect(health.status).toBe(503);
    expect((await health.json()) as Record<string, unknown>).toMatchObject({ auth: "misconfigured" });
  });
});
