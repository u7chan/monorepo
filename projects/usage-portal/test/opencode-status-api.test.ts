// 稼働状況 API の認証、no-store、利用枠から独立した失敗を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { buildHealthReport } from "../src/server/health";
import type { OpenCodeStatusPayload } from "../src/shared/opencode-status";
import {
  BASE_TIME,
  EMPTY_USAGE,
  stubClaudeApi,
  stubCodexApi,
  stubOpenCodeApi,
  stubProbeApi,
  stubFetchIntervals,
} from "./support";

const dirs: string[] = [];

function harness(payload: OpenCodeStatusPayload = { state: "error", snapshot: null }) {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-status-api-"));
  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  let calls = 0;

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    claude: stubClaudeApi(),
    opencode: stubOpenCodeApi(),
    probe: stubProbeApi(),
    fetchIntervals: stubFetchIntervals(),
    openCodeStatus: async () => {
      calls += 1;
      return payload;
    },
    health: () => buildHealthReport("ok", auth.status()),
    clientKey: () => "test-client",
  });

  return {
    app,
    dataDir,
    calls: () => calls,
    cookie: async () => {
      const response = await app.request("/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ pin: "123456" }),
      });

      expect(response.status).toBe(201);

      return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/opencode/status", () => {
  test("未認証なら 401 とし、ステータスの取得も始めない", async () => {
    const h = harness();
    const response = await h.app.request("/api/opencode/status");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.calls()).toBe(0);
  });

  test("認証済みなら 200 と no-store を返す", async () => {
    const payload: OpenCodeStatusPayload = {
      state: "ok",
      snapshot: {
        updatedAt: BASE_TIME,
        stale: false,
        status: "degraded",
        reason: "latency",
        since: BASE_TIME,
        models: [],
        incidents: [],
      },
    };
    const h = harness(payload);
    const response = await h.app.request("/api/opencode/status", { headers: { cookie: await h.cookie() } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(payload);
    expect(h.calls()).toBe(1);
  });

  test("稼働状況が取れなくても利用枠 API はそのまま返す", async () => {
    const h = harness();
    const headers = { cookie: await h.cookie() };
    const response = await h.app.request("/api/opencode/status", { headers });
    const usage = await h.app.request("/api/usage", { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "error", snapshot: null });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual(EMPTY_USAGE);
  });

  test("認証設定が壊れているときは 503 とし、取得を始めない", async () => {
    const h = harness();
    const cookie = await h.cookie();

    writeFileSync(join(h.dataDir, "pin-hash"), "broken\n");

    const response = await h.app.request("/api/opencode/status", { headers: { cookie } });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "misconfigured" });
    expect(h.calls()).toBe(0);
  });
});
