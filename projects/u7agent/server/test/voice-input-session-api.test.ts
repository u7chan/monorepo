// 音声入力の Realtime 中継 API（POST /api/voice-input/session）。実 API は呼ばず stub fetch で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { APP_DB_FILENAME } from "../src/app-db";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { jsonBody } from "./http-helpers";
import { asPiBff, createStubPi } from "./stub-pi";
import {
  VOICE_INPUT_MODEL,
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
  VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE,
} from "../src/voice-input";
import {
  VOICE_INPUT_CALLS_URL,
  VOICE_INPUT_SDP_MAX_BYTES,
  VOICE_INPUT_SESSION_BUSY_MESSAGE,
  VOICE_INPUT_SESSION_CONTENT_TYPE_MESSAGE,
  VOICE_INPUT_SESSION_EXPIRED_MESSAGE,
  VOICE_INPUT_SESSION_INVALID_ANSWER_MESSAGE,
  VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE,
  VOICE_INPUT_SESSION_INVALID_SECRET_MESSAGE,
  VOICE_INPUT_SESSION_KEY_CHANGED_MESSAGE,
  VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE,
} from "../src/voice-input-session";
import { VOICE_INPUT_SECRETS_URL } from "../src/voice-input";

// アプリ DB の APIキーは暗号化して保存する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const KEY = "sk-voice-dummy-key-0123456789abcdef";
const OTHER_KEY = "sk-voice-other-key-0123456789";
const SAME_ORIGIN = "http://localhost";

/** ダミーの offer / answer。割り当てアドレスは文書用の予約域だけで、実在のホストを指さない */
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 0 IN IP4 192.0.2.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "",
].join("\r\n");
const ANSWER = [
  "v=0",
  "o=- 4611731400430051337 0 IN IP4 192.0.2.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=setup:active",
  "",
].join("\r\n");

const CLIENT_SECRET_RESPONSE = {
  value: "ek_short-lived-dummy-value",
  expires_at: 1_730_000_060,
  session: { type: "transcription" },
};

const sdpResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/sdp" } });

const secretResponse = () =>
  Response.json(CLIENT_SECRET_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });

/** 上流 2 系統への送信を記録し、応答をテストから差し替える fetch。宛先以外へ出たら失敗させる */
function upstreamFetch(
  handlers: {
    clientSecret?: (init: RequestInit | undefined) => Response | Promise<Response>;
    calls?: (init: RequestInit | undefined) => Response | Promise<Response>;
  } = {},
) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === VOICE_INPUT_SECRETS_URL) return (handlers.clientSecret ?? secretResponse)(init);
    if (url === VOICE_INPUT_CALLS_URL) return (handlers.calls ?? (() => sdpResponse(ANSWER)))(init);
    throw new Error(`unexpected upstream: ${url}`);
  };
  return {
    requests,
    fetchImpl,
    count: (url: string) => requests.filter((request) => request.url === url).length,
    calls: () => requests.filter((request) => request.url === VOICE_INPUT_CALLS_URL),
  };
}

const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({
    // 起動時のカタログ取得を実 API へ出さない（この画面とは無関係だが、起動の再現性を保つ）
    imageCatalogFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    speechCatalogFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ...options,
  });

