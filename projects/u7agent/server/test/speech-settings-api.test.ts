// 音声の設定 API（GET / PUT speech / POST speech catalog refresh）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import { DEFAULT_IMAGE_MODEL } from "../src/content-settings";
import { IMAGE_PROVIDER_ID } from "../src/images";
import { SPEECH_PROVIDER_ID } from "../src/speech";
import { DEFAULT_SPEECH_MODEL } from "../src/speech-catalog";
import { asPiBff, createStubPi } from "./stub-pi";

const KEY = "sk-speech-dummy-key-0123456789abcdef";
const OTHER_MODEL = "fish/audio";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-speech-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 実 API を叩かせないための live カタログ stub。応答は固定で、取得側の時計も進めない */
const liveCatalogFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      data: [
        { id: DEFAULT_SPEECH_MODEL, name: "Google: Gemini 3.8 Flash TTS", supported_voices: ["Zephyr", "Kore"] },
        { id: OTHER_MODEL, name: "Fish Audio", supported_voices: null },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** 画像側も同じ stub に固定する（このファイルの対象ではないが、起動時の取得を実 API へ行かせない） */
const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({ ...options, imageCatalogFetch: liveCatalogFetch, speechCatalogFetch: liveCatalogFetch });

test("GET は行が無いとき音声も未設定で返し、キーを載せない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const body = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(body.configured, false);
      assert.deepEqual(
        {
          model: body.speech.model,
          voice: body.speech.voice,
          catalogSource: body.speech.catalogSource,
          fetchedAt: body.speech.fetchedAt,
        },
        { model: null, voice: "", catalogSource: "default", fetchedAt: null },
        "キー未設定では live を取りに行かない",
      );
      assert.deepEqual(
        body.speech.models.map((model: any) => model.id),
        [DEFAULT_SPEECH_MODEL],
        "同梱の既定 1 件を返す",
      );
      assert.equal(body.speech.models[0].voices.length, 30, "同梱の既定ボイスを含む");
    } finally {
      await bff.close();
    }
  });
});

test("キー登録後の GET / PUT は音声の既定へフォールバックし、キーは応答に載らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // 行が無い状態の音声の選択は 400（キー登録が先）
      const unset = bff.app.request(
        "/api/settings/content/speech",
        jsonPut({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }),
      );
      assert.equal((await unset).status, 400);

      const put = await jsonBody(await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY })));
      assert.equal(put.state, "applied");
      assert.equal(put.speech.model, DEFAULT_SPEECH_MODEL, "音声列 NULL は既定モデルへフォールバックする");
      assert.equal(put.speech.voice, "Zephyr", "宣言する先頭ボイスへフォールバックする");
      assert.ok(!JSON.stringify(put).includes(KEY), "応答にキーを載せない");
      const config = pi.contentGenerationConfigs.at(-1);
      assert.deepEqual(config?.readSpeech(), {
        provider: IMAGE_PROVIDER_ID,
        model: DEFAULT_SPEECH_MODEL,
        voice: "Zephyr",
        apiKey: KEY,
      });

      const changed = await jsonBody(
        await bff.app.request("/api/settings/content/speech", jsonPut({ model: OTHER_MODEL, voice: "any-voice-id" })),
      );
      assert.equal(changed.state, "applied");
      assert.equal(changed.image.model, DEFAULT_IMAGE_MODEL, "画像の選択を保つ");
      assert.deepEqual(
        { model: changed.speech.model, voice: changed.speech.voice },
        { model: OTHER_MODEL, voice: "any-voice-id" },
        "宣言が無いモデルは自由記述を許す",
      );
      assert.deepEqual(config?.readSpeech(), {
        provider: IMAGE_PROVIDER_ID,
        model: OTHER_MODEL,
        voice: "any-voice-id",
        apiKey: KEY,
      });

      const after = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(after.speech.model, OTHER_MODEL);
      assert.equal(after.speech.voice, "any-voice-id");
      assert.ok(!JSON.stringify(after).includes(KEY));

      const deleted = await jsonBody(await bff.app.request("/api/settings/content/key", { method: "DELETE" }));
      assert.equal(deleted.state, "applied");
      assert.equal(deleted.speech.model, null);
      assert.equal(deleted.speech.voice, "");
      assert.equal(config?.readSpeech(), undefined, "execute が読む現在の設定も未設定へ戻る");
    } finally {
      await bff.close();
    }
  });
});

