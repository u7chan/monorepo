// /api/opencode/accounts の契約（認証・検証・上限・排他・応答にキーを出さないこと）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { loadProviderUsage, loadSamples, openDatabase, saveProviderError, type DatabaseHandle } from "../src/server/db";
import { buildHealthReport } from "../src/server/health";
import {
  createOpenCodeAccounts,
  OPENCODE_ACCOUNTS_FILE,
  openCodeSourceId,
  type OpenCodeAccount,
} from "../src/server/opencode/accounts";
import { createOpenCodeApi } from "../src/server/opencode/api";
import { CODEX_PROVIDER, OPENCODE_PROVIDER } from "../src/server/providers";
import { ProviderError } from "../src/server/providers/types";
import { createSampler, type UsageFetcher } from "../src/server/sampler";
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

type OpenCodeAccounts = ReturnType<typeof createOpenCodeAccounts>;

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseHandle;
  credentialDir: string;
  accounts: OpenCodeAccounts;
  opencode: ReturnType<typeof createOpenCodeApi>;
  sampler: ReturnType<typeof createSampler>;
  keys: string[];
  get refreshes(): number;
  advance: (ms: number) => void;
};

function harness(
  options: {
    fetchUsage?: (apiKey: string) => Promise<ReturnType<typeof usageSnapshot>>;
    fetchers?: (deps: { accounts: OpenCodeAccounts; db: DatabaseHandle }) => UsageFetcher[];
  } = {},
): Harness {
  let clock = BASE_TIME;
  const root = mkdtempSync(join(tmpdir(), "usage-portal-opencode-api-"));
  const dataDir = join(root, "data");
  const credentialDir = join(root, "credentials");
  const auth = createAuthService({ dataDir, now: () => clock });
  const db = openDatabase(dataDir);
  const accounts = createOpenCodeAccounts({ credentialDir, now: () => clock, log: () => {} });
  const keys: string[] = [];

  dirs.push(root);
  handles.push(db);
  auth.ensureSessionKey();

  let refreshes = 0;
  const sampler =
    options.fetchers === undefined
      ? // 検証だけを見るテストでは、排他区間が呼ばれた回数だけを数える。
        ({
          kick: async () => {},
          stop: () => {},
          start: () => {},
          exclusive: async (fn: () => void, exclusiveOptions?: { refresh?: boolean }) => {
            fn();

            if (exclusiveOptions?.refresh ?? true) {
              refreshes += 1;
            }
          },
        } satisfies ReturnType<typeof createSampler>)
      : createSampler({
          db,
          intervalMs: INTERVAL,
          now: () => clock,
          log: () => {},
          fetchers: () => options.fetchers?.({ accounts, db }) ?? [],
        });

  const opencode = createOpenCodeApi({
    accounts,
    db,
    sampler,
    fetchUsage:
      options.fetchUsage ??
      (async (apiKey) => {
        keys.push(apiKey);

        return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: clock });
      }),
  });
  const app = createApp({
    auth,
    usage: createUsageReader({
      db,
      sampleIntervalMs: INTERVAL,
      now: () => clock,
      accounts: () => accounts.list(),
    }),
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
    accounts,
    opencode,
    sampler,
    keys,
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
  options: { method: string; cookie?: string; origin?: string | null; body?: unknown; raw?: string },
): Promise<Response> {
  const headers: Record<string, string> = {};

  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }

  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN;
  }

  if (options.body !== undefined || options.raw !== undefined) {
    headers["content-type"] = "application/json";
  }

  return Promise.resolve(
    app.request(
      new Request(`${ORIGIN}${path}`, {
        method: options.method,
        headers,
        ...(options.raw !== undefined
          ? { body: options.raw }
          : options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
      }),
    ),
  );
}

