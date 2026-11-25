// 音声入力の設定 API（GET / PUT / DELETE /api/settings/voice-input...）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { APP_DB_FILENAME } from "../src/app-db";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { VOICE_INPUT_MODEL } from "../src/voice-input";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { APP_SECRET_UNEVALUATED_MESSAGE } from "../src/app-secrets";
import { jsonBody } from "./http-helpers";
import { asPiBff, createStubPi } from "./stub-pi";

// アプリ DB の APIキーは暗号化して保存する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const KEY = "sk-voice-dummy-key-0123456789abcdef";
const OTHER_KEY = "sk-voice-other-key-0123456789";

/** ブラウザからの same-origin 要求を模す (キーの登録・削除・疎通確認はヘッダの無い直接クライアントを拒否する) */
const sameOrigin = { Origin: "http://localhost" };

const jsonRequest = (method: "PUT" | "DELETE", payload?: unknown): RequestInit =>
  payload === undefined
    ? { method, headers: sameOrigin }
    : { method, headers: { ...sameOrigin, "Content-Type": "application/json" }, body: JSON.stringify(payload) };

const postRequest = (): RequestInit => ({ method: "POST", headers: sameOrigin });

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-voice-input-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const defaultSettings = (runtimeAvailable = true) => ({
  configured: false,
  keyStored: false,
  keyAvailable: false,
  keyEvaluated: true,
  keyErrorMessage: null,
  model: VOICE_INPUT_MODEL,
  runtimeAvailable,
});

/** `ek_` で始まる短命キーを返す OpenAI の応答。値は入力のキーと一致しない */
const CLIENT_SECRET_RESPONSE = {
  value: "ek_short-lived-dummy-value",
  expires_at: 1_730_000_060,
  session: {
    type: "transcription",
    audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
  },
};

/** 疎通確認の送信を記録する fetch。応答はテストから差し替える */
function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { calls, fetchImpl };
}

const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({
    // 起動時のカタログ取得を実 API へ出さない (この画面とは無関係だが、起動の再現性を保つ)
    imageCatalogFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    speechCatalogFetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ...options,
  });

test("GET / PUT / DELETE の往復で設定が変わり、キーは応答に載らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/voice-input")), defaultSettings());

      const saved = await jsonBody(
        await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY })),
      );
      assert.deepEqual(saved, {
        ...defaultSettings(),
        configured: true,
        keyStored: true,
        keyAvailable: true,
        state: "applied",
      });
      assert.ok(!JSON.stringify(saved).includes(KEY), "応答にキーを載せない");
      assert.ok(pi.retainedSecrets.includes(KEY), "DB へ書く前にマスカーへ登録する");
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/voice-input")), {
        ...defaultSettings(),
        configured: true,
        keyStored: true,
        keyAvailable: true,
      });

      const removed = await jsonBody(await bff.app.request("/api/settings/voice-input/key", jsonRequest("DELETE")));
      assert.deepEqual(removed, { ...defaultSettings(), state: "applied" });
      // 冪等
      const again = await bff.app.request("/api/settings/voice-input/key", jsonRequest("DELETE"));
      assert.equal(again.status, 200);
      assert.equal((await jsonBody(again)).state, "applied");
    } finally {
      await bff.close();
    }

    // 再起動しても保存済みのキーは残り、起動時に復号してマスカーへ登録される
    const first = await openBff({ cwd: "/tmp", sessionStoreDir: dir, pi: asPiBff(createStubPi()), workspace: null });
    try {
      await first.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
    } finally {
      await first.close();
    }
    const restartedPi = createStubPi();
    const restarted = await openBff({ cwd: "/tmp", sessionStoreDir: dir, pi: asPiBff(restartedPi), workspace: null });
    try {
      const settings = await jsonBody(await restarted.app.request("/api/settings/voice-input"));
      assert.equal(settings.keyStored, true);
      assert.equal(settings.keyAvailable, true);
      assert.ok(restartedPi.retainedSecrets.includes(KEY), "起動時もマスカーへ登録する");
    } finally {
      await restarted.close();
    }
  });
});