type Bff = Awaited<ReturnType<typeof openBff>>;

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-voice-relay-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function putKey(bff: Bff, apiKey: string): Promise<void> {
  const response = await bff.app.request("/api/settings/voice-input/key", {
    method: "PUT",
    headers: { Origin: SAME_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  assert.equal(response.status, 200);
}

/** ブラウザの same-origin 要求を模す。body は文字列でも stream でもよい */
function sessionRequest(
  body: string | ReadableStream<Uint8Array>,
  options: { contentType?: string | null; origin?: string | null; signal?: AbortSignal; duplex?: "half" } = {},
): RequestInit {
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? SAME_ORIGIN : options.origin;
  if (origin !== null) headers.Origin = origin;
  const contentType = options.contentType === undefined ? "application/sdp" : options.contentType;
  if (contentType !== null) headers["Content-Type"] = contentType;
  const init: RequestInit = { method: "POST", headers, body };
  if (options.signal) init.signal = options.signal;
  if (options.duplex) (init as RequestInit & { duplex: "half" }).duplex = options.duplex;
  return init;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

test("中継は offer をそのまま送り、answer SDP を no-store で透過し、上流のヘッダを写さない", async () => {
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch({
      calls: () => sdpResponse(ANSWER),
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/sdp");
      assert.equal(response.headers.get("cache-control"), "no-store");
      // 上流のヘッダは透過しない（この 2 つだけを付ける）
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("x-upstream"), null);
      // 末尾の CRLF まで改変しない
      assert.equal(await response.text(), ANSWER);

      assert.equal(upstream.requests.length, 2);
      const [secretCall, callsCall] = upstream.requests;
      assert.equal(secretCall?.url, VOICE_INPUT_SECRETS_URL);
      assert.equal(secretCall?.init?.method, "POST");
      assert.equal(secretCall?.init?.redirect, "error");
      assert.deepEqual(secretCall?.init?.headers, {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      });
      // モデルとセッション種別は固定で、client の値を使わない
      assert.deepEqual(JSON.parse(String(secretCall?.init?.body)), {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
        },
      });

      assert.equal(callsCall?.url, VOICE_INPUT_CALLS_URL);
      assert.equal(callsCall?.init?.method, "POST");
      assert.equal(callsCall?.init?.redirect, "error");
      assert.deepEqual(callsCall?.init?.headers, {
        Authorization: `Bearer ${CLIENT_SECRET_RESPONSE.value}`,
        "Content-Type": "application/sdp",
      });
      // 上流へ渡す本文は入口で受け取った文字列と同一
      assert.equal(String(callsCall?.init?.body), OFFER);
    } finally {
      await bff.close();
    }
  });
});

test("入口の拒否（同一オリジン・Content-Type・サイズ・空・SDP でない本文）は上流を呼ばない", async () => {
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch();
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const cases: { name: string; request: RequestInit; status: number; error: string }[] = [
        {
          name: "別オリジン",
          request: sessionRequest(OFFER, { origin: "http://evil.example" }),
          status: 403,
          error: "Cross-origin mutations are forbidden",
        },
        {
          name: "Origin なし",
          request: sessionRequest(OFFER, { origin: null }),
          status: 403,
          error: "Same-origin request required",
        },
        {
          name: "Content-Type 違い",
          request: sessionRequest(OFFER, { contentType: "application/json" }),
          status: 415,
          error: VOICE_INPUT_SESSION_CONTENT_TYPE_MESSAGE,
        },
        {
          name: "サイズ超過",
          request: sessionRequest(`${OFFER}${"a".repeat(VOICE_INPUT_SDP_MAX_BYTES)}`),
          status: 413,
          error: VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE,
        },
        { name: "空", request: sessionRequest(""), status: 400, error: VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE },
        {
          name: "SDP でない",
          request: sessionRequest("hello"),
          status: 400,
          error: VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE,
        },
      ];
      for (const entry of cases) {
        const response = await bff.app.request("/api/voice-input/session", entry.request);
        assert.equal(response.status, entry.status, entry.name);
        assert.deepEqual(await jsonBody(response), { error: entry.error }, entry.name);
      }
      assert.equal(upstream.requests.length, 0, "入口の拒否では上流を呼ばない");
    } finally {
      await bff.close();
    }
  });
});

test("キー未設定 409・復号不能 / DB 不通 / ランタイム無し 503 は上流を呼ばない", async () => {
  // 未設定は 409
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch();
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 409);
      assert.deepEqual(await jsonBody(response), { error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE });
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bff.close();
    }
  });

  // 復号できない行（未知の鍵版）は「未設定」と混ぜず 503
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch();
    const seed = await openBff({ cwd: "/tmp", sessionStoreDir: dir, pi: asPiBff(createStubPi()), workspace: null });
    try {
      await putKey(seed, KEY);
    } finally {
      await seed.close();
    }
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec("UPDATE voice_input_settings SET keyVersion = 99");
    raw.close();

    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 503);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bff.close();
    }
  });

  // DB を読めないときも上流を呼ばない
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch();
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec("DROP TABLE voice_input_settings");
      raw.close();
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 503);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bff.close();
    }
  });

  // ランタイム無しは保存行があっても復号しない
  await withStoreDir(async (dir) => {
    const upstream = upstreamFetch();
    const seed = await openBff({ cwd: "/tmp", sessionStoreDir: dir, pi: asPiBff(createStubPi()), workspace: null });
    try {
      await putKey(seed, KEY);
    } finally {
      await seed.close();
    }
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: null,
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), { error: VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE });
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bff.close();
    }
  });
});

