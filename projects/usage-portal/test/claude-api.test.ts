// POST /api/claude/refresh と /api/claude/logout の契約（認証・同一 origin・結果の受け渡し）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import type { ClaudeRefreshMode, ClaudeRefreshResult } from "../src/server/claude/service";
import { buildHealthReport } from "../src/server/health";
import {
  EMPTY_USAGE,
  stubClaudeStart,
  stubCodexApi,
  stubFetchIntervals,
  stubOpenCodeApi,
  stubProbeApi,
} from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const BASE_TIME = 1_800_000_000_000;
const dirs: string[] = [];

function harness(options: { result?: ClaudeRefreshResult; logout?: () => Promise<boolean> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-api-"));
  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  const modes: ClaudeRefreshMode[] = [];
  const logouts: number[] = [];
  const result = options.result ?? { state: "refreshed" as const };

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    claude: {
      refresh: async (mode) => {
        modes.push(mode);

        return result;
      },
      logout: async () => {
        logouts.push(logouts.length + 1);

        return options.logout ? await options.logout() : true;
      },
    },
    claudeStart: stubClaudeStart(),
    opencode: stubOpenCodeApi(),
    probe: stubProbeApi(),
    fetchIntervals: stubFetchIntervals(),
    health: () => buildHealthReport("ok", auth.status()),
    now: () => BASE_TIME,
    clientKey: () => "test-client",
  });

  return { app, dataDir, modes, logouts };
}

async function cookie(app: ReturnType<typeof harness>["app"]): Promise<string> {
  const response = await app.request(
    new Request(`${ORIGIN}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ pin: PIN }),
    }),
  );

  expect(response.status).toBe(201);

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function post(
  app: ReturnType<typeof harness>["app"],
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  const request = new Request(`${ORIGIN}/api/claude/refresh`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return await app.request(request);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /api/claude/refresh", () => {
  test("未認証は 401 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const response = await post(app, { mode: "auto" }, { "content-type": "application/json", origin: ORIGIN });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(modes).toEqual([]);
  });

  test("同一 origin 以外は 403 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const session = await cookie(app);

    const mismatched = await post(
      app,
      { mode: "manual" },
      { "content-type": "application/json", origin: "http://example.invalid", cookie: session },
    );
    const missing = await post(app, { mode: "manual" }, { "content-type": "application/json", cookie: session });

    expect(mismatched.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(modes).toEqual([]);
  });

  test("manual をそのまま service へ渡し、結果を返す", async () => {
    const { app, modes } = harness({ result: { state: "refreshed" } });
    const session = await cookie(app);
    const response = await post(
      app,
      { mode: "manual" },
      { "content-type": "application/json", origin: ORIGIN, cookie: session },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "refreshed" });
    expect(modes).toEqual(["manual"]);
  });

  test("body を省いた要求と mode: auto は自動として扱う", async () => {
    const { app, modes } = harness({ result: { state: "skipped", reason: "fresh" } });
    const session = await cookie(app);

    const withoutBody = await post(app, undefined, { origin: ORIGIN, cookie: session });
    const auto = await post(
      app,
      { mode: "auto" },
      { "content-type": "application/json", origin: ORIGIN, cookie: session },
    );

    expect(withoutBody.status).toBe(200);
    expect(auto.status).toBe(200);
    expect(await auto.json()).toEqual({ state: "skipped", reason: "fresh" });
    expect(modes).toEqual(["auto", "auto"]);
  });

  test("ログアウト中は skipped: logout をそのまま返す", async () => {
    const { app, modes } = harness({ result: { state: "skipped", reason: "logout" } });
    const session = await cookie(app);
    const response = await post(
      app,
      { mode: "auto" },
      { "content-type": "application/json", origin: ORIGIN, cookie: session },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "skipped", reason: "logout" });
    expect(modes).toEqual(["auto"]);
  });

  test("失敗の分類をそのまま返す", async () => {
    const { app } = harness({ result: { state: "failed", error: "not_connected" } });
    const session = await cookie(app);
    const response = await post(
      app,
      { mode: "manual" },
      { "content-type": "application/json", origin: ORIGIN, cookie: session },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "failed", error: "not_connected" });
  });

  test("未知の mode は 400 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const session = await cookie(app);
    const response = await post(
      app,
      { mode: "sometimes" },
      { "content-type": "application/json", origin: ORIGIN, cookie: session },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(modes).toEqual([]);
  });
});

async function postLogout(app: ReturnType<typeof harness>["app"], headers: Record<string, string>): Promise<Response> {
  return await app.request(new Request(`${ORIGIN}/api/claude/logout`, { method: "POST", headers }));
}

describe("POST /api/claude/logout", () => {
  test("成功は 204 で本文を返さない", async () => {
    const { app, logouts } = harness();
    const session = await cookie(app);
    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logouts).toHaveLength(1);
  });

  test("未認証は 401 で CLI を起動しない", async () => {
    const { app, logouts } = harness();
    const response = await postLogout(app, { origin: ORIGIN });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(logouts).toEqual([]);
  });

  test("同一 origin 以外は 403 で CLI を起動しない", async () => {
    const { app, logouts } = harness();
    const session = await cookie(app);

    const mismatched = await postLogout(app, { origin: "http://example.invalid", cookie: session });
    const missing = await postLogout(app, { cookie: session });

    expect(mismatched.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(logouts).toEqual([]);
  });

  test("認証の設定が壊れていれば 503 misconfigured", async () => {
    const { app, dataDir, logouts } = harness();
    const session = await cookie(app);

    writeFileSync(join(dataDir, "pin-hash"), "garbage\n");

    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "misconfigured" });
    expect(logouts).toEqual([]);
  });

  test("CLI か DB の失敗は 503 logout_failed", async () => {
    const { app, logouts } = harness({ logout: async () => false });
    const session = await cookie(app);
    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "logout_failed" });
    expect(logouts).toHaveLength(1);
  });
});
