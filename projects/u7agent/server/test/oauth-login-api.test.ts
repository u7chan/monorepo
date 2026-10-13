// OAuth サインインの HTTP 契約 (POST /login, POST /login/code, DELETE /login, POST /logout)。
// 実 SDK は呼ばず stub pi で検証する (port 1455 を掴むコールバックサーバーは SDK 側の責務)。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createBffApp } from "../src/app";
import { DEVICE_ID_PATH } from "../src/device-id";
import {
  OAUTH_LOGIN_FAILED_PORT_MESSAGE,
  OAUTH_LOGIN_IN_PROGRESS_MESSAGE,
  OAUTH_LOGIN_TARGET_MESSAGE,
  OAUTH_LOGOUT_TARGET_MESSAGE,
} from "../src/oauth-login";
import type { ModelsSettingsResponse, ProviderAuthSetting } from "../src/schema";
import { asPiBff, createStubPi, waitFor, type StubPiOptions } from "./stub-pi";

const AUTH_URL = "https://auth.example.test/api/accounts/authorize?state=dummy";
const PASTED_URL = "http://127.0.0.1:1455/auth/callback?code=dummy-code&state=dummy";
const KEY = "sk-openai-dummy-key-0123456789";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Bff = Awaited<ReturnType<typeof createBffApp>>;

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-oauth-login-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** OAuth を持つ provider 1 件だけの stub 設定 */
function stubOptions(options: StubPiOptions = {}): StubPiOptions {
  return {
    providers: [
      {
        provider: "openai",
        name: "OpenAI",
        supportsOAuth: true,
        oauthLoginLabel: "Sign in with ChatGPT",
        canSetApiKey: false,
      },
    ],
    ...options,
  };
}

function providerOf(response: { providers: ProviderAuthSetting[] }): ProviderAuthSetting {
  const entry = response.providers.find((provider) => provider.provider === "openai");
  assert.ok(entry, "openai の行がある");
  return entry;
}

async function getProvider(bff: Bff): Promise<ProviderAuthSetting> {
  const response = await bff.app.request("/api/settings/models");
  assert.equal(response.status, 200);
  return providerOf((await response.json()) as ModelsSettingsResponse);
}

/** サインインはサーバー側で進むため、GET を読み直して待つ (クライアントのポーリングと同じ形) */
async function waitForProvider(bff: Bff, predicate: (entry: ProviderAuthSetting) => boolean) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const entry = await getProvider(bff);
    if (predicate(entry)) return entry;
    if (Date.now() > deadline) throw new Error("provider state did not reach the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

test("開始 / コード送信 / 完了の流れで認可 URL と完了状態を公開する", async () => {
  await withStoreDir(async (dir) => {
    let pasted: string | undefined;
    const pi = createStubPi(
      stubOptions({
        agentDir: dir,
        onOAuthLogin: async (_provider, interaction: AuthInteraction) => {
          interaction.notify({ type: "auth_url", url: AUTH_URL, instructions: "Complete sign-in in your browser." });
          pasted = await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const startedResponse = await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
      assert.equal(startedResponse.status, 200);
      const started = (await startedResponse.json()) as ModelsSettingsResponse;
      const running = providerOf(started);
      assert.equal(running.login?.status, "running");
      assert.equal(running.login?.authUrl, AUTH_URL, "進行中は認可 URL をクライアントへ渡す");
      assert.ok(running.login?.instructions, "案内は固定文言で出す");
      assert.ok(
        !JSON.stringify(started).includes("Complete sign-in in your browser"),
        "SDK の英語の案内をそのまま出さない",
      );
      assert.ok(running.login?.input, "貼り付け欄を公開する");

      // 進行中の二重開始は 409 (login は 1 回だけ)
      const conflict = await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json()) as { error: string }).error, OAUTH_LOGIN_IN_PROGRESS_MESSAGE);
      assert.equal(pi.oauthCalls.filter((call) => call.operation === "login").length, 1);

      const submitted = await bff.app.request("/api/settings/models/openai/login/code", postJson({ code: PASTED_URL }));
      assert.equal(submitted.status, 200);
      assert.equal(providerOf((await submitted.json()) as ModelsSettingsResponse).login?.status, "running");

      const done = await waitForProvider(bff, (entry) => entry.login?.status === "succeeded");
      assert.equal(done.login?.authUrl, null, "終端では認可 URL を落とす");
      assert.equal(done.login?.input, null);
      assert.equal(done.login?.error, null);
      assert.equal(done.auth.configured, true);
      assert.equal(done.credentialKind, "oauth");
      assert.equal(pasted, PASTED_URL, "貼り付けは加工せず SDK へ渡す");
      assert.equal(done.managed, false, "OAuth はアプリ DB へ複製しない");

      // 完了後の [閉じる] は結果表示を消す (冪等)
      const closed = await bff.app.request("/api/settings/models/openai/login", { method: "DELETE" });
      assert.equal(closed.status, 200);
      assert.equal(providerOf((await closed.json()) as ModelsSettingsResponse).login, null);

      // device id は agent dir 配下へ永続化される
      const loginCall = pi.oauthCalls.find((call) => call.operation === "login");
      assert.match(loginCall?.deviceId ?? "", UUID_PATTERN);
      assert.equal(loginCall?.agentName, "u7agent");
      assert.equal((await readFile(join(dir, DEVICE_ID_PATH), "utf8")).trim(), loginCall?.deviceId);
    } finally {
      await bff.close();
    }
  });
});

test("再起動しても同じ device id を SDK へ渡す", async () => {
  await withStoreDir(async (dir) => {
    const seen: string[] = [];
    const runOnce = async () => {
      const pi = createStubPi(stubOptions({ agentDir: dir, onOAuthLogin: () => Promise.resolve() }));
      const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
      try {
        await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
        await waitFor(() => pi.oauthCalls.length === 1, 3000, "login 呼び出し");
        seen.push(pi.oauthCalls[0].deviceId ?? "");
      } finally {
        await bff.close();
      }
    };
    await runOnce();
    await runOnce();
    assert.match(seen[0], UUID_PATTERN);
    assert.equal(seen[1], seen[0], "プロセスをまたいで同じ agent host ID を使う");
  });
});

test("中断は state を cancelled にし、SDK の signal を abort する", async () => {
  await withStoreDir(async (dir) => {
    let aborted = false;
    const pi = createStubPi(
      stubOptions({
        agentDir: dir,
        onOAuthLogin: async (_provider, interaction: AuthInteraction) => {
          interaction.notify({ type: "auth_url", url: AUTH_URL });
          interaction.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }).catch(() => {});
          if (interaction.signal?.aborted) throw new Error("Login cancelled");
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
      await waitForProvider(bff, (entry) => entry.login?.input !== null);
      const cancelled = await bff.app.request("/api/settings/models/openai/login", { method: "DELETE" });
      assert.equal(cancelled.status, 200);
      const state = providerOf((await cancelled.json()) as ModelsSettingsResponse);
      assert.equal(state.login?.status, "cancelled");
      assert.equal(state.login?.authUrl, null);
      assert.equal(aborted, true, "中断で SDK のコールバックサーバーを閉じる");

      // 中断した state を成功で上書きしない
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await getProvider(bff)).login?.status, "cancelled");
    } finally {
      await bff.close();
    }
  });
});