test("発行直後にキーが変わったら 409 で Calls を呼ばない", async () => {
  await withStoreDir(async (dir) => {
    let changeKey: (apiKey: string) => Promise<void> = async () => {
      throw new Error("not ready");
    };
    const upstream = upstreamFetch({
      clientSecret: async () => {
        // 短命キーの発行中にキーが置き換わる
        await changeKey(OTHER_KEY);
        return secretResponse();
      },
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      changeKey = (apiKey) => putKey(bff, apiKey);
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 409);
      assert.deepEqual(await jsonBody(response), { error: VOICE_INPUT_SESSION_KEY_CHANGED_MESSAGE });
      assert.equal(upstream.count(VOICE_INPUT_SECRETS_URL), 1);
      assert.equal(upstream.count(VOICE_INPUT_CALLS_URL), 0, "古いキーの短命キーで Calls を呼ばない");
    } finally {
      await bff.close();
    }
  });
});

test("Calls の待ち中にキーが変わったら古い answer を成功として返さない", async () => {
  await withStoreDir(async (dir) => {
    let releaseCalls: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    let callsStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      callsStarted = resolve;
    });
    let changeKey: (apiKey: string) => Promise<void> = async () => {
      throw new Error("not ready");
    };
    const upstream = upstreamFetch({
      calls: async () => {
        callsStarted?.();
        await releaseGate;
        return sdpResponse(ANSWER);
      },
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      changeKey = (apiKey) => putKey(bff, apiKey);
      const pending = bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      await started;
      await changeKey(OTHER_KEY);
      releaseCalls?.();
      const response = await pending;
      assert.equal(response.status, 409);
      assert.deepEqual(await jsonBody(response), { error: VOICE_INPUT_SESSION_KEY_CHANGED_MESSAGE });
      assert.equal(upstream.count(VOICE_INPUT_CALLS_URL), 1, "Calls 自体は 1 回だけ呼ぶ");
    } finally {
      await bff.close();
    }
  });
});

test("短命キーの応答が想定と違えば 502 で Calls を呼ばない", async () => {
  await withStoreDir(async (dir) => {
    let nextSecret = (): Response => secretResponse();
    const upstream = upstreamFetch({ clientSecret: () => nextSecret() });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const cases: { name: string; response: () => Response }[] = [
        {
          name: "ek_ で始まらない",
          response: () => Response.json({ value: "not-a-client-secret", session: { type: "transcription" } }),
        },
        { name: "種別が違う", response: () => Response.json({ value: "ek_ok", session: { type: "realtime" } }) },
        {
          name: "キーがそのまま返る",
          response: () => Response.json({ value: KEY, session: { type: "transcription" } }),
        },
        {
          name: "ek_ 形式外",
          response: () => Response.json({ value: "ek_bad value", session: { type: "transcription" } }),
        },
        { name: "JSON でない", response: () => new Response("not json", { status: 200 }) },
      ];
      for (const entry of cases) {
        nextSecret = entry.response;
        const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
        assert.equal(response.status, 502, entry.name);
        assert.deepEqual(
          await jsonBody(response),
          { error: VOICE_INPUT_SESSION_INVALID_SECRET_MESSAGE, code: "unknown" },
          entry.name,
        );
      }
      assert.equal(upstream.count(VOICE_INPUT_SECRETS_URL), cases.length);
      assert.equal(upstream.count(VOICE_INPUT_CALLS_URL), 0, "短命キーが使えないときは Calls を呼ばない");
    } finally {
      await bff.close();
    }
  });
});

test("上流失敗は分類つきの 502 にし、上流の本文を応答・ログへ出さない", async () => {
  await withStoreDir(async (dir) => {
    const cases: { status: number; code: string }[] = [
      { status: 401, code: "invalid_key" },
      { status: 403, code: "invalid_key" },
      { status: 402, code: "insufficient_credit" },
      { status: 429, code: "rate_limited" },
      { status: 500, code: "rate_limited" },
      { status: 400, code: "unknown" },
    ];
    let nextStatus = 401;
    const upstream = upstreamFetch({
      clientSecret: () => new Response(`upstream detail ${KEY} credit_balance_exhausted`, { status: nextStatus }),
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error, log: console.log };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await putKey(bff, KEY);
      for (const entry of cases) {
        nextStatus = entry.status;
        const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
        assert.equal(response.status, 502, String(entry.status));
        const body = await jsonBody(response);
        assert.equal(body.code, entry.code, String(entry.status));
        assert.ok(!JSON.stringify(body).includes(KEY), "上流の本文を応答へ出さない");
        assert.ok(!JSON.stringify(body).includes("credit_balance_exhausted"));
        assert.ok(!JSON.stringify(body).includes("upstream detail"));
      }
      assert.equal(upstream.count(VOICE_INPUT_CALLS_URL), 0, "発行が失敗したら Calls を呼ばない");
    } finally {
      console.warn = original.warn;
      console.error = original.error;
      console.log = original.log;
      await bff.close();
    }
    assert.ok(!logged.join("\n").includes(KEY), "ログにも上流の本文とキーを出さない");
    assert.ok(!logged.join("\n").includes("credit_balance_exhausted"));
  });
});

