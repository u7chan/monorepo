// /api/usage の契約（認証必須、sources の並び、state、trends、source ごとの独立失敗）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { openDatabase, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { codexSourceId } from "../src/server/codex/source";
import { buildHealthReport } from "../src/server/health";
import { openCodeSourceId } from "../src/server/opencode/accounts";
import { parseCodexUsage } from "../src/server/providers/codex";
import { createUsageReader, type UsagePayload, type UsageSourceAccount } from "../src/server/usage";
import { BASE_TIME, stubCodexApi, stubOpenCodeApi, usageSnapshot, stubProbeApi } from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const INTERVAL = 300_000;
const MINUTE = 60 * 1000;
const dirs: string[] = [];
const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const SUB_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNTS: readonly UsageSourceAccount[] = [
  { id: MAIN_ID, name: "メイン", icon: "🦊" },
  { id: SUB_ID, name: "サブ", icon: "🐼" },
];

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseHandle;
  dataDir: string;
  advance: (ms: number) => void;
};

function harness(
  accounts: readonly UsageSourceAccount[] = [],
  options: { codexSourceId?: () => string } = {},
): Harness {
  let clock = BASE_TIME;
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-usage-api-"));
  const auth = createAuthService({ dataDir, now: () => clock });
  const db = openDatabase(join(dataDir, "usage.sqlite"));

  dirs.push(dataDir);
  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: createUsageReader({
      db,
      sampleIntervalMs: INTERVAL,
      now: () => clock,
      accounts: () => accounts,
      codexSourceId: options.codexSourceId,
    }),
    codex: stubCodexApi(),
    probe: stubProbeApi(),
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

  test("アカウント 0 件でも Codex だけを返し、未取得は loading", async () => {
    const h = harness();
    const payload = await readUsage(h, await sessionCookie(h.app));

    expect(payload.sources.map((source) => [source.id, source.provider, source.name, source.state])).toEqual([
      ["codex", "codex", "Codex", "loading"],
    ]);
    expect(payload.sources[0]?.account).toBeNull();
    expect(payload.sampleIntervalMs).toBe(INTERVAL);
    expect(payload.generatedAt).toBe(BASE_TIME);
  });

  test("Codex → 登録順のアカウントで並べ、アカウントの名前とアイコンを返す", async () => {
    const h = harness(ACCOUNTS);
    const payload = await readUsage(h, await sessionCookie(h.app));

    expect(payload.sources.map((source) => [source.id, source.provider, source.name])).toEqual([
      ["codex", "codex", "Codex"],
      [MAIN_ID, "opencode-go", "メイン"],
      [SUB_ID, "opencode-go", "サブ"],
    ]);
    expect(payload.sources[1]?.account).toEqual({ id: MAIN_ID, name: "メイン", icon: "🦊" });
    expect(payload.sources[1]?.plan).toBeNull();
    expect(payload.sources[1]?.state).toBe("loading");
  });

  test("snapshot を state ok として返し、窓の期間ぶんの推移を付ける", async () => {
    const h = harness();

    saveProviderSnapshot(h.db, "codex", usageSnapshot({ capturedAt: BASE_TIME - 30 * MINUTE }));
    saveProviderSnapshot(h.db, "codex", usageSnapshot({ capturedAt: BASE_TIME }));

    const payload = await readUsage(h, await sessionCookie(h.app));
    const codex = payload.sources.find((source) => source.provider === "codex");

    expect(codex?.state).toBe("ok");
    expect(codex?.name).toBe("Codex");
    expect(codex?.plan).toBe("Plus");
    expect(codex?.windows[0]?.usedPercent).toBe(62);
    expect(codex?.error).toBeNull();
    expect(codex?.trends).toEqual([
      {
        windowId: "primary",
        spanMs: 7 * 24 * 60 * 60 * 1000,
        points: [
          { at: BASE_TIME - 30 * MINUTE, usedPercent: 62 },
          { at: BASE_TIME, usedPercent: 62 },
        ],
        resets: [],
      },
    ]);
  });

  test("間引きで点列から消えるリセットも trends[].resets に残す", async () => {
    const h = harness();
    const snapshotAt = (capturedAt: number, usedPercent: number) =>
      usageSnapshot({
        capturedAt,
        windows: [{ id: "primary", label: "週次", durationSeconds: 604_800, usedPercent, resetsAt: null }],
      });

    for (const [capturedAt, usedPercent] of [
      [BASE_TIME - 24 * 60 * MINUTE, 20],
      [BASE_TIME - 25 * MINUTE, 20],
      [BASE_TIME - 10 * MINUTE, 0],
      [BASE_TIME - 5 * MINUTE, 20],
      [BASE_TIME, 20],
    ] as const) {
      saveProviderSnapshot(h.db, "codex", snapshotAt(capturedAt, usedPercent));
    }

    const payload = await readUsage(h, await sessionCookie(h.app));
    const trend = payload.sources[0]?.trends[0];

    // bucket の代表点はすべて 20% になり、点列だけではリセットを検出できない。
    expect(trend?.points.map((point) => point.usedPercent)).toEqual([20, 20, 20]);
    expect(trend?.resets).toEqual([BASE_TIME - 10 * MINUTE]);
  });

  test("サインイン中の Codex はアカウント別の履歴を読み、公開 id は codex のまま", async () => {
    let accountId: string | null = "account-1";
    const h = harness([], { codexSourceId: () => codexSourceId(accountId) });
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot({ capturedAt: BASE_TIME - 30 * MINUTE }));
    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot());

    const signedIn = (await readUsage(h, cookie)).sources[0];

    expect(signedIn?.id).toBe("codex");
    expect(signedIn?.state).toBe("ok");
    expect(signedIn?.trends[0]?.points).toHaveLength(2);

    // サインアウト中は base キーを見る。前のアカウントの snapshot は出さない。
    accountId = null;
    saveProviderError(h.db, "codex", {
      code: "not_connected",
      message: "Codex にサインインしていません",
      at: BASE_TIME,
    });

    const signedOut = (await readUsage(h, cookie)).sources[0];

    expect(signedOut?.id).toBe("codex");
    expect(signedOut?.state).toBe("error");
    expect(signedOut?.windows).toEqual([]);
    expect(signedOut?.trends).toEqual([]);

    // 同じアカウントで戻ると、残しておいた sample から推移が戻る。
    accountId = "account-1";

    const reloggedIn = (await readUsage(h, cookie)).sources[0];

    expect(reloggedIn?.state).toBe("ok");
    expect(reloggedIn?.trends[0]?.points).toHaveLength(2);
  });

  test("別のアカウントでサインインし直したら前の履歴を混ぜない", async () => {
    let accountId: string | null = "account-1";
    const h = harness([], { codexSourceId: () => codexSourceId(accountId) });
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot({ capturedAt: BASE_TIME - 30 * MINUTE }));
    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot());

    accountId = "account-2";
    saveProviderSnapshot(h.db, "codex:account-2", usageSnapshot());

    const source = (await readUsage(h, cookie)).sources[0];

    expect(source?.trends).toEqual([]);
  });

  test("アカウントごとに source id で state と trends を出す", async () => {
    const h = harness(ACCOUNTS);
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(
      h.db,
      openCodeSourceId(MAIN_ID),
      usageSnapshot({
        provider: "opencode-go",
        name: "OpenCode Go",
        capturedAt: BASE_TIME - 30 * MINUTE,
        windows: [{ id: "rolling", label: "ローリング", durationSeconds: null, usedPercent: 30, resetsAt: null }],
      }),
    );
    saveProviderSnapshot(
      h.db,
      openCodeSourceId(MAIN_ID),
      usageSnapshot({
        provider: "opencode-go",
        name: "OpenCode Go",
        capturedAt: BASE_TIME,
        windows: [{ id: "rolling", label: "ローリング", durationSeconds: null, usedPercent: 40, resetsAt: null }],
      }),
    );
    saveProviderError(h.db, openCodeSourceId(SUB_ID), {
      code: "upstream",
      message: "OpenCode Go に接続できませんでした",
      at: BASE_TIME,
    });

    const payload = await readUsage(h, cookie);
    const main = payload.sources[1];
    const sub = payload.sources[2];

    expect(main?.name).toBe("メイン");
    expect(main?.state).toBe("ok");
    expect(main?.windows[0]?.usedPercent).toBe(40);
    expect(main?.trends[0]?.windowId).toBe("rolling");
    expect(main?.trends[0]?.spanMs).toBe(5 * 60 * 60 * 1000);
    expect(main?.trends[0]?.points).toHaveLength(2);

    expect(sub?.name).toBe("サブ");
    expect(sub?.state).toBe("error");
    expect(sub?.error?.code).toBe("upstream");
    expect(sub?.windows).toEqual([]);
    expect(sub?.trends).toEqual([]);
  });

  test("片方が落ちても他方は返し、失敗した源だけ error にする", async () => {
    const h = harness(ACCOUNTS);
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, "codex", usageSnapshot());
    saveProviderError(h.db, openCodeSourceId(MAIN_ID), {
      code: "config",
      message: "API キーが受け付けられませんでした",
      at: BASE_TIME,
    });

    const payload = await readUsage(h, cookie);

    expect(payload.sources.map((source) => source.state)).toEqual(["ok", "error", "loading"]);
  });

  test("snapshot と error が両方あれば前回の値を stale として返す", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, "codex", usageSnapshot({ capturedAt: BASE_TIME - 10 * MINUTE }));
    saveProviderError(h.db, "codex", { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    const codex = (await readUsage(h, cookie)).sources[0];

    expect(codex?.state).toBe("stale");
    expect(codex?.windows).toHaveLength(1);
    expect(codex?.error?.code).toBe("upstream");
  });

  test("取得が 2 周期を超えて止まっていれば error が無くても stale", async () => {
    const h = harness();
    const cookie = await sessionCookie(h.app);

    saveProviderSnapshot(h.db, "codex", usageSnapshot());
    h.advance(2 * INTERVAL + 1);

    expect((await readUsage(h, cookie)).sources[0]?.state).toBe("stale");
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
    const h = harness(ACCOUNTS);
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

    saveProviderSnapshot(h.db, "codex", snapshot);
    saveProviderError(h.db, openCodeSourceId(MAIN_ID), {
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
