// /api/codex/* の HTTP 契約（認証必須、進行中の 409、生のエラーを返さないこと）を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createApp } from "../src/server/app";
import { createAuthService } from "../src/server/auth";
import { createCodexApi } from "../src/server/codex/api";
import type { CodexAuth } from "../src/server/codex/auth";
import { createCodexLoginService } from "../src/server/codex/login";
import { openDatabase, loadSamples, saveProviderSnapshot, type DatabaseHandle } from "../src/server/db";
import { buildHealthReport } from "../src/server/health";
import { BASE_TIME, EMPTY_USAGE, stubOpenCodeApi, stubProbeApi, usageSnapshot } from "./support";

const PIN = "123456";
const ORIGIN = "http://localhost";
const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

type Harness = {
  app: ReturnType<typeof createApp>;
  db: DatabaseHandle;
  refreshes: number;
  cookie: () => Promise<string>;
};

function harness(
  options: {
    login?: (interaction: AuthInteraction) => Promise<void>;
    signedIn?: boolean;
    logout?: () => Promise<void>;
    accountId?: string | null;
  } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "usage-portal-codex-api-"));
  const auth = createAuthService({ dataDir, now: () => BASE_TIME });
  const db = openDatabase(join(dataDir, "usage.sqlite"));
  const state: { refreshes: number } = { refreshes: 0 };

  dirs.push(dataDir);
  handles.push(db);
  auth.ensureSessionKey();

  const codexAuth: CodexAuth = {
    signedIn: () => options.signedIn ?? false,
    accountId: () => options.accountId ?? null,
    credential: async () => ({ accessToken: "token-sentinel", accountId: "account-sentinel" }),
    login: options.login ?? (async () => {}),
    logout: options.logout ?? (async () => {}),
  };
  const login = createCodexLoginService({
    auth: codexAuth,
    onSuccess: async () => {},
    authUrlWaitMs: 0,
    log: () => {},
  });
  const codex = createCodexApi({
    auth: codexAuth,
    login,
    db,
    sampler: {
      exclusive: async (fn) => {
        fn();
        state.refreshes += 1;
      },
    },
  });
  const app = createApp({
    auth,
    usage: () => EMPTY_USAGE,
    codex,
    opencode: stubOpenCodeApi(),
    probe: stubProbeApi(),
    health: () => buildHealthReport("ok", auth.status()),
    now: () => BASE_TIME,
    clientKey: () => "test-client",
  });

  return {
    app,
    db,
    get refreshes() {
      return state.refreshes;
    },
    async cookie() {
      const response = await app.request(
        new Request("http://localhost/api/auth/setup", {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ pin: PIN }),
        }),
      );

      expect(response.status).toBe(201);

      return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    },
  };
}

function selectScenario(interaction: AuthInteraction): Promise<void> {
  return interaction
    .prompt({
      type: "select",
      message: "Select OpenAI Codex login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    })
    .then(() => {});
}

function selectOnceScenario(interaction: AuthInteraction): Promise<void> {
  return interaction
    .prompt({ type: "select", message: "Select", options: [{ id: "device_code", label: "Device code" }] })
    .then(() => {});
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("状態が変わりませんでした");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function post(h: Harness, path: string, body: unknown, cookie: string) {
  return h.app.request(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
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

describe("GET /api/codex/auth", () => {
  test("未認証は 401", async () => {
    const h = harness();
    const response = await h.app.request("/api/codex/auth");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("サインイン状態と進行中のサインインを返す", async () => {
    const h = harness({ signedIn: true });
    const cookie = await h.cookie();
    const response = await h.app.request("/api/codex/auth", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: true, login: null });
  });
});

describe("POST /api/codex/login", () => {
  test("開始すると 202 と進行中の状態を返し、二重開始は 409", async () => {
    const h = harness({ login: selectScenario });
    const cookie = await h.cookie();
    const started = await post(h, "/api/codex/login", {}, cookie);

    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      signedIn: false,
      login: {
        status: "running",
        prompt: { type: "select", message: "サインイン方法を選んでください" },
      },
    });

    const again = await post(h, "/api/codex/login", {}, cookie);

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "login_in_progress" });
  });

  test("Origin の無い POST は 403", async () => {
    const h = harness({ login: selectScenario });
    const cookie = await h.cookie();
    const response = await h.app.request(
      new Request("http://localhost/api/codex/login", { method: "POST", headers: { cookie } }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_mismatch" });
  });
});

describe("POST /api/codex/login/respond", () => {
  test("選択と貼り付けを受け付け、待っていない・選択肢に無い値は 400", async () => {
    const h = harness({
      login: async (interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Select",
          options: [{ id: "device_code", label: "Device code" }],
        });
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://example.invalid/d",
        });
        await new Promise(() => {});
      },
    });
    const cookie = await h.cookie();

    await post(h, "/api/codex/login", {}, cookie);

    const invalid = await post(h, "/api/codex/login/respond", { value: "browser" }, cookie);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_response" });

    const accepted = await post(h, "/api/codex/login/respond", { value: "device_code" }, cookie);

    expect(accepted.status).toBe(204);

    const notWaiting = await post(h, "/api/codex/login/respond", { value: "device_code" }, cookie);

    expect(notWaiting.status).toBe(400);
    expect(await notWaiting.json()).toEqual({ error: "no_prompt" });
  });

  test("進行中でなければ 409", async () => {
    const h = harness();
    const cookie = await h.cookie();
    const response = await post(h, "/api/codex/login/respond", { value: "device_code" }, cookie);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "login_not_running" });
  });

  test("body が壊れていれば 400、4 KiB を超えれば 413", async () => {
    const h = harness();
    const cookie = await h.cookie();

    const broken = await h.app.request(
      new Request("http://localhost/api/codex/login/respond", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: "{",
      }),
    );

    expect(broken.status).toBe(400);

    const huge = await post(h, "/api/codex/login/respond", { value: "a".repeat(5000) }, cookie);

    expect(huge.status).toBe(413);
  });
});

