// 設定 → モデルの OAuth サインインのサービス契約。実 SDK は呼ばず、fake の OAuthLoginRuntime で
// interaction の分岐・状態遷移・中断・固定文言を検証する。
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  canSignInHere,
  classifyOAuthLoginFailure,
  OAUTH_LOGIN_AUTHORIZE_INSTRUCTIONS,
  OAUTH_LOGIN_FAILED_DENIED_MESSAGE,
  OAUTH_LOGIN_FAILED_MESSAGE,
  OAUTH_LOGIN_FAILED_PORT_MESSAGE,
  OAUTH_LOGIN_IN_PROGRESS_MESSAGE,
  OAUTH_LOGIN_INPUT_MESSAGE,
  OAUTH_LOGIN_NOT_RUNNING_MESSAGE,
  OAUTH_LOGIN_NO_INPUT_MESSAGE,
  OAUTH_LOGIN_TARGET_MESSAGE,
  OAUTH_LOGIN_TIMED_OUT_MESSAGE,
  OAUTH_LOGIN_UNSUPPORTED_MESSAGE,
  OAUTH_LOGOUT_FAILED_MESSAGE,
  OAUTH_LOGOUT_TARGET_MESSAGE,
  OAuthLoginService,
  oauthLoginFailureMessage,
  type OAuthLoginRuntime,
} from "../src/oauth-login";
import type { OAuthLoginState } from "../src/schema";

const AUTH_URL = "https://auth.example.test/api/accounts/authorize?state=dummy";
const DEADLINE_MS = 1_000;

/** fake timer を進めた後の SDK の login とサービス側の await 連鎖を流す (setImmediate は mock しない) */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** fake の SDK 面。login の振る舞いだけをテストごとに差し替え、呼び出しを記録する */
function fakeRuntime(
  options: {
    providers?: { provider: string; supportsOAuth?: boolean; oauthLoginLabel?: string | null }[];
    /** auth.json の保存値 (表示専用)。undefined は「無い / 読めない」 */
    stored?: "oauth" | "api_key";
    storedThrows?: boolean;
    /** SDK が見ている種別 */
    credential?: "oauth" | null;
    login?: (provider: string, interaction: AuthInteraction) => Promise<void>;
    logout?: (provider: string, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const providers = options.providers ?? [{ provider: "openai", supportsOAuth: true }];
  const calls = { login: [] as string[], logout: [] as string[], signal: null as AbortSignal | null };
  const runtime: OAuthLoginRuntime = {
    list: () =>
      providers.map((entry) => ({
        provider: entry.provider,
        supportsOAuth: entry.supportsOAuth ?? false,
        oauthLoginLabel: entry.oauthLoginLabel ?? null,
      })),
    loginOAuth: async (provider, interaction) => {
      calls.login.push(provider);
      await options.login?.(provider, interaction);
    },
    logoutOAuth: async (provider, { signal }) => {
      calls.logout.push(provider);
      calls.signal = signal;
      await options.logout?.(provider, signal);
    },
    credentialKind: () => options.credential ?? null,
    storedCredentialKind: () => {
      if (options.storedThrows) throw new Error("auth.json read failed");
      return options.stored;
    },
  };
  return { runtime, calls };
}

/** interaction の manual_code を待たせる login。中断・貼り付けのどちらでも終わる */
function pendingLogin(interaction: AuthInteraction): Promise<void> {
  interaction.notify({ type: "auth_url", url: AUTH_URL, instructions: "Continue in your browser." });
  return interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }).then(
    () => undefined,
    () => undefined,
  );
}

function service(
  runtime: OAuthLoginRuntime | null,
  hooks: {
    refresh?: () => Promise<void>;
    waitForAuthUrlMs?: number;
    /** サインインの絶対期限。既定 (10 分) を使うとテストは期限まで進めない */
    loginDeadlineMs?: number;
    /** サインアウト直後のキー写し直しの模倣。throw で失敗経路を再現できる */
    reapplyStoredKey?: (provider: string) => Promise<void>;
  } = {},
) {
  const refreshes: number[] = [];
  const reapplied: string[] = [];
  const instance = new OAuthLoginService({
    runtime,
    refresh: async () => {
      refreshes.push(Date.now());
      await hooks.refresh?.();
    },
    reapplyStoredKey: async (provider) => {
      reapplied.push(provider);
      await hooks.reapplyStoredKey?.(provider);
    },
    maskError: (text) => text,
    waitForAuthUrlMs: hooks.waitForAuthUrlMs ?? 0,
    logoutTimeoutMs: 50,
    loginDeadlineMs: hooks.loginDeadlineMs,
  });
  return { instance, refreshes, reapplied };
}

