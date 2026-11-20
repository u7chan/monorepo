// 取得間隔の API 契約（認証必須、選べる値の固定、保存と再取得）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { openDatabase, type DatabaseHandle } from "../src/server/db";
import { createFetchIntervalStore } from "../src/server/fetch-intervals";
import { buildHealthReport } from "../src/server/health";
import {
  EMPTY_USAGE,
  stubClaudeApi,
  stubClaudeStart,
  stubCodexApi,
  stubOpenCodeApi,
  stubOpenCodeStatus,
  stubProbeApi,
} from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const DEFAULT_MS = 600_000;
const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

type Harness = {
  app: ReturnType<typeof createApp>;
  store: ReturnType<typeof createFetchIntervalStore>;
  cookie: () => Promise<string>;
};

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-interval-api-"));
  const auth = createAuthService({ dataDir, now: () => Date.now() });
  const db = openDatabase(join(dataDir, "usage.sqlite"));

  dirs.push(dataDir);
  handles.push(db);
  auth.ensureSessionKey();

  const store = createFetchIntervalStore({ db, defaultMs: DEFAULT_MS, log: () => {} });
  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    claude: stubClaudeApi(),
    claudeStart: stubClaudeStart(),
    probe: stubProbeApi(),
    opencode: stubOpenCodeApi(),
    openCodeStatus: stubOpenCodeStatus,
    fetchIntervals: {
      read: () => store.list(),
      write: (provider, minutes) => {
        store.set(provider, minutes * 60_000);

        return store.list();
      },
    },
    health: () => buildHealthReport("ok", auth.status()),
    now: () => Date.now(),
    clientKey: () => "test-client",
  });

  let cookie: string | null = null;

  return {
    app,
    store,
    async cookie() {
      if (cookie !== null) {
        return cookie;
      }

      const response = await app.request(
        new Request("http://localhost/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ pin: PIN }),
        }),
      );

      expect(response.status).toBe(201);
      cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      return cookie;
    },
  };
}

function put(app: Harness["app"], cookie: string, body: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };

  if (origin !== null) {
    headers.origin = origin;
  }

  return app.request(
    new Request("http://localhost/api/settings/fetch-intervals", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("/api/settings/fetch-intervals", () => {
  test("未認証は 401", async () => {
    const { app } = await harness();
    const response = await app.request("/api/settings/fetch-intervals");

    expect(response.status).toBe(401);
  });

  test("未設定なら既定値を返す", async () => {
    const h = await harness();
    const response = await h.app.request("/api/settings/fetch-intervals", {
      headers: { cookie: await h.cookie() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ intervals: { codex: DEFAULT_MS, "opencode-go": DEFAULT_MS } });
  });

  test("選べる値を保存し、再取得すると反映されている", async () => {
    const h = await harness();
    const cookie = await h.cookie();

    const saved = await put(h.app, cookie, { provider: "codex", minutes: 5 });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ intervals: { codex: 300_000, "opencode-go": DEFAULT_MS } });
    expect(h.store.get("codex")).toBe(300_000);

    const reread = await h.app.request("/api/settings/fetch-intervals", { headers: { cookie } });

    expect(await reread.json()).toEqual({ intervals: { codex: 300_000, "opencode-go": DEFAULT_MS } });
  });

  test("一覧に無い値・未知の provider・壊れた body は保存しない", async () => {
    const h = await harness();
    const cookie = await h.cookie();

    const invalidBodies = [
      { provider: "codex", minutes: 1 },
      { provider: "codex", minutes: 2 },
      { provider: "codex", minutes: 7 },
      { provider: "codex", minutes: 60.5 },
      { provider: "codex", minutes: "5" },
      { provider: "codex" },
      { provider: "unknown", minutes: 5 },
      { minutes: 5 },
    ];

    for (const body of invalidBodies) {
      const response = await put(h.app, cookie, body);

      expect(response.status).toBe(400);
    }

    expect(h.store.list()).toEqual({ codex: DEFAULT_MS, "opencode-go": DEFAULT_MS });
  });

  test("同一 origin でない更新は受け付けない", async () => {
    const h = await harness();
    const cookie = await h.cookie();

    for (const origin of [null, "https://example.test"]) {
      const response = await put(h.app, cookie, { provider: "codex", minutes: 5 }, origin);

      expect(response.status).toBe(403);
    }

    expect(h.store.list()).toEqual({ codex: DEFAULT_MS, "opencode-go": DEFAULT_MS });
  });
});