test("Calls の失敗も分類し、402 だけを残高不足として扱う", async () => {
  await withStoreDir(async (dir) => {
    let nextStatus = 402;
    const upstream = upstreamFetch({
      calls: () => new Response(`answer failed ${KEY}`, { status: nextStatus }),
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const cases: { status: number; code: string }[] = [
        { status: 401, code: "invalid_key" },
        { status: 402, code: "insufficient_credit" },
        { status: 429, code: "rate_limited" },
        { status: 503, code: "rate_limited" },
        { status: 404, code: "unknown" },
      ];
      for (const entry of cases) {
        nextStatus = entry.status;
        const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
        assert.equal(response.status, 502, String(entry.status));
        const body = await jsonBody(response);
        assert.equal(body.code, entry.code, String(entry.status));
        assert.ok(!JSON.stringify(body).includes(KEY));
      }
    } finally {
      await bff.close();
    }
  });
});

test("上流のタイムアウトは 502 timeout、ブラウザの取消は上流の abort に伝わる", async () => {
  await withStoreDir(async (dir) => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: hanging,
      voiceInputSessionTiming: { clientSecretMs: 5 },
    });
    try {
      await putKey(bff, KEY);
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 502);
      assert.equal((await jsonBody(response)).code, "timeout");
    } finally {
      await bff.close();
    }
  });

  await withStoreDir(async (dir) => {
    let upstreamAborted = false;
    let notifyCalled: (() => void) | undefined;
    const called = new Promise<void>((resolve) => {
      notifyCalled = resolve;
    });
    let clientSecretCalls = 0;
    const upstream = upstreamFetch({
      clientSecret: (init) => {
        clientSecretCalls += 1;
        if (clientSecretCalls > 1) return secretResponse();
        return new Promise((_resolve, reject) => {
          notifyCalled?.();
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const controller = new AbortController();
      const pending = bff.app.request("/api/voice-input/session", sessionRequest(OFFER, { signal: controller.signal }));
      await called;
      controller.abort();
      const response = await pending;
      assert.equal(response.status, 502);
      assert.equal((await jsonBody(response)).code, "aborted");
      assert.equal(upstreamAborted, true, "ブラウザの取消を上流の abort へ伝える");

      // 取消で枠が戻り、次の接続は受け付ける
      const next = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(next.status, 200);
    } finally {
      await bff.close();
    }
  });
});

test("2xx でも answer が SDP でない / 空 / 上限超えは 502", async () => {
  await withStoreDir(async (dir) => {
    const tooLarge = `v=0\r\n${"a".repeat(VOICE_INPUT_SDP_MAX_BYTES)}`;
    let nextAnswer = (): Response => sdpResponse(ANSWER);
    const upstream = upstreamFetch({ calls: () => nextAnswer() });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const cases: { name: string; response: () => Response }[] = [
        { name: "空", response: () => new Response("", { status: 200 }) },
        { name: "SDP でない", response: () => new Response("hello", { status: 200 }) },
        { name: "上限超え", response: () => new Response(tooLarge, { status: 200 }) },
      ];
      for (const entry of cases) {
        nextAnswer = entry.response;
        const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
        assert.equal(response.status, 502, entry.name);
        assert.deepEqual(
          await jsonBody(response),
          { error: VOICE_INPUT_SESSION_INVALID_ANSWER_MESSAGE, code: "unknown" },
          entry.name,
        );
      }
    } finally {
      await bff.close();
    }
  });
});

test("全体予算は本文の読取を含み、段の上限を足し合わせない", async () => {
  await withStoreDir(async (dir) => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const upstream = upstreamFetch({ clientSecret: () => new Promise<Response>(() => {}) });
    const slowBff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      // 段の上限を長くしても、全体予算（60ms）を超えて待たない
      voiceInputFetch: hanging,
      voiceInputSessionTiming: { totalMs: 60, clientSecretMs: 10_000, callsMs: 10_000 },
    });
    try {
      await putKey(slowBff, KEY);
      const bytes = new TextEncoder().encode(OFFER);
      const slowBody = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(bytes);
            controller.close();
          }, 40);
        },
      });
      const startedAt = Date.now();
      const response = await slowBff.app.request(
        "/api/voice-input/session",
        sessionRequest(slowBody, { duplex: "half" }),
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 502);
      assert.equal((await jsonBody(response)).code, "timeout");
      assert.ok(elapsed < 1_000, `本文の読取を含む全体予算で切る (${elapsed}ms)`);
    } finally {
      await slowBff.close();
    }

    // 本文が届かないままでも、全体予算で 408 を返して上流を呼ばない
    const stalledBff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
      voiceInputSessionTiming: { totalMs: 50 },
    });
    try {
      const stalled = new ReadableStream<Uint8Array>({ start() {} });
      const startedAt = Date.now();
      const response = await stalledBff.app.request(
        "/api/voice-input/session",
        sessionRequest(stalled, { duplex: "half" }),
      );
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 408);
      assert.deepEqual(await jsonBody(response), { error: VOICE_INPUT_SESSION_EXPIRED_MESSAGE });
      assert.ok(elapsed < 1_000, `本文の読取も全体予算で切る (${elapsed}ms)`);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await stalledBff.close();
    }
  });
});