async function waitForState(
  instance: OAuthLoginService,
  provider: string,
  predicate: (state: OAuthLoginState) => boolean,
): Promise<OAuthLoginState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = instance.stateOf(provider);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("state did not reach the expected condition");
}

test("開始は進行中の state を公開し、認可 URL は終端で落ちる", async () => {
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL, instructions: "Continue." });
      interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const { instance, refreshes } = service(runtime.runtime);
  assert.equal(await instance.start("openai").then((outcome) => outcome.status), 200);
  const running = await waitForState(instance, "openai", (state) => state.input !== null);
  assert.equal(running.status, "running");
  assert.equal(running.authUrl, AUTH_URL, "進行中は認可 URL を公開する");
  assert.equal(running.instructions, OAUTH_LOGIN_AUTHORIZE_INSTRUCTIONS, "SDK の案内文は固定日本語へ寄せる");
  assert.equal(running.progress, "認可コードをトークンと交換しています");
  assert.deepEqual(running.input, { message: OAUTH_LOGIN_INPUT_MESSAGE, placeholder: running.input?.placeholder });
  assert.equal(running.error, null);

  await instance.submitCode("openai", "http://127.0.0.1:1455/auth/callback?code=abc&state=dummy");
  const finished = await waitForState(instance, "openai", (state) => state.status === "succeeded");
  assert.equal(finished.authUrl, null, "終端では認可 URL を落とす (進行中の state としてだけ公開する)");
  assert.equal(finished.instructions, null);
  assert.equal(finished.input, null);
  assert.equal(finished.error, null);
  assert.equal(refreshes.length, 1, "完了で公開 state を 1 回再計算する");
});

test("認可 URL が届くまで開始の応答を待つ (届けば URL つきで返る)", async () => {
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      interaction.notify({ type: "auth_url", url: AUTH_URL, instructions: "Continue." });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const { instance } = service(runtime.runtime, { waitForAuthUrlMs: 500 });
  await instance.start("openai");
  assert.equal(instance.stateOf("openai")?.authUrl, AUTH_URL);
});

test("進行中の二重開始は 409 になり、SDK の login を重ねて呼ばない", async () => {
  const runtime = fakeRuntime({ login: (_provider, interaction) => pendingLogin(interaction) });
  const { instance } = service(runtime.runtime);
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.input !== null);
  await assert.rejects(
    () => instance.start("openai"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  );
  assert.equal(runtime.calls.login.length, 1);
  // 終端した後の再開始は通る (結果表示を置き換える)
  await instance.cancel("openai");
  assert.equal((await instance.start("openai")).status, 200);
  assert.equal(runtime.calls.login.length, 2);
  await instance.cancel("openai");
});

test("OAuth を持たない provider の開始は 400、ランタイム無しは 503", async () => {
  const runtime = fakeRuntime({ providers: [{ provider: "local", supportsOAuth: false }] });
  const { instance } = service(runtime.runtime);
  await assert.rejects(
    () => instance.start("local"),
    (error: unknown) => (error as { statusCode?: number; message?: string }).statusCode === 400,
  );
  assert.equal((await instance.start("local").catch((error) => error)).message, OAUTH_LOGIN_TARGET_MESSAGE);
  const unavailable = service(null).instance;
  await assert.rejects(
    () => unavailable.start("local"),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 503,
  );
});

// --- 画面がサインインの操作を出せる provider の許可リスト (表示専用) ---

/**
 * この表は `server/src/oauth-login.ts` の許可リストを固定する。組み込み provider の OAuth が増減したら
 * 下の網羅テストが落ちるので、分類を見直して両方を直す (SDK には追随しない)。
 */