test("宣言が無いモデルへキーをボイスとして保存しても、成功応答 / GET にキーを出さない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // live の一覧を読み込んでから、宣言が無い fish/audio にキーをボイスとして保存する
      await bff.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const put = await bff.app.request("/api/settings/content/speech", jsonPut({ model: OTHER_MODEL, voice: KEY }));
      assert.equal((await put).status, 200, "自由記述のボイスは保存自体は成功する");
      const body = await jsonBody(put);
      assert.equal(body.speech.voice, "", "マスク済みの文字列もそのまま返さない");
      assert.ok(!JSON.stringify(body).includes(KEY), "成功応答にキーを出さない");

      const after = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(after.speech.voice, "");
      assert.ok(!JSON.stringify(after).includes(KEY), "GET にキーを出さない");
      assert.equal(
        pi.contentGenerationConfigs.at(-1)?.readSpeech()?.voice,
        after.speech.voice,
        "実行時の解決も表示と同じにする",
      );
    } finally {
      await bff.close();
    }
  });
});

test("ランタイムなしで再起動しても、保存済みキーをボイスとして GET に出さない", async () => {
  await withStoreDir(async (dir) => {
    // 1) ランタイムありで、宣言が無いモデルのボイスへキーと同じ文字列を保存する
    const first = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      await first.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      await first.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const saved = await first.app.request(
        "/api/settings/content/speech",
        jsonPut({ model: OTHER_MODEL, voice: KEY }),
      );
      assert.equal((await saved).status, 200, "自由記述のボイスは保存自体は成功する");
    } finally {
      await first.close();
    }

    // 2) 同じ DB をランタイムなし（マスカーが保存済みキーを知らない）で開き直す
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const body = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(body.runtimeAvailable, false);
      assert.equal(body.configured, true);
      assert.equal(body.speech.model, OTHER_MODEL);
      assert.equal(body.speech.voice, "", "保存済みキーをボイスとして返さない");
      assert.ok(!JSON.stringify(body).includes(KEY), `GET にキーを出さない: ${JSON.stringify(body.speech)}`);
    } finally {
      await bff.close();
    }
  });
});

test("ランタイムなしでも 400 の文言にキーを反射しない", async () => {
  await withStoreDir(async (dir) => {
    // 1) キーを登録し、live の一覧をキャッシュへ残す
    const first = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      await first.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      await first.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
    } finally {
      await first.close();
    }

    // 2) マスカーが保存済みキーを知らない構成で、宣言ありモデル + キーを反射させる
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const voice = await bff.app.request(
        "/api/settings/content/speech",
        jsonPut({ model: DEFAULT_SPEECH_MODEL, voice: KEY }),
      );
      assert.equal(voice.status, 400);
      const voiceBody = await jsonBody(voice);
      assert.ok(!JSON.stringify(voiceBody).includes(KEY), `400 の文言にキーが出ている: ${voiceBody.error}`);
      assert.ok(String(voiceBody.error).includes("[REDACTED]"));

      const model = await bff.app.request("/api/settings/content/speech", jsonPut({ model: KEY, voice: "" }));
      assert.equal(model.status, 400);
      const modelBody = await jsonBody(model);
      assert.ok(!JSON.stringify(modelBody).includes(KEY), `400 の文言にキーが出ている: ${modelBody.error}`);
      assert.ok(String(modelBody.error).includes("[REDACTED]"));
    } finally {
      await bff.close();
    }
  });
});