async function createAccount(
  h: Harness,
  cookieValue: string,
  body: Record<string, unknown> = { name: "メイン", icon: "🦊", apiKey: KEY },
): Promise<OpenCodeAccount> {
  const response = await request(h.app, "/api/opencode/accounts", {
    method: "POST",
    cookie: cookieValue,
    body,
  });

  expect(response.status).toBe(201);

  return ((await response.json()) as { account: OpenCodeAccount }).account;
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

describe("GET /api/opencode/accounts", () => {
  test("未認証は 401、認証済みなら 0 件を返し、キーを含めない", async () => {
    const h = harness();

    expect((await request(h.app, "/api/opencode/accounts", { method: "GET" })).status).toBe(401);

    const response = await request(h.app, "/api/opencode/accounts", { method: "GET", cookie: await cookie(h.app) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accounts: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/opencode/accounts", () => {
  test("同一 origin でない要求と壊れた body は受け付けず、ファイルを作らない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    for (const origin of [null, "https://example.test"]) {
      expect(
        (
          await request(h.app, "/api/opencode/accounts", {
            method: "POST",
            cookie: cookieValue,
            origin,
            body: { name: "メイン", icon: "🦊", apiKey: KEY },
          })
        ).status,
      ).toBe(403);
    }

    for (const options of [
      { body: {} },
      { body: { name: "メイン", icon: "🦊" } },
      { body: { name: 42, icon: "🦊", apiKey: KEY } },
      { body: [] },
      { raw: "not json" },
    ]) {
      const response = await request(h.app, "/api/opencode/accounts", {
        method: "POST",
        cookie: cookieValue,
        ...options,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }

    expect(existsSync(join(h.credentialDir, OPENCODE_ACCOUNTS_FILE))).toBe(false);
    expect(h.refreshes).toBe(0);
  });

  test("名前・アイコン・キーの検証に落ちたら保存しない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    const cases: { body: Record<string, unknown>; error: string }[] = [
      { body: { name: "   ", icon: "🦊", apiKey: KEY }, error: "invalid_name" },
      { body: { name: "あ".repeat(41), icon: "🦊", apiKey: KEY }, error: "invalid_name" },
      { body: { name: "メイン\n2", icon: "🦊", apiKey: KEY }, error: "invalid_name" },
      { body: { name: "メイン", icon: "🚀", apiKey: KEY }, error: "invalid_icon" },
      { body: { name: "メイン", icon: "🦊", apiKey: "   " }, error: "invalid_key" },
      { body: { name: "メイン", icon: "🦊", apiKey: "sk key" }, error: "invalid_key" },
      { body: { name: "メイン", icon: "🦊", apiKey: "a".repeat(513) }, error: "invalid_key" },
    ];

    for (const { body, error } of cases) {
      const response = await request(h.app, "/api/opencode/accounts", { method: "POST", cookie: cookieValue, body });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }

    expect(h.accounts.list()).toEqual([]);
    expect(existsSync(join(h.credentialDir, OPENCODE_ACCOUNTS_FILE))).toBe(false);
    expect(h.keys).toEqual([]);
  });

  test("受け付けられないキーは保存せず、通信失敗は unavailable にする", async () => {
    const rejected = harness({
      fetchUsage: async () => {
        throw new ProviderError("config", "OpenCode Go の API キーが受け付けられませんでした");
      },
    });
    const rejectedResponse = await request(rejected.app, "/api/opencode/accounts", {
      method: "POST",
      cookie: await cookie(rejected.app),
      body: { name: "メイン", icon: "🦊", apiKey: KEY },
    });

    expect(rejectedResponse.status).toBe(400);
    expect(await rejectedResponse.json()).toEqual({ error: "invalid_key" });
    expect(rejected.accounts.list()).toEqual([]);
    expect(rejected.refreshes).toBe(0);

    for (const fetchUsage of [
      async () => {
        throw new ProviderError("upstream", "OpenCode Go に接続できませんでした");
      },
      async () => {
        throw new ProviderError("schema", "OpenCode Go の応答を解釈できませんでした");
      },
      async () => {
        throw new Error(`boom ${KEY}`);
      },
    ]) {
      const h = harness({ fetchUsage });
      const response = await request(h.app, "/api/opencode/accounts", {
        method: "POST",
        cookie: await cookie(h.app),
        body: { name: "メイン", icon: "🦊", apiKey: KEY },
      });

      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain(KEY);
      expect(h.accounts.list()).toEqual([]);
    }
  });

  test("検証できたら 201 で保存し、検証済みの snapshot を同じ source id に書く", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const response = await request(h.app, "/api/opencode/accounts", {
      method: "POST",
      cookie: cookieValue,
      body: { name: "  メイン  ", icon: "🦊", apiKey: `  ${KEY}  ` },
    });
    const text = await response.text();
    const account = (JSON.parse(text) as { account: OpenCodeAccount }).account;

    expect(response.status).toBe(201);
    expect(account.name).toBe("メイン");
    expect(account.icon).toBe("🦊");
    expect(account.savedAt).toBe(BASE_TIME);
    expect(text).not.toContain(KEY);
    expect(h.keys).toEqual([KEY]);
    expect(h.refreshes).toBe(1);
    expect(statSync(join(h.credentialDir, OPENCODE_ACCOUNTS_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(h.credentialDir, OPENCODE_ACCOUNTS_FILE), "utf8"))).toMatchObject({
      version: 1,
      accounts: [{ id: account.id, name: "メイン", icon: "🦊", apiKey: KEY }],
    });

    const stored = loadProviderUsage(h.db, [openCodeSourceId(account.id)]).get(openCodeSourceId(account.id));

    expect(stored?.snapshot?.provider).toBe("opencode-go");
    expect(stored?.snapshot?.windows[0]?.usedPercent).toBe(62);

    const usage = await readUsage(h, cookieValue);

    expect(usage.sources.map((source) => `${source.provider}:${source.id}:${source.account?.name ?? "-"}`)).toEqual([
      "codex:codex:-",
      `opencode-go:${account.id}:メイン`,
    ]);
    expect(usage.sources[1]?.state).toBe("ok");
    expect(JSON.stringify(usage)).not.toContain(KEY);
  });

  test("10 件を超える作成は 409 で拒む", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    for (let index = 0; index < 10; index += 1) {
      await createAccount(h, cookieValue, { name: `アカウント ${index}`, icon: "🦊", apiKey: `sk-${index}` });
    }

    const response = await request(h.app, "/api/opencode/accounts", {
      method: "POST",
      cookie: cookieValue,
      body: { name: "11 件目", icon: "🦊", apiKey: "sk-10" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "limit_reached" });
    expect(h.accounts.list()).toHaveLength(10);
  });

  test("検証が同時に終わっても、排他区間の内側で数え直して上限を超えない", async () => {
    const h = harness({ fetchers: () => [] });
    const cookieValue = await cookie(h.app);

    for (let index = 0; index < 9; index += 1) {
      h.accounts.create({ name: `アカウント ${index}`, icon: "🦊", apiKey: `sk-${index}` });
    }

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        request(h.app, "/api/opencode/accounts", {
          method: "POST",
          cookie: cookieValue,
          body: { name: `同時 ${index}`, icon: "🦊", apiKey: `sk-concurrent-${index}` },
        }),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409]);
    expect(h.accounts.list()).toHaveLength(10);
  });
});