const SIGN_IN_SUPPORTED = ["kimi-coding", "meta", "openai", "openrouter", "xai"];
const SIGN_IN_UNSUPPORTED = ["anthropic", "github-copilot", "openai-codex", "radius"];

test("サインインの可否は許可リストと OAuth の有無の両方で決まる", () => {
  for (const provider of SIGN_IN_SUPPORTED) {
    assert.equal(canSignInHere(provider, true), true, `${provider} はこの画面で完了できる`);
    assert.equal(canSignInHere(provider, false), false, "OAuth が無ければサインインの操作は出さない");
  }
  for (const provider of SIGN_IN_UNSUPPORTED) {
    assert.equal(canSignInHere(provider, true), false, `${provider} はこの画面で完了できない方式`);
  }
  // 許可リストに無い provider (models.json の独自 provider など) は出さない側へ倒す
  assert.equal(canSignInHere("models-json-custom", true), false);
});

test("OAuth を持つ組み込み provider は許可リストか既知の未対応かに必ず分類される", () => {
  // 検出できるのは組み込み provider まで。models.json 由来の provider は許可リストに無いので隠れる側に倒れる
  const builtinOAuthProviders = builtinProviders()
    .filter((provider) => Boolean(provider.auth?.oauth))
    .map((provider) => provider.id)
    .sort();
  assert.deepEqual(
    builtinOAuthProviders,
    [...SIGN_IN_SUPPORTED, ...SIGN_IN_UNSUPPORTED].sort(),
    "SDK が OAuth の provider を足したら、完了できるかの見直しが要る",
  );
});

test("login API はサインインの可否を見ない (画面に出さない provider でも開始はできる)", async () => {
  const runtime = fakeRuntime({
    providers: [{ provider: "openai-codex", supportsOAuth: true }],
    login: (_provider, interaction) =>
      interaction
        .prompt({ type: "select", message: "Select login method", options: [{ id: "a", label: "A" }] })
        .then(() => undefined),
  });
  const { instance } = service(runtime.runtime);
  // 直接叩いた場合は従来どおり開始を受け、扱えない対話で固定文言へ倒す (表示だけを制御する)
  assert.equal((await instance.start("openai-codex")).status, 200);
  const failed = await waitForState(instance, "openai-codex", (state) => state.status === "failed");
  assert.equal(failed.error, OAUTH_LOGIN_UNSUPPORTED_MESSAGE);
  assert.deepEqual(runtime.calls.login, ["openai-codex"]);
});

test("貼り付けは待機中だけ受け付け、返した値が SDK へ渡る", async () => {
  const received: string[] = [];
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      received.push(await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }));
    },
  });
  const { instance } = service(runtime.runtime);
  await assert.rejects(
    () => instance.submitCode("openai", "code"),
    (error: unknown) =>
      (error as { statusCode?: number; message?: string }).message === OAUTH_LOGIN_NOT_RUNNING_MESSAGE,
  );
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.input !== null);
  assert.equal((await instance.submitCode("openai", "  http://example.test/code  ")).status, 200);
  await waitForState(instance, "openai", (state) => state.status === "succeeded");
  assert.deepEqual(received, ["  http://example.test/code  "], "値はサービスで加工せず SDK へ渡す");
  // 交換中 (まだ running) にもう一度送ると、待機していないので 400
  await instance.submitCode("openai", "again").catch(() => {});
});

test("貼り付けを待っていない間の送信は 400", async () => {
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "device_code", userCode: "AB-12", verificationUri: AUTH_URL });
      // デバイスコード方式は入力を受け付けないため、完了まで待たせる
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });
  const { instance } = service(runtime.runtime);
  await instance.start("openai");
  const state = await waitForState(instance, "openai", (current) => current.userCode !== null);
  assert.equal(state.input, null);
  assert.equal(state.authUrl, AUTH_URL);
  assert.equal(
    (await instance.submitCode("openai", "code").catch((error) => error)).message,
    OAUTH_LOGIN_NO_INPUT_MESSAGE,
  );
});