test("カタログ外モデル / 宣言外の声 / 形が違う本文は 400", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      // live をカタログへ取り込んでから検証する（default のときは照合しない）
      await bff.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      for (const body of [
        { model: "ghost/model", voice: "" },
        { model: DEFAULT_SPEECH_MODEL, voice: "Ghost" },
        { model: DEFAULT_SPEECH_MODEL },
        { model: 1, voice: "Zephyr" },
      ]) {
        const response = bff.app.request("/api/settings/content/speech", jsonPut(body));
        assert.equal((await response).status, 400, JSON.stringify(body));
      }
    } finally {
      await bff.close();
    }
  });
});

test("カタログが default のときは保存済みの選択を照合せず再保存できる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: liveCatalogFetch,
      speechCatalogFetch: async () => new Response("boom", { status: 503 }),
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const saved = await jsonBody(
        await bff.app.request(
          "/api/settings/content/speech",
          jsonPut({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }),
        ),
      );
      assert.equal(saved.state, "applied");
      assert.equal(saved.speech.catalogSource, "default", "live に成功していない状態を表す");
      // 同じ選択の再保存が 400 にならない（live が取れないだけで保存済みの選択を失わせない）
      const again = bff.app.request(
        "/api/settings/content/speech",
        jsonPut({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }),
      );
      assert.equal((await again).status, 200);
    } finally {
      await bff.close();
    }
  });
});

test("音声カタログの再取得は 200 で一覧を返し、失敗は catalogError にだけ載せる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const refreshed = await jsonBody(
        await bff.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" }),
      );
      assert.equal(refreshed.catalogError, null);
      assert.equal(refreshed.catalogSource, "live");
      assert.equal(typeof refreshed.fetchedAt, "number");
      assert.deepEqual(
        refreshed.models.map((model: any) => model.id),
        [DEFAULT_SPEECH_MODEL, OTHER_MODEL],
      );
      assert.deepEqual(refreshed.models[0].voices, ["Zephyr", "Kore"]);
    } finally {
      await bff.close();
    }
  });

  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: liveCatalogFetch,
      speechCatalogFetch: async () => new Response("boom", { status: 503 }),
    });
    try {
      const response = await bff.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      assert.equal(response.status, 200, "取得できなくても 200 で一覧を失わせない");
      const body = await jsonBody(response);
      assert.equal(body.catalogError, "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）");
      assert.equal(body.catalogSource, "default");
      assert.equal(body.fetchedAt, null);
      assert.equal(body.models.length, 1, "同梱の既定を返す");
    } finally {
      await bff.close();
    }
  });
});

test("起動時に音声列が NULL の保存行があれば、既定モデルと先頭ボイスで読取口を差し替える", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    await first.close();

    const seed = new DatabaseSync(join(dir, APP_DB_FILENAME));
    seed
      .prepare("INSERT INTO content_settings (id, provider, imageModel, apiKey) VALUES (1, ?, ?, ?)")
      .run(IMAGE_PROVIDER_ID, DEFAULT_IMAGE_MODEL, KEY);
    seed.close();

    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.equal(pi.contentGenerationEnabled, true);
      assert.deepEqual(pi.contentGenerationConfigs.at(-1)?.readSpeech(), {
        provider: SPEECH_PROVIDER_ID,
        model: DEFAULT_SPEECH_MODEL,
        voice: "Zephyr",
        apiKey: KEY,
      });
      assert.deepEqual(pi.contentGenerationConfigs.at(-1)?.readVoices(DEFAULT_SPEECH_MODEL), ["Zephyr", "Kore"]);
      const body = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(body.speech.model, DEFAULT_SPEECH_MODEL);
      assert.equal(body.speech.voice, "Zephyr");
      assert.ok(!JSON.stringify(body).includes(KEY));
    } finally {
      await bff.close();
    }
  });
});

test("アプリ DB が使えないときは音声の変更系も 503 not_stored になる", async () => {
  await withStoreDir(async (dir) => {
    // 会話ストアのパスに通常ファイルを指すと、DB を開く前に使えないと分かる
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "x");
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: filePath,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: liveCatalogFetch,
      speechCatalogFetch: liveCatalogFetch,
    });
    try {
      const put = bff.app.request(
        "/api/settings/content/speech",
        jsonPut({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }),
      );
      assert.equal((await put).status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");
    } finally {
      await bff.close();
    }
  });
});