describe("PUT /api/opencode/accounts/:id", () => {
  test("名前とアイコンだけの更新では上流を叩かない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);

    h.advance(60_000);

    const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "PUT",
      cookie: cookieValue,
      body: { name: "  サブ  ", icon: "🐼" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: { id: account.id, name: "サブ", icon: "🐼", savedAt: BASE_TIME + 60_000 },
    });
    expect(h.keys).toHaveLength(1);
    expect(h.accounts.apiKey(account.id)).toBe(KEY);
    // 名前だけの更新では取り直さない。
    expect(h.refreshes).toBe(1);
  });

  test("キーを置き換えると検証してから保存し、snapshot も更新する", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);

    h.advance(60_000);

    const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: "sk-second" },
    });

    expect(response.status).toBe(200);
    expect(h.keys).toEqual([KEY, "sk-second"]);
    expect(h.accounts.apiKey(account.id)).toBe("sk-second");
    expect(h.accounts.get(account.id)?.name).toBe("メイン");
    expect(h.accounts.get(account.id)?.savedAt).toBe(BASE_TIME + 60_000);
  });

  test("検証に落ちた更新は名前もアイコンも変えない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);

    const cases: { body: Record<string, unknown>; status: number; error: string }[] = [
      { body: {}, status: 400, error: "invalid_request" },
      { body: { apiKey: "" }, status: 400, error: "invalid_key" },
      { body: { apiKey: "   " }, status: 400, error: "invalid_key" },
      { body: { name: "" }, status: 400, error: "invalid_name" },
      { body: { icon: "🚀" }, status: 400, error: "invalid_icon" },
      { body: { name: 42 }, status: 400, error: "invalid_request" },
    ];

    for (const { body, status, error } of cases) {
      const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
        method: "PUT",
        cookie: cookieValue,
        body,
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }

    expect(h.accounts.get(account.id)).toEqual({ id: account.id, name: "メイン", icon: "🦊", savedAt: BASE_TIME });
    expect(h.accounts.apiKey(account.id)).toBe(KEY);
  });

  test("未知の id は 404 で、ファイルも変えない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);

    const response = await request(h.app, "/api/opencode/accounts/00000000-0000-4000-8000-000000000000", {
      method: "PUT",
      cookie: cookieValue,
      body: { name: "サブ" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(h.accounts.list()).toEqual([account]);
  });

  test("未知の id はキー検証より先に 404 を返し、上流を叩かない", async () => {
    const verified: string[] = [];
    const h = harness({
      fetchUsage: async (apiKey) => {
        verified.push(apiKey);

        throw new ProviderError("config", "OpenCode Go の API キーが受け付けられませんでした");
      },
    });
    const cookieValue = await cookie(h.app);

    const response = await request(h.app, "/api/opencode/accounts/00000000-0000-4000-8000-000000000000", {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: "sk-placeholder" },
    });

    // キーが受け付けられない場合（400）でも、通信失敗（503）でもなく 404 になる。
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(verified).toEqual([]);
  });
});