test("中断は進行中の state を閉じ、SDK の signal を abort して公開 state を再計算する", async () => {
  let aborted = false;
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      const pending = interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
      interaction.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      await pending.catch(() => undefined);
      if (interaction.signal?.aborted) throw new Error("Login cancelled");
    },
  });
  const { instance, refreshes } = service(runtime.runtime);
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.input !== null);

  assert.equal((await instance.cancel("openai")).status, 200);
  const cancelled = await waitForState(instance, "openai", (state) => state.status === "cancelled");
  assert.equal(cancelled.authUrl, null);
  assert.equal(cancelled.input, null);
  assert.equal(aborted, true, "中断は SDK のコールバックサーバーと通信を閉じる");
  // 公開 state の再計算は SDK の login が返ったあと (中断直後の完了も拾うため)
  await waitForState(instance, "openai", () => refreshes.length > 0);
  assert.equal(refreshes.length, 1, "中断でも公開 state を 1 回再計算する");

  // 終端後の [中断] は結果表示の消去として動く (冪等。完了直後の押下を 400 にしない)
  assert.equal((await instance.cancel("openai")).status, 200);
  assert.equal(instance.stateOf("openai"), null);
  assert.equal((await instance.cancel("openai")).status, 200);
  assert.deepEqual(runtime.calls.login, ["openai"], "終端後の [中断] は login を呼ばない");
});

test("期限に達すると SDK のサインインを中断し、固定文言を返して公開 state を 1 回だけ再計算する", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      const pending = interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
      interaction.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      await pending.catch(() => undefined);
      if (interaction.signal?.aborted) throw new Error("Login cancelled");
    },
  });
  const { instance, refreshes } = service(runtime.runtime, { loginDeadlineMs: DEADLINE_MS });
  await instance.start("openai");
  assert.equal(instance.stateOf("openai")?.status, "running");

  t.mock.timers.tick(DEADLINE_MS);
  const expired = instance.stateOf("openai");
  assert.equal(expired?.status, "failed", "期限の到着で終端する");
  assert.equal(expired?.error, OAUTH_LOGIN_TIMED_OUT_MESSAGE, "残り時間ではなく固定文言で伝える");
  assert.equal(expired?.authUrl, null, "期限後は認可 URL を落とす");
  assert.equal(expired?.input, null, "期限後は貼り付け欄を落とす");
  await flushAsync();
  assert.equal(aborted, true, "SDK のコールバックサーバーと通信を閉じる");
  assert.equal(refreshes.length, 1, "期限でも公開 state を 1 回だけ再計算する");
});

test("期限後はコールバックと貼り付けを拒否し、同じ provider で次のログインを開始できる", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const interactions: AuthInteraction[] = [];
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interactions.push(interaction);
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }).catch(() => undefined);
    },
  });
  const { instance } = service(runtime.runtime, { loginDeadlineMs: DEADLINE_MS });
  await instance.start("openai");
  t.mock.timers.tick(DEADLINE_MS);
  await flushAsync();

  const expired = interactions[0];
  expired.notify({ type: "auth_url", url: AUTH_URL });
  assert.equal(instance.stateOf("openai")?.authUrl, null, "期限後の notify は状態を動かさない");
  await assert.rejects(() => expired.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }));
  assert.equal(instance.stateOf("openai")?.input, null, "期限後の prompt で入力欄を立てない");
  assert.equal(
    (await instance.submitCode("openai", "code").catch((error) => error)).message,
    OAUTH_LOGIN_NOT_RUNNING_MESSAGE,
    "期限後の貼り付けは進行中でないときと同じ 400",
  );

  assert.equal((await instance.start("openai")).status, 200, "期限後は同じ provider で開始できる (409 にならない)");
  assert.equal(runtime.calls.login.length, 2);
  await instance.cancel("openai");
});