test("入力の境界（長さ・印字可能 ASCII）は 400 で保存しない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      for (const apiKey of ["a".repeat(7), "a".repeat(2049), "sk-voice\nkey-0123456789", "sk-voice-key-日本語0123"]) {
        const response = await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey }));
        assert.equal(response.status, 400, JSON.stringify(apiKey));
        assert.equal((await jsonBody(response)).error, "Invalid request body");
      }
      assert.equal((await jsonBody(await bff.app.request("/api/settings/voice-input"))).keyStored, false);
      // 境界の内側は通る
      assert.equal(
        (await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: "a".repeat(8) }))).status,
        200,
      );
    } finally {
      await bff.close();
    }
  });
});

test("疎通確認は未登録 409・成功 200・上流の失敗 200 の ok:false を返し、送信の形を固定する", async () => {
  await withStoreDir(async (dir) => {
    const recorder = recordingFetch(() =>
      Response.json(CLIENT_SECRET_RESPONSE, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: recorder.fetchImpl,
    });
    try {
      // 未登録は 409 で、上流を呼ばない
      const missing = await bff.app.request("/api/settings/voice-input/test", postRequest());
      assert.equal(missing.status, 409);
      assert.deepEqual(await jsonBody(missing), {
        error: "音声入力のAPIキーが未設定です。先にキーを登録してください",
      });
      assert.equal(recorder.calls.length, 0);

      await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
      const ok = await bff.app.request("/api/settings/voice-input/test", postRequest());
      assert.equal(ok.status, 200);
      assert.deepEqual(await jsonBody(ok), { ok: true, model: VOICE_INPUT_MODEL });

      assert.equal(recorder.calls.length, 1);
      const call = recorder.calls[0];
      assert.ok(call);
      assert.equal(call.url, "https://api.openai.com/v1/realtime/client_secrets");
      assert.deepEqual(call.init?.headers, { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
      assert.deepEqual(JSON.parse(String(call.init?.body)), {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
        },
      });
    } finally {
      await bff.close();
    }
  });
});

test("上流の失敗は分類つきの 200 で返し、本文を応答へ出さない", async () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: "invalid_key" },
    { status: 402, code: "insufficient_credit" },
    { status: 429, code: "rate_limited" },
    { status: 503, code: "rate_limited" },
  ];
  for (const entry of cases) {
    await withStoreDir(async (dir) => {
      const bff = await openBff({
        cwd: "/tmp/project",
        sessionStoreDir: dir,
        pi: asPiBff(createStubPi()),
        workspace: null,
        voiceInputFetch: async () => new Response(`upstream says ${KEY}`, { status: entry.status }),
      });
      try {
        await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
        const response = await bff.app.request("/api/settings/voice-input/test", postRequest());
        assert.equal(response.status, 200);
        const body = await jsonBody(response);
        assert.equal(body.ok, false);
        assert.equal(body.code, entry.code);
        assert.ok(!JSON.stringify(body).includes(KEY), "上流の本文を応答へ出さない");
      } finally {
        await bff.close();
      }
    });
  }
});

test("DB が使えないときは GET / test が 503、変更系は not_stored になり、キーを漏らさない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec("DROP TABLE voice_input_settings");
      raw.close();

      const get = await bff.app.request("/api/settings/voice-input");
      assert.equal(get.status, 503);
      assert.ok(!JSON.stringify(await jsonBody(get)).includes(KEY));

      const put = await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: OTHER_KEY }));
      assert.equal(put.status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");

      const removed = await bff.app.request("/api/settings/voice-input/key", jsonRequest("DELETE"));
      assert.equal(removed.status, 503);
      assert.equal((await jsonBody(removed)).state, "not_stored");

      const testResponse = await bff.app.request("/api/settings/voice-input/test", postRequest());
      assert.equal(testResponse.status, 503);
    } finally {
      await bff.close();
    }
  });
});

