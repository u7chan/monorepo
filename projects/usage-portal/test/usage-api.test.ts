// /api/usage の契約（認証必須、state、trend、provider の独立失敗）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { openDatabase, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { buildHealthReport } from "../src/server/health";
import { parseCodexUsage } from "../src/server/providers/codex";
import { createUsageReader, type UsagePayload } from "../src/server/usage";
import { BASE_TIME, stubCodexApi, stubOpenCodeApi, usageSnapshot } from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const INTERVAL = 300_000;
const MINUTE = 60 * 1000;
const dirs: string[] = [];

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseHandle;
  dataDir: string;
  advance: (ms: number) => void;
};

function harness(): Harness {
  let clock = BASE_TIME;
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-usage-api-"));
  const auth = createAuthService({ dataDir, now: () => clock });
  const db = openDatabase(join(dataDir, "usage.sqlite"));

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: createUsageReader({ db, sampleIntervalMs: INTERVAL, now: () => clock }),
    codex: stubCodexApi(),
    opencode: stubOpenCodeApi(),
    health: () => buildHealthReport("ok", auth.status()),
    now: () => clock,
    clientKey: () => "test-client",
  });

  return {
    app,
    db,
    dataDir,
    advance(ms: number) {
      clock += ms;
    },
  };
}

async function sessionCookie(app: Harness["app"]): Promise<string> {
  const response = await app.request(
    new Request("http://localhost/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ pin: PIN }),
    }),
  );

  expect(response.status).toBe(201);

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function readUsage(harness: Harness, cookie: string): Promise<UsagePayload> {
  const response = await harness.app.request("/api/usage", { headers: { cookie } });

  expect(response.status).toBe(200);

  return (await response.json()) as UsagePayload;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/usage", () => {
  test("未認証は 401 でデータを返さない", async () => {
    const { app } = harness();
    const response = await app.request("/api/usage");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("認証済みなら provider の行を常に 2 件返し、未取得は loading", async () => {
    const h = harness();
    const payload = await readUsage(h, await sessionCookie(h.app));

    expect(payload.providers.map((provider) => [provider.id, provider.name, provider.state])).toEqual([
      ["codex", "Codex", "loading"],
      ["opencode-go", "OpenCode Go", "loading"],
    ]);
    expect(payload.sampleIntervalMs).toBe(INTERVAL);
    expect(payload.generatedAt).toBe(BASE_TIME);
  });

  test("snapshot を state ok として返し、24 時間の推移を付ける", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, usageSnapshot({ capturedAt: BASE_TIME - 30 * MINUTE }));
    saveProviderSnapshot(h.db, usageSnapshot({ capturedAt: BASE_TIME }));

    const payload = await readUsage(h, await sessionCookie(h.app));
    const codex = payload.providers.find((provider) => provider.id === "codex");

    expect(codex?.state).toBe("ok");
    expect(codex?.plan).toBe("Plus");
    expect(codex?.windows[0]?.usedPercent).toBe(62);
    expect(codex?.error).toBeNull();
    expect(codex?.trend).toEqual({
      windowId: "primary",
      points: [
        { at: BASE_TIME - 30 * MINUTE, usedPercent: 62 },
        { at: BASE_TIME, usedPercent: 62 },
      ],
    });
  });

  test("片方が落ちても他方は返し、失敗した側だけ error にする", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, usageSnapshot());
    saveProviderError(h.db, "opencode-go", { code: "config", message: "API キーがありません", at: BASE_TIME });

    const payload = await readUsage(h, cookie);
    const codex = payload.providers.find((provider) => provider.id === "codex");
    const opencode = payload.providers.find((provider) => provider.id === "opencode-go");

    expect(codex?.state).toBe("ok");
    expect(opencode?.state).toBe("error");
    expect(opencode?.error).toEqual({ code: "config", message: "API キーがありません", at: BASE_TIME });
    expect(opencode?.windows).toEqual([]);
    expect(opencode?.trend).toBeNull();
  });

  test("snapshot と error が両方あれば前回の値を stale として返す", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, usageSnapshot({ capturedAt: BASE_TIME - 10 * MINUTE }));
    saveProviderError(h.db, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    const codex = (await readUsage(h, cookie)).providers.find((provider) => provider.id === "codex");

    expect(codex?.state).toBe("stale");
    expect(codex?.windows).toHaveLength(1);
    expect(codex?.error?.code).toBe("upstream");
  });

  test("取得が 2 周期を超えて止まっていれば error が無くても stale", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, usageSnapshot());
    h.advance(2 * INTERVAL + 1);

    expect((await readUsage(h, cookie)).providers[0]?.state).toBe("stale");
  });

  test("認証設定が壊れていれば 503 でデータを返さない", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    writeFileSync(join(h.dataDir, "pin-hash"), "garbage\n");

    const response = await h.app.request("/api/usage", { headers: { cookie } });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "misconfigured" });
  });

  test("Cache-Control: no-store を付ける", async () => {
    const h = harness();
    const response = await h.app.request("/api/usage", { headers: { cookie: await sessionCookie(h.app) } });

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("上流の識別子と token を API 応答にも DB にも残さない", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);
    const snapshot = parseCodexUsage(
      {
        plan_type: "plus",
        email: "sentinel@example.invalid",
        user_id: "user-sentinel",
        account_id: "account-sentinel",
        credits: { has_credits: true },
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604_800, access_token: "token-sentinel" },
        },
      },
      BASE_TIME,
    );

    saveProviderSnapshot(h.db, snapshot);
    saveProviderError(h.db, "opencode-go", {
      code: "config",
      message: "OpenCode Go の API キーが設定されていません",
      at: BASE_TIME,
    });

    const response = await h.app.request("/api/usage", { headers: { cookie } });
    const body = await response.text();

    for (const table of ["provider_snapshot", "provider_error", "usage_sample"]) {
      const rows = JSON.stringify(h.db.db.query(`SELECT * FROM ${table}`).all());

      expect(rows).not.toContain("sentinel");
    }

    expect(body).not.toContain("sentinel");
  });
});