test("成功・失敗・中断では期限が後から発火しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** 終端済みのサインインで、期限を大きく過ぎても状態と再計算が動かないことを見る */
  const assertNoLateDeadline = async (
    instance: OAuthLoginService,
    refreshes: number[],
    status: OAuthLoginState["status"],
  ) => {
    assert.equal(instance.stateOf("openai")?.status, status);
    const settled = refreshes.length;
    t.mock.timers.tick(DEADLINE_MS * 2);
    await flushAsync();
    assert.equal(instance.stateOf("openai")?.status, status, "終端したサインインの期限は後から発火しない");
    assert.equal(refreshes.length, settled, "発火した期限で公開 state を再計算しない");
  };

  const success = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const successRun = service(success.runtime, { loginDeadlineMs: DEADLINE_MS });
  await successRun.instance.start("openai");
  await successRun.instance.submitCode("openai", "code");
  await flushAsync();
  await assertNoLateDeadline(successRun.instance, successRun.refreshes, "succeeded");

  const failure = fakeRuntime({ login: () => Promise.reject(new Error("connect EADDRINUSE 127.0.0.1:1455")) });
  const failureRun = service(failure.runtime, { loginDeadlineMs: DEADLINE_MS });
  await failureRun.instance.start("openai");
  await flushAsync();
  await assertNoLateDeadline(failureRun.instance, failureRun.refreshes, "failed");

  const cancelled = fakeRuntime({ login: (_provider, interaction) => pendingLogin(interaction) });
  const cancelRun = service(cancelled.runtime, { loginDeadlineMs: DEADLINE_MS });
  await cancelRun.instance.start("openai");
  await cancelRun.instance.cancel("openai");
  await flushAsync();
  await assertNoLateDeadline(cancelRun.instance, cancelRun.refreshes, "cancelled");
});

test("port 競合と拒否は生の英語ではなく固定日本語になる", async () => {
  const runtime = fakeRuntime({
    login: () =>
      Promise.reject(
        new Error(
          "Port 1455 is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again.",
        ),
      ),
  });
  const portRun = service(runtime.runtime);
  await portRun.instance.start("openai");
  const failed = await waitForState(portRun.instance, "openai", (state) => state.status === "failed");
  assert.equal(failed.error, OAUTH_LOGIN_FAILED_PORT_MESSAGE);
  assert.ok(!JSON.stringify(failed).includes("is in use"), "SDK の生の文言を応答へ出さない");

  const denied = service(
    fakeRuntime({ login: () => Promise.reject(new Error("OpenAI authorization failed: access_denied")) }).runtime,
  );
  await denied.instance.start("openai");
  const refused = await waitForState(denied.instance, "openai", (state) => state.status === "failed");
  assert.equal(refused.error, OAUTH_LOGIN_FAILED_DENIED_MESSAGE);

  const secret = service(
    fakeRuntime({
      login: () =>
        Promise.reject(
          new Error("OpenAI OAuth token request failed (400): access_token=secret-token client_id=oaiapp_x"),
        ),
    }).runtime,
  );
  await secret.instance.start("openai");
  const unknown = await waitForState(secret.instance, "openai", (state) => state.status === "failed");
  assert.equal(unknown.error, OAUTH_LOGIN_FAILED_MESSAGE);
  assert.ok(!JSON.stringify(unknown).includes("secret-token"), "未知の失敗は生の文言を応答へ出さない");
});

test("select / text の対話はこの画面では扱わず、固定文言で失敗する", async () => {
  const runtime = fakeRuntime({
    login: (_provider, interaction) =>
      interaction
        .prompt({ type: "select", message: "Select login method", options: [{ id: "a", label: "A" }] })
        .then(() => undefined),
  });
  const { instance } = service(runtime.runtime);
  await instance.start("openai");
  const failed = await waitForState(instance, "openai", (state) => state.status === "failed");
  assert.equal(failed.error, OAUTH_LOGIN_UNSUPPORTED_MESSAGE);
  assert.equal(failed.input, null);
});

test("固定文言の分類は既知の理由だけを写す", () => {
  assert.equal(classifyOAuthLoginFailure("Port 1455 is in use, probably by ..."), "port_in_use");
  assert.equal(classifyOAuthLoginFailure("connect EADDRINUSE 127.0.0.1:1455"), "port_in_use");
  assert.equal(classifyOAuthLoginFailure("ChatGPT authorization failed: access_denied"), "denied");
  assert.equal(classifyOAuthLoginFailure("u7agent:unsupported-auth-prompt"), "unsupported");
  assert.equal(classifyOAuthLoginFailure("OpenAI OAuth token request failed (500)"), "unknown");
  assert.equal(oauthLoginFailureMessage("unknown"), OAUTH_LOGIN_FAILED_MESSAGE);
});