describe("DELETE /api/opencode/accounts/:id", () => {
  test("キー・snapshot・error・sample を消して 204 を返し、二度目は 404", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);
    const sourceId = openCodeSourceId(account.id);

    saveProviderError(h.db, sourceId, { code: "upstream", message: "HTTP 500", at: BASE_TIME });

    expect(loadSamples(h.db, sourceId, "primary", 0)).toHaveLength(1);

    const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "DELETE",
      cookie: cookieValue,
    });

    expect(response.status).toBe(204);
    expect(h.accounts.list()).toEqual([]);
    expect(loadProviderUsage(h.db, [sourceId]).get(sourceId)).toEqual({ snapshot: null, error: null });
    expect(loadSamples(h.db, sourceId, "primary", 0)).toEqual([]);
    expect(h.refreshes).toBe(2);

    expect(
      (await request(h.app, `/api/opencode/accounts/${account.id}`, { method: "DELETE", cookie: cookieValue })).status,
    ).toBe(404);
  });

  test("未認証は 401 で削除しない", async () => {
    const h = harness();
    const account = h.accounts.create({ name: "メイン", icon: "🦊", apiKey: KEY });

    expect((await request(h.app, `/api/opencode/accounts/${account.id}`, { method: "DELETE" })).status).toBe(401);
    expect(h.accounts.list()).toHaveLength(1);
  });
});

describe("保存・削除に失敗したときの巻き戻し", () => {
  test("DB に書けない作成は 503 でアカウントを残さない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    h.db.db.exec("PRAGMA query_only = ON");

    const response = await request(h.app, "/api/opencode/accounts", {
      method: "POST",
      cookie: cookieValue,
      body: { name: "メイン", icon: "🦊", apiKey: KEY },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(h.accounts.list()).toEqual([]);
    expect(existsSync(join(h.credentialDir, OPENCODE_ACCOUNTS_FILE))).toBe(false);

    h.db.db.exec("PRAGMA query_only = OFF");
  });

  test("DB から消せない削除は 503 でアカウントと snapshot を残す", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);
    const sourceId = openCodeSourceId(account.id);

    h.db.db.exec("PRAGMA query_only = ON");

    const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "DELETE",
      cookie: cookieValue,
    });

    expect(response.status).toBe(503);
    expect(h.accounts.list()).toHaveLength(1);
    expect(loadProviderUsage(h.db, [sourceId]).get(sourceId)?.snapshot?.capturedAt).toBe(BASE_TIME);

    h.db.db.exec("PRAGMA query_only = OFF");
  });

  test("DB に書けないキー更新は 503 でキーと snapshot を操作前のまま残す", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);
    const sourceId = openCodeSourceId(account.id);

    h.db.db.exec("PRAGMA query_only = ON");

    const response = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "PUT",
      cookie: cookieValue,
      body: { name: "サブ", apiKey: "sk-second" },
    });

    expect(response.status).toBe(503);
    expect(h.accounts.get(account.id)?.name).toBe("メイン");
    expect(h.accounts.apiKey(account.id)).toBe(KEY);
    expect(loadProviderUsage(h.db, [sourceId]).get(sourceId)?.snapshot?.capturedAt).toBe(BASE_TIME);

    h.db.db.exec("PRAGMA query_only = OFF");
  });
});