describe("DELETE /api/codex/login", () => {
  test("進行中のサインインを中断し、冪等", async () => {
    const h = harness({
      login: async () => {
        await new Promise(() => {});
      },
    });
    const cookie = await h.cookie();

    await post(h, "/api/codex/login", {}, cookie);

    const first = await h.app.request(
      new Request("http://localhost/api/codex/login", { method: "DELETE", headers: { origin: ORIGIN, cookie } }),
    );

    expect(first.status).toBe(204);

    const state = await h.app.request("/api/codex/auth", { headers: { cookie } });

    expect(await state.json()).toMatchObject({ login: { status: "cancelled", authUrl: null } });

    const second = await h.app.request(
      new Request("http://localhost/api/codex/login", { method: "DELETE", headers: { origin: ORIGIN, cookie } }),
    );

    expect(second.status).toBe(204);
  });
});

describe("POST /api/codex/logout", () => {
  test("snapshot を排他区間で消して取得し直す", async () => {
    const h = harness({ accountId: "account-1" });
    const cookie = await h.cookie();

    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot());

    const response = await h.app.request(
      new Request("http://localhost/api/codex/logout", { method: "POST", headers: { origin: ORIGIN, cookie } }),
    );

    expect(response.status).toBe(204);
    expect(h.refreshes).toBe(1);
    expect(h.db.db.query("SELECT COUNT(*) AS count FROM provider_snapshot").get()).toEqual({ count: 0 });
  });

  test("sample は残し、同じアカウントで戻ったときの推移を引き継ぐ", async () => {
    const h = harness({ accountId: "account-1" });
    const cookie = await h.cookie();

    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot({ capturedAt: BASE_TIME - 300_000 }));
    saveProviderSnapshot(h.db, "codex:account-1", usageSnapshot());

    const response = await h.app.request(
      new Request("http://localhost/api/codex/logout", { method: "POST", headers: { origin: ORIGIN, cookie } }),
    );

    expect(response.status).toBe(204);
    expect(loadSamples(h.db, "codex:account-1", "primary", 0)).toHaveLength(2);
  });

  test("サインアウトで成功状態の表示も消し、すぐ開始し直せる", async () => {
    const h = harness({ login: selectOnceScenario });
    const cookie = await h.cookie();

    await post(h, "/api/codex/login", {}, cookie);
    await post(h, "/api/codex/login/respond", { value: "device_code" }, cookie);
    await waitFor(async () => {
      const state = await h.app.request("/api/codex/auth", { headers: { cookie } });
      const body = (await state.json()) as { login: { status: string } | null };

      return body.login?.status === "succeeded";
    });

    const loggedOut = await h.app.request(
      new Request("http://localhost/api/codex/logout", { method: "POST", headers: { origin: ORIGIN, cookie } }),
    );

    expect(loggedOut.status).toBe(204);

    const state = await h.app.request("/api/codex/auth", { headers: { cookie } });

    expect(await state.json()).toEqual({ signedIn: false, login: null });
  });

  test("SDK の失敗は固定の分類だけを返す", async () => {
    const h = harness({
      logout: async () => {
        throw new Error("token=token-sentinel");
      },
    });
    const cookie = await h.cookie();
    const response = await h.app.request(
      new Request("http://localhost/api/codex/logout", { method: "POST", headers: { origin: ORIGIN, cookie } }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({ error: "logout_failed" }));
    expect(h.refreshes).toBe(0);
  });
});