test("認可 URL 以外の scheme は公開しない", async () => {
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const { instance } = service(runtime.runtime);
  await instance.start("openai");
  const running = await waitForState(instance, "openai", (state) => state.input !== null);
  assert.equal(running.authUrl, null, "http(s) 以外は開かせない");
});

test("サインアウトは DB に残るキーを公開 state の再計算前に写し直し、失敗しても応答を変えない", async () => {
  const order: string[] = [];
  const runtime = fakeRuntime({ stored: "oauth" });
  const reapply = service(runtime.runtime, {
    reapplyStoredKey: async (provider) => {
      order.push(`reapply:${provider}`);
    },
    refresh: async () => {
      order.push("refresh");
    },
  });
  assert.equal((await reapply.instance.logout("openai")).status, 200);
  assert.deepEqual(reapply.reapplied, ["openai"]);
  assert.deepEqual(order, ["reapply:openai", "refresh"], "SDK が消した overlay を先に戻してから再計算する");

  // 写し直しの失敗は未反映 (呼び出し側が記録) として扱い、サインアウト自体は成功のままにする
  const failing = service(fakeRuntime({ stored: "oauth" }).runtime, {
    reapplyStoredKey: () => Promise.reject(new Error("apply failed")),
  });
  assert.equal((await failing.instance.logout("openai")).status, 200);
  assert.equal(failing.refreshes.length, 1, "失敗しても公開 state の再計算は 1 回行う");
});

test("サインアウトは auth.json の OAuth があるときだけ通り、キー (アプリ DB) には触れない", async () => {
  const runtime = fakeRuntime({ stored: "oauth" });
  const { instance, refreshes } = service(runtime.runtime);
  assert.equal((await instance.logout("openai")).status, 200);
  assert.deepEqual(runtime.calls.logout, ["openai"]);
  assert.equal(refreshes.length, 1, "サインアウトでも公開 state を再計算する");

  const nothing = service(fakeRuntime({ stored: undefined, credential: null }).runtime);
  assert.equal((await nothing.instance.logout("openai").catch((error) => error)).message, OAUTH_LOGOUT_TARGET_MESSAGE);

  // auth.json を読めないときは SDK が見ている種別で判定する (保存値があるのに 400 にしない)
  const unreadable = service(fakeRuntime({ storedThrows: true, credential: "oauth" }).runtime);
  assert.equal((await unreadable.instance.logout("openai")).status, 200);
  const hidden = service(fakeRuntime({ storedThrows: true, credential: null }).runtime);
  assert.equal((await hidden.instance.logout("openai").catch((error) => error)).message, OAUTH_LOGOUT_TARGET_MESSAGE);
});

test("成功は公開 state の再計算が終わるまで公開せず、認可 URL は先に落とす", async () => {
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const { instance, refreshes } = service(runtime.runtime, { refresh: () => pendingRefresh });
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.input !== null);
  await instance.submitCode("openai", "http://127.0.0.1:1455/auth/callback?code=abc&state=dummy");
  // SDK の login は返り、公開 state の再計算だけが未完了
  await waitForState(instance, "openai", () => refreshes.length > 0);
  const during = instance.stateOf("openai");
  assert.equal(during?.status, "running", "再計算が終わるまで成功を公開しない");
  assert.equal(during?.authUrl, null, "認可 URL は再計算を待たずに落とす");
  assert.equal(during?.input, null, "貼り付け欄も再計算を待たずに落とす");
  assert.equal(during?.progress, null);

  releaseRefresh();
  const done = await waitForState(instance, "openai", (state) => state.status === "succeeded");
  assert.equal(done.authUrl, null);
  assert.equal(refreshes.length, 1, "成功の公開 state を 1 回だけ再計算する");
});

