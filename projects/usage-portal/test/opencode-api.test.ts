// /api/opencode/* の契約（認証必須、保存前の検証、失敗時に保存しないこと、キーを返さないこと）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { loadProviderUsage, openDatabase, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { buildHealthReport } from "../src/server/health";
import { createOpenCodeApi } from "../src/server/opencode/api";
import { createOpenCodeAuth, OPENCODE_KEY_FILE } from "../src/server/opencode/auth";
import { createSampler } from "../src/server/sampler";
import { ProviderError, type ProviderSnapshot } from "../src/server/providers/types";
import { createUsageReader, type UsagePayload } from "../src/server/usage";
import { BASE_TIME, stubCodexApi, usageSnapshot } from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const INTERVAL = 300_000;
const KEY = "sk-sentinel-opencode-key";
const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseHandle;
  credentialDir: string;
  auth: ReturnType<typeof createOpenCodeAuth>;
  get refreshes(): number;
  advance: (ms: number) => void;
};

function harness(fetchUsage?: (apiKey: string) => Promise<ProviderSnapshot>): Harness {
  let clock = BASE_TIME;
  const root = mkdtempSync(join(tmpdir(), "usage-portal-opencode-api-"));
  const dataDir = join(root, "data");
  const credentialDir = join(root, "credentials");
  const auth = createAuthService({ dataDir, now: () => clock });
  const db = openDatabase(dataDir);
  const openCodeAuth = createOpenCodeAuth({ credentialDir, now: () => clock });
  let refreshes = 0;

  dirs.push(root);
  handles.push(db);
  auth.ensureSessionKey();

  const opencode = createOpenCodeApi({
    auth: openCodeAuth,
    db,
    sampler: {
      exclusive: async (fn) => {
        fn();
        refreshes += 1;
      },
    },
    fetchUsage:
      fetchUsage ?? (async () => usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock })),
  });
  const app = createApp({
    auth,
    usage: createUsageReader({ db, sampleIntervalMs: INTERVAL, now: () => clock }),
    codex: stubCodexApi(),
    opencode,
    health: () => buildHealthReport("ok", auth.status()),
    now: () => clock,
    clientKey: () => "test-client",
  });

  return {
    app,
    db,
    credentialDir,
    auth: openCodeAuth,
    get refreshes() {
      return refreshes;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

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

function request(
  app: Harness["app"],
  path: string,
  options: { method: string; cookie?: string; origin?: string | null; body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }

  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return Promise.resolve(
    app.request(
      new Request(`${ORIGIN}${path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );
}

async function readUsage(h: Harness, cookieValue: string): Promise<UsagePayload> {
  const response = await request(h.app, "/api/usage", { method: "GET", cookie: cookieValue });

  expect(response.status).toBe(200);

  return (await response.json()) as UsagePayload;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("/api/opencode/auth", () => {
  test("未認証は 401、認証済みなら未登録を返す", async () => {
    const h = harness();

    expect((await request(h.app, "/api/opencode/auth", { method: "GET" })).status).toBe(401);

    const response = await request(h.app, "/api/opencode/auth", { method: "GET", cookie: await cookie(h.app) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, savedAt: null });
  });
});

describe("PUT /api/opencode/key", () => {
  test("同一 origin でない要求と壊れた body は受け付けず、ファイルを作らない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    expect(
      (
        await request(h.app, "/api/opencode/key", {
          method: "PUT",
          cookie: cookieValue,
          origin: null,
          body: { apiKey: KEY },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(h.app, "/api/opencode/key", {
          method: "PUT",
          cookie: cookieValue,
          origin: "https://example.test",
          body: { apiKey: KEY },
        })
      ).status,
    ).toBe(403);

    for (const body of [{}, { apiKey: 42 }, { apiKey: null }]) {
      expect((await request(h.app, "/api/opencode/key", { method: "PUT", cookie: cookieValue, body })).status).toBe(
        400,
      );
    }

    expect(existsSync(join(h.credentialDir, OPENCODE_KEY_FILE))).toBe(false);
    expect(h.refreshes).toBe(0);
  });

  test("空白・制御文字・長すぎるキーは invalid_key として保存しない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    for (const apiKey of ["   ", "sk key", "sk-key\nx", "a".repeat(513)]) {
      const response = await request(h.app, "/api/opencode/key", {
        method: "PUT",
        cookie: cookieValue,
        body: { apiKey },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_key" });
    }

    expect(existsSync(join(h.credentialDir, OPENCODE_KEY_FILE))).toBe(false);
    expect(h.auth.state().configured).toBe(false);
  });

  test("受け付けられないキーは保存せず、上流の通信失敗は unavailable にする", async () => {
    const rejected = harness(async () => {
      throw new ProviderError("config", "OpenCode Go の API キーが受け付けられませんでした");
    });
    const rejectedResponse = await request(rejected.app, "/api/opencode/key", {
      method: "PUT",
      cookie: await cookie(rejected.app),
      body: { apiKey: KEY },
    });

    expect(rejectedResponse.status).toBe(400);
    expect(await rejectedResponse.json()).toEqual({ error: "invalid_key" });
    expect(existsSync(join(rejected.credentialDir, OPENCODE_KEY_FILE))).toBe(false);
    expect(rejected.refreshes).toBe(0);

    const unavailable = harness(async () => {
      throw new ProviderError("upstream", "OpenCode Go に接続できませんでした");
    });
    const unavailableResponse = await request(unavailable.app, "/api/opencode/key", {
      method: "PUT",
      cookie: await cookie(unavailable.app),
      body: { apiKey: KEY },
    });

    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({ error: "unavailable" });
    expect(existsSync(join(unavailable.credentialDir, OPENCODE_KEY_FILE))).toBe(false);
    expect(unavailable.auth.state().configured).toBe(false);
  });

  test("想定外の例外もキーを保存せず unavailable にする", async () => {
    const h = harness(async () => {
      throw new Error(`boom ${KEY}`);
    });
    const response = await request(h.app, "/api/opencode/key", {
      method: "PUT",
      cookie: await cookie(h.app),
      body: { apiKey: KEY },
    });

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(KEY);
    expect(existsSync(join(h.credentialDir, OPENCODE_KEY_FILE))).toBe(false);
  });

  test("検証できたら 0600 で保存し、検証済みの snapshot を返して取得を 1 回だけ起こす", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const response = await request(h.app, "/api/opencode/key", {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: `  ${KEY}  ` },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ configured: true, savedAt: BASE_TIME });
    expect(text).not.toContain(KEY);
    expect(h.auth.apiKey()).toBe(KEY);
    expect(statSync(join(h.credentialDir, OPENCODE_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(h.credentialDir, OPENCODE_KEY_FILE), "utf8"))).toMatchObject({ apiKey: KEY });
    expect(h.refreshes).toBe(1);

    const usage = await readUsage(h, cookieValue);
    const opencode = usage.providers.find((provider) => provider.id === "opencode-go");

    expect(opencode?.state).toBe("ok");
    expect(opencode?.windows[0]?.usedPercent).toBe(62);
    expect(JSON.stringify(usage)).not.toContain(KEY);
  });

  test("置き換えると保存時刻と使用するキーが新しい値になる", async () => {
    const keys: string[] = [];
    const h = harness(async (apiKey) => {
      keys.push(apiKey);

      return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
    });
    const cookieValue = await cookie(h.app);

    await request(h.app, "/api/opencode/key", { method: "PUT", cookie: cookieValue, body: { apiKey: "sk-first" } });
    h.advance(60_000);
    const response = await request(h.app, "/api/opencode/key", {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: "sk-second" },
    });

    expect(await response.json()).toEqual({ configured: true, savedAt: BASE_TIME + 60_000 });
    expect(keys).toEqual(["sk-first", "sk-second"]);
    expect(h.auth.apiKey()).toBe("sk-second");
    expect(h.refreshes).toBe(2);
  });
});

describe("DELETE /api/opencode/key", () => {
  test("キーと snapshot を消して 204 を返し、二度目も 204", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    await request(h.app, "/api/opencode/key", { method: "PUT", cookie: cookieValue, body: { apiKey: KEY } });

    expect((await request(h.app, "/api/opencode/key", { method: "DELETE", cookie: cookieValue })).status).toBe(204);
    expect(h.auth.state()).toEqual({ configured: false, savedAt: null });
    expect(existsSync(join(h.credentialDir, OPENCODE_KEY_FILE))).toBe(false);

    const usage = await readUsage(h, cookieValue);
    const opencode = usage.providers.find((provider) => provider.id === "opencode-go");

    expect(opencode?.windows).toEqual([]);
    expect(opencode?.capturedAt).toBeNull();
    expect(opencode?.trend).toBeNull();

    expect((await request(h.app, "/api/opencode/key", { method: "DELETE", cookie: cookieValue })).status).toBe(204);
  });

  test("未認証は 401 で削除しない", async () => {
    const h = harness();

    h.auth.save(KEY);

    expect((await request(h.app, "/api/opencode/key", { method: "DELETE" })).status).toBe(401);
    expect(h.auth.state().configured).toBe(true);
  });
});

describe("キー変更と sampler の排他", () => {
  test("PUT と DELETE が同時に来ても、解除後に snapshot を書き戻さない", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-portal-opencode-race-"));
    const dataDir = join(root, "data");
    const credentialDir = join(root, "credentials");
    const db = openDatabase(dataDir);
    const auth = createOpenCodeAuth({ credentialDir, now: () => BASE_TIME });
    const beforeFirst = deferred();
    const beforeKeyedFetch = deferred();
    let calls = 0;

    dirs.push(root);
    handles.push(db);

    const snapshot = () => usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
    const sampler = createSampler({
      db,
      intervalMs: INTERVAL,
      now: () => BASE_TIME,
      log: () => {},
      fetchers: [
        {
          provider: { id: "opencode-go", name: "OpenCode Go" },
          fetch: async () => {
            calls += 1;
            const apiKey = auth.apiKey();

            if (calls === 1) {
              await beforeFirst.promise;
            }

            if (apiKey === null) {
              throw new ProviderError("not_connected", "OpenCode Go の API キーが登録されていません");
            }

            await beforeKeyedFetch.promise;

            return snapshot();
          },
        },
      ],
    });
    const opencode = createOpenCodeApi({ auth, db, sampler, fetchUsage: async () => snapshot() });

    const initial = sampler.kick();
    const put = opencode.save("sk-race-key");

    // 検証を終えた PUT を先に exclusive へ積む。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const del = opencode.clear();

    beforeFirst.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    beforeKeyedFetch.resolve();

    const [putResult] = await Promise.all([put, del, initial]);

    expect(putResult).toMatchObject({ ok: true, state: { configured: true } });
    expect(auth.state()).toEqual({ configured: false, savedAt: null });
    expect(loadProviderUsage(db, ["opencode-go"]).get("opencode-go")?.snapshot).toBeNull();
  });
});

describe("保存・解除に失敗したときの巻き戻し", () => {
  test("DB に書けない PUT は 503 でキーと snapshot を操作前のまま残す", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const previous = usageSnapshot({
      provider: "opencode-go",
      name: "OpenCode Go",
      capturedAt: BASE_TIME - 60_000,
    });

    h.auth.save("sk-existing");
    saveProviderSnapshot(h.db, previous);
    h.db.db.exec("PRAGMA query_only = ON");

    const response = await request(h.app, "/api/opencode/key", {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: "sk-replacement" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(h.auth.apiKey()).toBe("sk-existing");

    const stored = loadProviderUsage(h.db, ["opencode-go"]).get("opencode-go");

    expect(stored?.snapshot?.capturedAt).toBe(BASE_TIME - 60_000);
    expect(stored?.error).toBeNull();
  });

  test("DB から消せない DELETE は 503 でキーと snapshot を残す", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    h.auth.save("sk-existing");
    saveProviderSnapshot(
      h.db,
      usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME - 60_000 }),
    );
    h.db.db.exec("PRAGMA query_only = ON");

    const response = await request(h.app, "/api/opencode/key", { method: "DELETE", cookie: cookieValue });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(h.auth.apiKey()).toBe("sk-existing");

    const stored = loadProviderUsage(h.db, ["opencode-go"]).get("opencode-go");

    expect(stored?.snapshot?.capturedAt).toBe(BASE_TIME - 60_000);

    h.db.db.exec("PRAGMA query_only = OFF");
  });
});
