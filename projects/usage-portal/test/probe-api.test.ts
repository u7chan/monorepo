// probe の HTTP 契約（認証 / Origin / 設定の検証 / 送信結果の丸め / 404 / 409 / 503）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { buildHealthReport } from "../src/server/health";
import { createProbeApi } from "../src/server/probe/api";
import { createProbeRunner, type ProbeStreamProvider } from "../src/server/probe/service";
import { readProbeCatalog } from "../src/server/probe/catalog";
import type { ProbeOutcome } from "../src/server/probe/service";
import { createProbeSettings, PROBE_SETTINGS_FILE } from "../src/server/probe/settings";
import { BASE_TIME, EMPTY_USAGE, stubAccount, stubCodexApi, stubOpenCodeApi } from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const dirs: string[] = [];

type Harness = {
  app: ReturnType<typeof createApp>;
  dataDir: string;
  calls: string[];
  settings: ReturnType<typeof createProbeSettings>;
};

function harness(
  options: {
    outcome?: ProbeOutcome;
    accounts?: string[];
    blockedSettings?: boolean;
    /** 実 service を通す。設定の有無で 409 になることを end-to-end で確かめる。 */
    realRunner?: boolean;
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "usage-portal-probe-api-"));

  dirs.push(root);

  const dataDir = join(root, "data");

  if (options.blockedSettings === true) {
    // 一時ファイルの置き場をディレクトリで塞ぎ、atomic write を失敗させる。
    mkdirSync(join(dataDir, `${PROBE_SETTINGS_FILE}.tmp`), { recursive: true });
  }

  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  const settings = createProbeSettings({ dataDir, log: () => {} });
  const calls: string[] = [];
  const outcome = options.outcome ?? { ok: true, latencyMs: 12 };
  const neverCalled: ProbeStreamProvider = {
    streamSimple: () => {
      throw new Error("probe の送信は呼ばれない前提");
    },
  };
  const runner = options.realRunner
    ? createProbeRunner({
        settings,
        accounts: {
          get: () => stubAccount(),
          apiKey: () => "sk-probe-key",
        },
        credential: async () => ({ accessToken: "token" }),
        userAgent: "usage-portal-test/0.0.0",
        kick: async () => {},
        log: () => {},
        providers: { codex: neverCalled, opencodeGo: neverCalled },
      })
    : {
        checkCodex: async () => {
          calls.push("codex");

          return outcome;
        },
        checkOpenCode: async (id: string) => {
          calls.push(`opencode-go:${id}`);

          return outcome;
        },
      };
  const probe = createProbeApi({ settings, runner });
  const ids = options.accounts ?? ["account-1"];

  auth.ensureSessionKey();

  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex: stubCodexApi(),
    opencode: stubOpenCodeApi({ list: () => ids.map((id) => stubAccount({ id })) }),
    probe,
    health: () => buildHealthReport("ok", auth.status()),
    now: () => BASE_TIME,
    clientKey: () => "test-client",
  });

  return { app, dataDir, calls, settings };
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
  h: Harness,
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
    h.app.request(
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

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("認証と Origin", () => {
  test("probe の API は未認証を 401、Origin の無い書き込みを 403 にする", async () => {
    const h = harness();

    for (const [method, path] of [
      ["GET", "/api/probe/models"],
      ["GET", "/api/codex/probe"],
      ["PUT", "/api/codex/probe"],
      ["DELETE", "/api/codex/probe"],
      ["POST", "/api/codex/check"],
      ["POST", "/api/opencode/accounts/account-1/check"],
    ] as const) {
      expect((await request(h, path, { method })).status).toBe(401);
    }

    const cookieValue = await cookie(h.app);

    for (const [method, path] of [
      ["PUT", "/api/codex/probe"],
      ["DELETE", "/api/codex/probe"],
      ["POST", "/api/codex/check"],
      ["POST", "/api/opencode/accounts/account-1/check"],
    ] as const) {
      expect((await request(h, path, { method, cookie: cookieValue, origin: null })).status).toBe(403);
      expect((await request(h, path, { method, cookie: cookieValue, origin: "https://example.test" })).status).toBe(
        403,
      );
    }

    expect(h.calls).toEqual([]);
  });
});

describe("GET /api/probe/models", () => {
  test("provider 別に id・name・思考レベル・基本コストを返し、秘密を含めない", async () => {
    const h = harness();
    const response = await request(h, "/api/probe/models", { method: "GET", cookie: await cookie(h.app) });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      codex: { id: string; name: string; thinkingLevels: string[]; cost: Record<string, number> }[];
      opencodeGo: { id: string; name: string; thinkingLevels: string[]; cost: Record<string, number> }[];
    };
    const catalog = readProbeCatalog();

    expect(body.codex.map((model) => model.id)).toEqual(catalog.codex.map((model) => model.id));
    expect(body.opencodeGo.map((model) => model.id)).toEqual(catalog.opencodeGo.map((model) => model.id));

    for (const model of [...body.codex, ...body.opencodeGo]) {
      expect(model.name).not.toBe("");
      expect(model.thinkingLevels.length).toBeGreaterThan(0);
      expect(Object.keys(model.cost).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
    }

    const text = JSON.stringify(body);

    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("access-token");
    // Google の adapter しか持たないモデルは probe の対象外。
    expect(body.opencodeGo.some((model) => model.id === "gemini-3-pro")).toBe(false);
  });
});

describe("GET / PUT / DELETE /api/codex/probe", () => {
  test("初期値は未設定で、保存すると 0600 の settings.json に書かれ、解除で null に戻る", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    const initial = await request(h, "/api/codex/probe", { method: "GET", cookie: cookieValue });

    expect(await initial.json()).toEqual({ codex: null });

    const saved = await request(h, "/api/codex/probe", {
      method: "PUT",
      cookie: cookieValue,
      body: { model: "gpt-6-luna", thinking: "low" },
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ codex: { model: "gpt-6-luna", thinking: "low" } });

    const path = join(h.dataDir, PROBE_SETTINGS_FILE);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      probe: { codex: { model: "gpt-6-luna", thinking: "low" } },
    });

    const reread = await request(h, "/api/codex/probe", { method: "GET", cookie: cookieValue });

    expect(await reread.json()).toEqual({ codex: { model: "gpt-6-luna", thinking: "low" } });

    const cleared = await request(h, "/api/codex/probe", { method: "DELETE", cookie: cookieValue });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ codex: null });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ probe: { codex: null } });
  });

  test("catalog に無いモデルは invalid_model、対応しない思考レベルは invalid_thinking で拒否する", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    for (const [body, error] of [
      [{ model: "no-such-model", thinking: "low" }, "invalid_model"],
      [{ model: "gpt-6-astra", thinking: "off" }, "invalid_thinking"],
      [{ model: "gpt-6-astra", thinking: "unknown" }, "invalid_thinking"],
      [{ thinking: "low" }, "invalid_model"],
      [{ model: 42, thinking: "low" }, "invalid_model"],
      [{}, "invalid_model"],
    ] as const) {
      const response = await request(h, "/api/codex/probe", { method: "PUT", cookie: cookieValue, body });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    }

    expect(existsSync(join(h.dataDir, PROBE_SETTINGS_FILE))).toBe(false);
    expect(h.settings.read()).toEqual({ codex: null });
  });

  test("壊れた body は 400、大きすぎる body は 413 にし、どちらも保存しない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    const broken = await request(h, "/api/codex/probe", { method: "PUT", cookie: cookieValue, raw: "not json" });

    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: "invalid_request" });

    const array = await request(h, "/api/codex/probe", { method: "PUT", cookie: cookieValue, body: [] });

    expect(array.status).toBe(400);
    expect(await array.json()).toEqual({ error: "invalid_request" });

    const large = await request(h, "/api/codex/probe", {
      method: "PUT",
      cookie: cookieValue,
      body: { model: "gpt-6-luna", thinking: "low", padding: "a".repeat(2048) },
    });

    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: "invalid_request" });
    expect(existsSync(join(h.dataDir, PROBE_SETTINGS_FILE))).toBe(false);
  });

  test("2 KiB を超える body の解除は 413 にし、保存済みの設定を変えない", async () => {
    const h = harness();
    const cookieValue = await cookie(h.app);

    const saved = await request(h, "/api/codex/probe", {
      method: "PUT",
      cookie: cookieValue,
      body: { model: "gpt-6-luna", thinking: "low" },
    });

    expect(saved.status).toBe(200);

    const large = await request(h, "/api/codex/probe", {
      method: "DELETE",
      cookie: cookieValue,
      body: { padding: "a".repeat(2048) },
    });

    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: "invalid_request" });
    expect(h.settings.read()).toEqual({ codex: { model: "gpt-6-luna", thinking: "low" } });

    // 空の body なら今までどおり解除できる。
    const cleared = await request(h, "/api/codex/probe", { method: "DELETE", cookie: cookieValue });

    expect(cleared.status).toBe(200);
    expect(h.settings.read()).toEqual({ codex: null });
  });

  test("設定を書けないときは 503 を返し、probe を有効にしない", async () => {
    const h = harness({ blockedSettings: true });
    const response = await request(h, "/api/codex/probe", {
      method: "PUT",
      cookie: await cookie(h.app),
      body: { model: "gpt-6-luna", thinking: "low" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});

describe("POST /api/codex/check", () => {
  test("成功は latency だけを返す", async () => {
    const h = harness({ outcome: { ok: true, latencyMs: 1234 } });
    const response = await request(h, "/api/codex/check", { method: "POST", cookie: await cookie(h.app) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ latencyMs: 1234 });
    expect(h.calls).toEqual(["codex"]);
  });

  test("失敗コードを status へ丸め、上流の本文を返さない", async () => {
    const cases = [
      ["not_configured", 409],
      ["in_progress", 409],
      ["reauth_required", 409],
      ["limit_reached", 409],
      ["model_unavailable", 400],
      ["invalid_thinking", 400],
      ["unavailable", 503],
    ] as const;

    for (const [error, status] of cases) {
      const h = harness({ outcome: { ok: false, error } });
      const response = await request(h, "/api/codex/check", { method: "POST", cookie: await cookie(h.app) });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  test("設定が無ければ 409 not_configured を返し、上流へ送らない", async () => {
    const h = harness({ realRunner: true });
    const response = await request(h, "/api/codex/check", { method: "POST", cookie: await cookie(h.app) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });
});

describe("POST /api/opencode/accounts/:id/check", () => {
  test("未知のアカウントは 404 で、probe を呼ばない", async () => {
    const h = harness();
    const response = await request(h, "/api/opencode/accounts/missing/check", {
      method: "POST",
      cookie: await cookie(h.app),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(h.calls).toEqual([]);
  });

  test("接続確認の設定が無ければ 409 not_configured を返す", async () => {
    const h = harness({ realRunner: true });
    const response = await request(h, "/api/opencode/accounts/account-1/check", {
      method: "POST",
      cookie: await cookie(h.app),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  test("登録済みなら latency を返し、失敗は invalid_key を 400 にする", async () => {
    const ok = harness({ outcome: { ok: true, latencyMs: 9 } });
    const okResponse = await request(ok, "/api/opencode/accounts/account-1/check", {
      method: "POST",
      cookie: await cookie(ok.app),
    });

    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({ latencyMs: 9 });
    expect(ok.calls).toEqual(["opencode-go:account-1"]);

    const invalid = harness({ outcome: { ok: false, error: "invalid_key" } });
    const invalidResponse = await request(invalid, "/api/opencode/accounts/account-1/check", {
      method: "POST",
      cookie: await cookie(invalid.app),
    });

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({ error: "invalid_key" });
  });
});