describe("削除と進行中の取得の競合", () => {
  test("削除したアカウントの snapshot を、先に始まった取得が書き戻さない", async () => {
    const gate = deferred();
    const h = harness({
      fetchers: ({ accounts }) => [
        {
          sourceId: openCodeSourceId(accounts.list()[0]?.id ?? ""),
          provider: { id: "opencode-go", name: "OpenCode Go" },
          fetch: async () => {
            await gate.promise;

            return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
          },
        },
      ],
    });
    const account = h.accounts.create({ name: "メイン", icon: "🦊", apiKey: KEY });
    const sourceId = openCodeSourceId(account.id);

    // 取得がアカウントの存在を読んだあとに削除を積む。
    const initial = h.sampler.kick();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const removed = h.opencode.remove(account.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.accounts.list()).toHaveLength(1);

    gate.resolve();
    await Promise.all([initial, removed]);

    expect(h.accounts.list()).toEqual([]);
    expect(loadProviderUsage(h.db, [sourceId]).get(sourceId)?.snapshot).toBeNull();
  });
});

describe("変更後の再取得", () => {
  test("名前とアイコンだけの更新では実 sampler の fetcher を呼ばず、キー更新と削除では 1 回だけ取り直す", async () => {
    const calls: string[] = [];
    const h = harness({
      fetchers: ({ accounts }) => [
        {
          sourceId: CODEX_PROVIDER.id,
          provider: CODEX_PROVIDER,
          fetch: async () => {
            calls.push("codex");

            return usageSnapshot();
          },
        },
        ...accounts.list().map((account) => ({
          sourceId: openCodeSourceId(account.id),
          provider: OPENCODE_PROVIDER,
          fetch: async () => {
            calls.push(`account:${account.id}`);

            return usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME });
          },
        })),
      ],
    });
    const cookieValue = await cookie(h.app);
    const account = await createAccount(h, cookieValue);

    // 作成は、変更後の再取得で全 source を 1 回ずつ叩く。
    expect(calls).toEqual(["codex", `account:${account.id}`]);

    calls.length = 0;

    const renamed = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "PUT",
      cookie: cookieValue,
      body: { name: "サブ", icon: "🐼" },
    });

    expect(renamed.status).toBe(200);
    expect(h.keys).toEqual([KEY]);
    expect(calls).toEqual([]);

    calls.length = 0;

    const rekeyed = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "PUT",
      cookie: cookieValue,
      body: { apiKey: "sk-second" },
    });

    expect(rekeyed.status).toBe(200);
    expect(calls).toEqual(["codex", `account:${account.id}`]);

    calls.length = 0;

    const removed = await request(h.app, `/api/opencode/accounts/${account.id}`, {
      method: "DELETE",
      cookie: cookieValue,
    });

    expect(removed.status).toBe(204);
    expect(calls).toEqual(["codex"]);
  });
});

describe("排他区間内の存在確認", () => {
  test("検証の後に消されたアカウントは not_found にし、snapshot を書き戻さない", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-portal-opencode-race-"));
    const db = openDatabase(join(root, "data"));
    const accounts = createOpenCodeAccounts({
      credentialDir: join(root, "credentials"),
      now: () => BASE_TIME,
      log: () => {},
    });
    const account = accounts.create({ name: "メイン", icon: "🦊", apiKey: KEY });

    dirs.push(root);
    handles.push(db);

    const api = createOpenCodeApi({
      accounts,
      db,
      sampler: {
        exclusive: async (fn: () => void) => {
          // キー検証を終えた直後に、別の要求が削除した状態を作る。
          accounts.remove(account.id);
          fn();
        },
      },
      fetchUsage: async () => usageSnapshot({ provider: "opencode-go", name: "OpenCode Go", capturedAt: BASE_TIME }),
    });

    expect(await api.update(account.id, { name: "サブ", apiKey: "sk-second" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(accounts.list()).toEqual([]);
    expect(
      loadProviderUsage(db, [openCodeSourceId(account.id)]).get(openCodeSourceId(account.id))?.snapshot,
    ).toBeNull();
  });
});