test("公開 state の再計算中に押された [中断] は、確定済みの成功を取り消さない", async () => {
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" });
    },
  });
  const { instance, refreshes } = service(runtime.runtime, { refresh: () => pendingRefresh });
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.input !== null);
  await instance.submitCode("openai", "http://127.0.0.1:1455/auth/callback?code=abc&state=dummy");
  await waitForState(instance, "openai", () => refreshes.length > 0);

  assert.equal((await instance.cancel("openai")).status, 200);
  assert.equal(instance.stateOf("openai")?.status, "running", "再計算待ちの間は終端を公開しない");
  releaseRefresh();
  const done = await waitForState(instance, "openai", (state) => state.status === "succeeded");
  assert.equal(done.error, null);
  assert.equal(refreshes.length, 1, "中断では再計算を増やさない");
  // その後の [閉じる] は結果表示の消去として働く
  assert.equal((await instance.cancel("openai")).status, 200);
  assert.equal(instance.stateOf("openai"), null);
});

test("認可 URL の発行前に中断したあとの prompt は、入力欄を立てずに拒否する", async () => {
  let rejected: unknown = null;
  let loginReturned = false;
  let abortedDuringPrompt = false;
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      // 開始 POST と中断 DELETE の競合: 認可 URL / manual_code の発行前に中断が確定する
      await new Promise((resolve) => setTimeout(resolve, 30));
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }).catch((error) => {
        rejected = error;
        abortedDuringPrompt = interaction.signal?.aborted ?? false;
      });
      loginReturned = true;
    },
  });
  const { instance, refreshes } = service(runtime.runtime);
  await instance.start("openai");
  assert.equal((await instance.cancel("openai")).status, 200);

  await waitForState(instance, "openai", () => rejected !== null && loginReturned);
  assert.equal(abortedDuringPrompt, true, "中断は SDK の signal を閉じている");
  const state = instance.stateOf("openai");
  assert.equal(state?.status, "cancelled", "中断の表示を保つ");
  assert.equal(state?.input, null, "終端したあとの prompt で入力欄を立てない");
  await waitForState(instance, "openai", () => refreshes.length > 0);
  assert.equal(refreshes.length, 1, "中断の公開 state を 1 回だけ再計算する");
});

test("SDK の login が遅れて prompt を出しても、abort 済み signal に listener を残さない", async () => {
  const signals: AbortSignal[] = [];
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      signals.push(interaction.signal as AbortSignal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await interaction.prompt({ type: "manual_code", message: "Paste", placeholder: "url" }).catch(() => {});
    },
  });
  const { instance } = service(runtime.runtime);
  await instance.start("openai");
  await instance.cancel("openai");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(getEventListeners(signals[0], "abort").length, 0, "拒否した prompt は listener を残さない");
});

test("中断の直後に SDK の login が成功しても公開 state を再計算し、中断の表示を保つ", async () => {
  const runtime = fakeRuntime({
    login: async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: AUTH_URL });
      // 認可と [中断] が同じ瞬間に起きた場合: signal が閉じても成功で返す
      await new Promise<void>((resolve) => {
        interaction.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  const { instance, refreshes } = service(runtime.runtime);
  await instance.start("openai");
  await waitForState(instance, "openai", (state) => state.authUrl !== null);
  await instance.cancel("openai");
  await waitForState(instance, "openai", () => refreshes.length > 0);
  assert.equal(refreshes.length, 1, "SDK が返った時点の資格情報を 1 回で写す");
  assert.equal(instance.stateOf("openai")?.status, "cancelled", "成功で中断の表示を上書きしない");
});

test("進行中のサインアウトは 409、SDK の失敗は 503 の固定文言になる", async () => {
  const running = fakeRuntime({ login: (_provider, interaction) => pendingLogin(interaction), stored: "oauth" });
  const runningService = service(running.runtime);
  await runningService.instance.start("openai");
  await waitForState(runningService.instance, "openai", (state) => state.input !== null);
  await assert.rejects(
    () => runningService.instance.logout("openai"),
    (error: unknown) =>
      (error as { statusCode?: number; message?: string }).message === OAUTH_LOGIN_IN_PROGRESS_MESSAGE,
  );
  await runningService.instance.cancel("openai");

  const failing = fakeRuntime({
    stored: "oauth",
    logout: () => Promise.reject(new Error("auth.json is locked by another process")),
  });
  const failingService = service(failing.runtime);
  const error = await failingService.instance.logout("openai").catch((value: unknown) => value);
  assert.equal((error as { statusCode?: number }).statusCode, 503);
  assert.equal((error as { message?: string }).message, OAUTH_LOGOUT_FAILED_MESSAGE);
});