test("同時発行は上限までで、超過は上流を呼ばず 429、終われば枠が戻る", async () => {
  await withStoreDir(async (dir) => {
    const gates: (() => void)[] = [];
    let inFlight = 0;
    let clientSecretCalls = 0;
    const upstream = upstreamFetch({
      clientSecret: () => {
        clientSecretCalls += 1;
        // 最初の 2 本だけを止め、それ以降は通常どおり応答する（枠が戻ったことの確認用）
        if (clientSecretCalls > 2) return secretResponse();
        inFlight += 1;
        return new Promise<Response>((resolve) => {
          gates.push(() => resolve(secretResponse()));
        });
      },
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    try {
      await putKey(bff, KEY);
      const first = bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      const second = bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      await waitFor(() => inFlight === 2);

      const third = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(third.status, 429);
      assert.deepEqual(await jsonBody(third), { error: VOICE_INPUT_SESSION_BUSY_MESSAGE });
      assert.equal(upstream.count(VOICE_INPUT_SECRETS_URL), 2, "上限を超えた要求は上流を呼ばない");

      for (const gate of gates) gate();
      assert.equal((await first).status, 200);
      assert.equal((await second).status, 200);

      const fourth = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(fourth.status, 200, "終わった接続の枠は戻る");
    } finally {
      await bff.close();
    }
  });
});

test("ek_・キー・SDP は応答・ログ・health に出ない", async () => {
  await withStoreDir(async (dir) => {
    const leakyBody = `leak ${KEY} ${CLIENT_SECRET_RESPONSE.value} ${OFFER} ${ANSWER}`;
    const upstream = upstreamFetch({
      clientSecret: () => new Response(leakyBody, { status: 500 }),
    });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: upstream.fetchImpl,
    });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error, log: console.log };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await putKey(bff, KEY);
      const response = await bff.app.request("/api/voice-input/session", sessionRequest(OFFER));
      assert.equal(response.status, 502);
      const headerText = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
      const bodyText = await response.text();
      for (const text of [headerText, bodyText]) {
        assert.ok(!text.includes(CLIENT_SECRET_RESPONSE.value), "ek_ を応答へ出さない");
        assert.ok(!text.includes(KEY), "キーを応答へ出さない");
        assert.ok(!text.includes("a=setup:active"), "上流の answer を失敗応答へ出さない");
      }
      const health = JSON.stringify(await jsonBody(await bff.app.request("/api/health")));
      assert.ok(!health.includes(CLIENT_SECRET_RESPONSE.value));
      assert.ok(!health.includes(KEY));
    } finally {
      console.warn = original.warn;
      console.error = original.error;
      console.log = original.log;
      await bff.close();
    }
    const output = logged.join("\n");
    assert.ok(!output.includes(CLIENT_SECRET_RESPONSE.value), `ログに ek_ を出さない: ${output}`);
    assert.ok(!output.includes(KEY), `ログにキーを出さない: ${output}`);
    assert.ok(!output.includes("a=setup:active"), "ログに SDP を出さない");
  });
});
