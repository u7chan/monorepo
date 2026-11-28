// /api/claude/start の契約（認証・同一 origin・入力の検証・状態コード）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import type { ClaudeStartRunResult } from "../src/server/claude/start";
import { buildHealthReport } from "../src/server/health";
import {
  EMPTY_USAGE,
  stubClaudeApi,
  stubClaudeStart,
  stubCodexApi,
  stubGeminiApi,
  stubFetchIntervals,
  stubOpenCodeApi,
  stubProbeApi,
} from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const BASE_TIME = 1_800_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness(overrides: Partial<AppDeps["claudeStart"]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-claude-start-api-"));
  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  const calls: unknown[] = [];

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    claude: stubClaudeApi(),
    claudeStart: {
      ...stubClaudeStart(),
      ...overrides,
    },
    gemini: stubGeminiApi(),
    opencode: stubOpenCodeApi(),
    probe: stubProbeApi(),
    fetchIntervals: stubFetchIntervals(),
    health: () => buildHealthReport("ok", auth.status()),
    now: () => BASE_TIME,
    clientKey: () => "test-client",
  });

  return { app, calls };
}

async function cookie(app: ReturnType<typeof harness>["app"]): Promise<string> {
  const response = await app.request(
    new Request(`${ORIGIN}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ pin: PIN }),
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function send(
  app: ReturnType<typeof harness>["app"],
  method: string,
  path: string,
  options: { session?: string; body?: unknown; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN;
  }

  if (options.session) {
    headers.cookie = options.session;
  }

  return await app.request(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

describe("/api/claude/start", () => {
  test("未認証は 401 で、状態を返さない", async () => {
    const { app } = harness();

    expect((await send(app, "GET", "/api/claude/start")).status).toBe(401);
  });

  test("GET は予約の状態を返す", async () => {
    const { app } = harness();
    const session = await cookie(app);
    const response = await send(app, "GET", "/api/claude/start", { session });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: null, enabled: false, runs: [] });
  });

  test("PUT は service が検証できなかった入力を 400 にする", async () => {
    const { app } = harness({ saveSettings: () => null });
    const session = await cookie(app);

    expect((await send(app, "PUT", "/api/claude/start", { session, body: { count: 9 } })).status).toBe(400);
  });

  test("同一 origin 以外の変更は 403 で service を呼ばない", async () => {
    let called = false;
    const { app } = harness({
      setEnabled: () => {
        called = true;

        return "not_configured";
      },
    });
    const session = await cookie(app);
    const response = await send(app, "PUT", "/api/claude/start/enabled", {
      session,
      body: { enabled: true },
      origin: "http://evil.example",
    });

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("オン・オフは真偽値だけを受け付け、設定が無ければ 409 not_configured", async () => {
    const { app } = harness();
    const session = await cookie(app);

    expect((await send(app, "PUT", "/api/claude/start/enabled", { session, body: { enabled: "yes" } })).status).toBe(
      400,
    );

    const response = await send(app, "PUT", "/api/claude/start/enabled", { session, body: { enabled: true } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  test.each<[ClaudeStartRunResult, number, unknown]>([
    [{ outcome: "ok", resetsAt: BASE_TIME }, 200, { outcome: "ok", resetsAt: BASE_TIME }],
    [
      { outcome: "skipped", code: "active", resetsAt: null },
      200,
      { outcome: "skipped", code: "active", resetsAt: null },
    ],
    [{ outcome: "failed", code: "reauth_required" }, 200, { outcome: "failed", code: "reauth_required" }],
    [{ outcome: "busy" }, 409, { error: "in_progress" }],
    [{ outcome: "aborted" }, 503, { error: "unavailable" }],
  ])("今すぐ開始の結果 %o は %i", async (result, status, body) => {
    const { app } = harness({ runNow: async () => result });
    const session = await cookie(app);
    const response = await send(app, "POST", "/api/claude/start/run", { session });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });
});