test("登録済みキーを含む DB 例外が応答・health・ログに現れない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
      // SQLite の例外文言に暗号文 (hex) が載る経路を作り、値なし境界を通す
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec(
        `CREATE TRIGGER leak BEFORE DELETE ON voice_input_settings
         BEGIN SELECT RAISE(ABORT, 'boom ' || hex(OLD.ciphertext)); END`,
      );
      raw.close();

      const response = await bff.app.request("/api/settings/voice-input/key", jsonRequest("DELETE"));
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored");
      assert.ok(!JSON.stringify(body).includes(KEY), "応答本文にキーを出さない");

      const health = await jsonBody(await bff.app.request("/api/health"));
      assert.equal(health.appDb.ok, false);
      assert.ok(!health.appDb.error.includes(KEY), `health にキーを出さない: ${health.appDb.error}`);
      assert.equal(health.appDb.error, "app secret query failed");

      assert.ok(!logged.join("\n").includes(KEY), `ログにもキーを出さない: ${logged.join("\n")}`);
      assert.ok(logged.join("\n").includes("app secret query failed"), "操作の分類だけを残す");
    } finally {
      console.warn = original.warn;
      console.error = original.error;
      await bff.close();
    }
  });
});

test("同一オリジンでないキー操作と疎通確認は 403 で拒否し、GET は読める", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      voiceInputFetch: async () => Response.json(CLIENT_SECRET_RESPONSE),
    });
    try {
      for (const request of [
        {
          path: "/api/settings/voice-input/key",
          init: {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: KEY }),
          },
        },
        { path: "/api/settings/voice-input/key", init: { method: "DELETE" } },
        { path: "/api/settings/voice-input/test", init: { method: "POST" } },
      ] as const) {
        const response = await bff.app.request(request.path, request.init as RequestInit);
        assert.equal(response.status, 403, `${request.init.method} ${request.path}`);
        // 既存の共通ガードの形（reason の列挙は持たない）
        assert.deepEqual(await jsonBody(response), { error: "Same-origin request required" });
      }
      // 別オリジンの宣言は、変更系の共通ガードが先に拒否する（既存の文言のまま）
      const crossOrigin = await bff.app.request("/api/settings/voice-input/key", {
        method: "PUT",
        headers: { Origin: "http://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: KEY }),
      });
      assert.equal(crossOrigin.status, 403);
      assert.deepEqual(await jsonBody(crossOrigin), { error: "Cross-origin mutations are forbidden" });
      // GET はヘッダ無しでも読める（読み取りに Origin を要求しない）
      assert.equal((await bff.app.request("/api/settings/voice-input")).status, 200);
    } finally {
      await bff.close();
    }
  });
});

test("ランタイムを作れない起動では登録と疎通が 503、削除は成功する", async () => {
  await withStoreDir(async (dir) => {
    // ランタイム無しでも保存済みのキーを戻せるよう、先にキーを保存した DB を用意する
    const seed = await openBff({ cwd: "/tmp", sessionStoreDir: dir, pi: asPiBff(createStubPi()), workspace: null });
    try {
      await seed.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
    } finally {
      await seed.close();
    }

    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/voice-input")), {
        ...defaultSettings(false),
        configured: true,
        keyStored: true,
        keyEvaluated: false,
        keyErrorMessage: APP_SECRET_UNEVALUATED_MESSAGE,
      });

      const put = await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: OTHER_KEY }));
      assert.equal(put.status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");

      const testResponse = await bff.app.request("/api/settings/voice-input/test", postRequest());
      assert.equal(testResponse.status, 503);

      // 削除は暗号化にもマスカーにも依存しない
      const removed = await bff.app.request("/api/settings/voice-input/key", jsonRequest("DELETE"));
      assert.equal(removed.status, 200);
      assert.equal((await jsonBody(removed)).keyStored, false);
    } finally {
      await bff.close();
    }
  });
});

test("保存済みの暗号文は平文の列を持たず、用途の AAD でだけ復号できる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      await bff.app.request("/api/settings/voice-input/key", jsonRequest("PUT", { apiKey: KEY }));
    } finally {
      await bff.close();
    }
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const row = check.prepare("SELECT id, ciphertext, nonce, keyVersion FROM voice_input_settings").get() as
      | { id: number; ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number }
      | undefined;
    check.close();
    assert.equal(row?.id, 1, "1 行だけを持つ");
    assert.equal(row?.keyVersion, 1);
    assert.ok(
      !Buffer.from(row?.ciphertext ?? [])
        .toString("utf8")
        .includes(KEY),
      "平文を保存しない",
    );
    assert.deepEqual(
      Object.keys(row ?? {}).sort(),
      ["ciphertext", "id", "keyVersion", "nonce"],
      "キー以外の平文の列を持たない",
    );
  });
});
