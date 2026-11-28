// POST /api/gemini/refresh と /api/gemini/logout の契約（認証・同一 origin・結果の受け渡し）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import type { GeminiLogoutResult, GeminiRefreshMode, GeminiRefreshResult } from "../src/server/gemini/service";
import { buildHealthReport } from "../src/server/health";
import {
  EMPTY_USAGE,
  stubClaudeApi,
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

function harness(options: { result?: GeminiRefreshResult; logout?: GeminiLogoutResult } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-gemini-api-"));
  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  const modes: GeminiRefreshMode[] = [];
  const logouts: number[] = [];
  const claudeCalls: string[] = [];
  const result = options.result ?? { state: "refreshed" as const };

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    claude: stubClaudeApi({
      refresh: async (mode) => {
        claudeCalls.push(mode);

        return { state: "refreshed" };
      },
    }),
    claudeStart: stubClaudeStart(),
    gemini: {
      refresh: async (mode) => {
        modes.push(mode);

        return result;
      },
      logout: async () => {
        logouts.push(logouts.length + 1);

        return options.logout ?? "done";
      },
    },
    opencode: stubOpenCodeApi(),
    probe: stubProbeApi(),
    fetchIntervals: stubFetchIntervals(),
    health: () => buildHealthReport("ok", auth.status()),
    now: () => BASE_TIME,
    clientKey: () => "test-client",
  });

  return { app, dataDir, modes, logouts, claudeCalls };
}

type Harness = ReturnType<typeof harness>;

async function cookie(app: Harness["app"]): Promise<string> {
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

async function postRefresh(app: Harness["app"], body: unknown, headers: Record<string, string>): Promise<Response> {
  return await app.request(
    new Request(`${ORIGIN}/api/gemini/refresh`, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /api/gemini/refresh", () => {
  test("未認証は 401 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const response = await postRefresh(app, { mode: "auto" }, JSON_HEADERS);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(modes).toEqual([]);
  });

  test("同一 origin 以外は 403 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const session = await cookie(app);

    const mismatched = await postRefresh(
      app,
      { mode: "manual" },
      { ...JSON_HEADERS, origin: "http://example.invalid", cookie: session },
    );
    const missing = await postRefresh(app, { mode: "manual" }, { "content-type": "application/json", cookie: session });

    expect(mismatched.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(modes).toEqual([]);
  });

  test("manual をそのまま service へ渡し、結果を返す。Claude の取得は起こさない", async () => {
    const { app, modes, claudeCalls } = harness({ result: { state: "refreshed" } });
    const session = await cookie(app);
    const response = await postRefresh(app, { mode: "manual" }, { ...JSON_HEADERS, cookie: session });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "refreshed" });
    expect(modes).toEqual(["manual"]);
    expect(claudeCalls).toEqual([]);
  });

  test("body を省いた要求と mode: auto は自動として扱う", async () => {
    const { app, modes } = harness({ result: { state: "skipped", reason: "fresh" } });
    const session = await cookie(app);

    const withoutBody = await postRefresh(app, undefined, { origin: ORIGIN, cookie: session });
    const auto = await postRefresh(app, { mode: "auto" }, { ...JSON_HEADERS, cookie: session });

    expect(withoutBody.status).toBe(200);
    expect(auto.status).toBe(200);
    expect(await auto.json()).toEqual({ state: "skipped", reason: "fresh" });
    expect(modes).toEqual(["auto", "auto"]);
  });

  test("skipped の理由と失敗の分類をそのまま返す", async () => {
    for (const result of [
      { state: "skipped", reason: "cooldown" },
      { state: "skipped", reason: "logout" },
      { state: "failed", error: "not_connected" },
    ] as const) {
      const { app } = harness({ result });
      const session = await cookie(app);
      const response = await postRefresh(app, { mode: "manual" }, { ...JSON_HEADERS, cookie: session });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    }
  });

  test("schedule など未知の mode は 400 で取得を起こさない", async () => {
    const { app, modes } = harness();
    const session = await cookie(app);

    for (const mode of ["schedule", "sometimes"]) {
      const response = await postRefresh(app, { mode }, { ...JSON_HEADERS, cookie: session });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }

    expect(modes).toEqual([]);
  });
});

async function postLogout(app: Harness["app"], headers: Record<string, string>): Promise<Response> {
  return await app.request(new Request(`${ORIGIN}/api/gemini/logout`, { method: "POST", headers }));
}

describe("POST /api/gemini/logout", () => {
  test("完了は 204 で本文を返さない", async () => {
    const { app, logouts } = harness();
    const session = await cookie(app);
    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(logouts).toHaveLength(1);
  });

  test("未認証は 401 でログアウトを起こさない", async () => {
    const { app, logouts } = harness();
    const response = await postLogout(app, { origin: ORIGIN });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(logouts).toEqual([]);
  });

  test("同一 origin 以外は 403 でログアウトを起こさない", async () => {
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

  test("削除後も接続が残っていれば 409 logout_incomplete", async () => {
    const { app, logouts } = harness({ logout: "incomplete" });
    const session = await cookie(app);
    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "logout_incomplete" });
    expect(logouts).toHaveLength(1);
  });

  test("削除・確認・DB の失敗は 503 logout_failed", async () => {
    const { app, logouts } = harness({ logout: "failed" });
    const session = await cookie(app);
    const response = await postLogout(app, { origin: ORIGIN, cookie: session });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "logout_failed" });
    expect(logouts).toHaveLength(1);
  });
});