test("port 競合は画面用の固定文言に寄せ、生の英語を出さない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        agentDir: dir,
        onOAuthLogin: () =>
          Promise.reject(
            new Error(
              "Port 1455 is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again.",
            ),
          ),
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
      const failed = await waitForProvider(bff, (entry) => entry.login?.status === "failed");
      assert.equal(failed.login?.error, OAUTH_LOGIN_FAILED_PORT_MESSAGE);
      assert.ok(!JSON.stringify(failed).includes("is in use"), "SDK の生の文言を応答に出さない");
      assert.ok(pi.refreshCount > 0, "失敗でも公開 state を再計算する");
    } finally {
      await bff.close();
    }
  });
});

test("OAuth を持たない provider の開始は 400、サインアウトは保存が無いと 400", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi({ agentDir: dir, providers: [{ provider: "local", canSetApiKey: false }] });
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const start = await bff.app.request("/api/settings/models/local/login", { method: "POST" });
      assert.equal(start.status, 400);
      assert.equal(((await start.json()) as { error: string }).error, OAUTH_LOGIN_TARGET_MESSAGE);

      const logout = await bff.app.request("/api/settings/models/local/logout", { method: "POST" });
      assert.equal(logout.status, 400);
      assert.equal(((await logout.json()) as { error: string }).error, OAUTH_LOGOUT_TARGET_MESSAGE);
      assert.equal(pi.oauthCalls.length, 0, "拒否した要求は SDK へ渡さない");
    } finally {
      await bff.close();
    }
  });
});

test("貼り付けの本文が空 / 長すぎるときは SDK へ渡さず 400 にする", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        agentDir: dir,
        onOAuthLogin: async (_provider, interaction: AuthInteraction) => {
          interaction.notify({ type: "auth_url", url: AUTH_URL });
          await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/models/openai/login", { method: "POST" });
      assert.equal(
        (await bff.app.request("/api/settings/models/openai/login/code", postJson({ code: "   " }))).status,
        400,
      );
      assert.equal(
        (await bff.app.request("/api/settings/models/openai/login/code", postJson({ code: "x".repeat(4_097) }))).status,
        400,
      );
      const still = await getProvider(bff);
      assert.equal(still.login?.status, "running", "400 のあとも貼り付け待ちを保つ");
      assert.ok(still.login?.input);
    } finally {
      await bff.close();
    }
  });
});

test("サインアウトは auth.json の OAuth を消し、この画面で登録したキーは残す", async () => {
  await withStoreDir(async (dir) => {
    // 実 SDK と同じく、表示専用の読取は agent dir の auth.json を読む
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "oauth-access-must-not-leak",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const pi = createStubPi({
      agentDir: dir,
      providers: [
        {
          provider: "openai",
          name: "OpenAI",
          supportsOAuth: true,
          oauthLoginLabel: "Sign in with ChatGPT",
          canSetApiKey: true,
          oauth: true,
          configured: true,
          authSource: "stored",
        },
      ],
      onOAuthLogout: () => Promise.resolve(),
    });
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // この画面で登録したキーの行を作る (logout で消えないことを見る)
      const saved = await bff.app.request("/api/settings/models/openai/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: KEY }),
      });
      assert.equal(saved.status, 200);

      const before = await getProvider(bff);
      assert.equal(before.credentialKind, "api_key", "この画面のキーが実効になる");
      assert.equal(before.hiddenStoredOAuth, true, "保存済み OAuth はキーに覆われている");

      const logout = await bff.app.request("/api/settings/models/openai/logout", { method: "POST" });
      assert.equal(logout.status, 200);
      assert.deepEqual(
        pi.oauthCalls.map((call) => call.operation),
        ["logout"],
      );
      const after = providerOf((await logout.json()) as ModelsSettingsResponse);
      assert.equal(after.managed, true, "この画面で登録したキーの行は残す");
      assert.equal(after.credentialKind, "api_key");
      assert.ok(!JSON.stringify(after).includes(KEY), "キー値は応答へ載せない");
    } finally {
      await bff.close();
    }
  });
});
