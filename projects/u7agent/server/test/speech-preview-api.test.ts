// 音声のお試し再生 API（POST /api/settings/content/speech/preview）の契約。実 API は呼ばず stub pi と
// アプリ DB で検証する（課金前の検証 / 音声バイトとヘッダ / 失敗の分類 / 中断 / 保存ロックの外）。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import {
  CONTENT_SETTINGS_UNCONFIGURED_MESSAGE,
  CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_SPEECH_PREVIEW_INSTRUCTIONS_TOO_LONG_MESSAGE,
  CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_SPEECH_PREVIEW_SPEED_MESSAGE,
  CONTENT_SPEECH_PREVIEW_TEXT_EMPTY_MESSAGE,
  CONTENT_SPEECH_PREVIEW_TEXT_TOO_LONG_MESSAGE,
  CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE,
} from "../src/content-settings";
import { SPEECH_ABORTED_MESSAGE, SPEECH_TEXT_MAX_LENGTH, SPEECH_TIMEOUT_MESSAGE } from "../src/speech";
import type { SpeechGenerationResult } from "../src/speech";
import { DEFAULT_SPEECH_MODEL } from "../src/speech-catalog";
import { asPiBff, createStubPi, stubSpeechAudio, waitFor, type StubPiOptions } from "./stub-pi";

const PREVIEW_PATH = "/api/settings/content/speech/preview";
const KEY = "sk-speech-preview-dummy-key-0123456789";
const OTHER_MODEL = "fish/audio";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonRequest = (payload: unknown, init: RequestInit = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  ...init,
});

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-speech-preview-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 実 API を叩かせないための live カタログ stub（宣言ありモデルと宣言なしモデルを 1 件ずつ） */
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

const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({ ...options, imageCatalogFetch: liveCatalogFetch, speechCatalogFetch: liveCatalogFetch });

type Bff = Awaited<ReturnType<typeof createBffApp>>;
type StubPi = ReturnType<typeof createStubPi>;

/** キーを登録し、live カタログを取り込んだ状態の BFF。検証はこの前提で行う */
async function withConfiguredBff(
  run: (bff: Bff, pi: StubPi) => Promise<void>,
  options: { pi?: StubPiOptions; mutatePi?: (pi: StubPi) => void } = {},
): Promise<void> {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(options.pi);
    options.mutatePi?.(pi);
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonRequest({ apiKey: KEY }, { method: "PUT" }));
      await bff.app.request("/api/settings/content/speech/catalog/refresh", { method: "POST" });
      await run(bff, pi);
    } finally {
      await bff.close();
    }
  });
}

/** 成功する stub 生成器の結果（mp3 の固定バイト）。形式の扱いは応答の Content-Type で見る */
const mp3Speech = (bytes: number[]): SpeechGenerationResult => ({
  ok: true,
  speech: { audio: new Uint8Array(bytes).buffer, format: "mp3", contentType: "audio/mpeg" },
});

test("課金前の検証で止める 400 は provider を叩かない", async () => {
  // 行が無い状態はキー登録より先に 400（provider も DB 書込も起こさない）
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await jsonBody(response), { error: CONTENT_SETTINGS_UNCONFIGURED_MESSAGE });
      assert.equal(pi.speechCalls.length, 0);
    } finally {
      await bff.close();
    }
  });

  await withConfiguredBff(async (bff, pi) => {
    const cases: { body: Record<string, unknown>; message: string }[] = [
      {
        body: { model: "ghost/model", voice: "", text: "こんにちは" },
        message: CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE,
      },
      {
        body: { model: DEFAULT_SPEECH_MODEL, voice: "Ghost", text: "こんにちは" },
        message: CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE,
      },
      {
        body: { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "   " },
        message: CONTENT_SPEECH_PREVIEW_TEXT_EMPTY_MESSAGE,
      },
      {
        body: { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "x".repeat(SPEECH_TEXT_MAX_LENGTH + 1) },
        message: CONTENT_SPEECH_PREVIEW_TEXT_TOO_LONG_MESSAGE,
      },
      {
        body: {
          model: DEFAULT_SPEECH_MODEL,
          voice: "Zephyr",
          text: "こんにちは",
          instructions: "x".repeat(SPEECH_TEXT_MAX_LENGTH + 1),
        },
        message: CONTENT_SPEECH_PREVIEW_INSTRUCTIONS_TOO_LONG_MESSAGE,
      },
      {
        body: { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは", speed: 0 },
        message: CONTENT_SPEECH_PREVIEW_SPEED_MESSAGE,
      },
      {
        body: { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは", speed: -1.5 },
        message: CONTENT_SPEECH_PREVIEW_SPEED_MESSAGE,
      },
    ];
    for (const { body, message } of cases) {
      const response = await bff.app.request(PREVIEW_PATH, jsonRequest(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok(String((await jsonBody(response)).error).startsWith(message), JSON.stringify(body));
    }

    // 本文の形（speed の型・必須キーの欠落）は zod が 400 にする
    for (const body of [
      { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは", speed: "fast" },
      { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは", speed: null },
      { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" },
      { model: DEFAULT_SPEECH_MODEL, text: "こんにちは" },
    ]) {
      const response = await bff.app.request(PREVIEW_PATH, jsonRequest(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await jsonBody(response), { error: "Invalid request body" });
    }
    assert.equal(pi.speechCalls.length, 0, "課金前の検証で provider を呼んでいる");
  });
});

test("成功は音声バイトを返し、mp3 は audio/mpeg、pcm は RIFF 付きの audio/wav にする", async () => {
  await withConfiguredBff(
    async (bff, pi) => {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({
          model: DEFAULT_SPEECH_MODEL,
          voice: "Zephyr",
          text: "こんにちは",
          instructions: "落ち着いた声で",
          speed: 1.25,
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
      // 画面で選んだ値だけを送る（保存済みのモデル / ボイスではない）
      const call = pi.speechCalls.at(-1);
      assert.equal(call?.provider, "openrouter");
      assert.equal(call?.model, DEFAULT_SPEECH_MODEL);
      assert.equal(call?.voice, "Zephyr");
      assert.equal(call?.text, "こんにちは");
      assert.equal(call?.instructions, "落ち着いた声で");
      assert.equal(call?.speed, 1.25);
      assert.equal(call?.apiKey, KEY);
      assert.ok(call?.signal instanceof AbortSignal, "リクエストの中断を生成器へ渡す");
    },
    { pi: { onGenerateSpeech: () => mp3Speech([1, 2, 3]) } },
  );

  // pcm は RIFF ヘッダを付けて wav にする（クライアントは Content-Type だけで形式を判別する）
  await withConfiguredBff(async (bff) => {
    const response = await bff.app.request(
      PREVIEW_PATH,
      jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const wav = new Uint8Array(await response.arrayBuffer());
    const ascii = (offset: number): string => String.fromCharCode(...wav.slice(offset, offset + 4));
    assert.equal(ascii(0), "RIFF");
    assert.equal(ascii(8), "WAVE");
    assert.equal(wav.byteLength, 44 + stubSpeechAudio().byteLength, "ヘッダ 44 バイト + pcm の実データ");
  });
});

test("instructions を空で送ると、要求本文からキーごと落ちる", async () => {
  await withConfiguredBff(async (bff, pi) => {
    const response = await bff.app.request(
      PREVIEW_PATH,
      jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは", instructions: "" }),
    );
    assert.equal(response.status, 200);
    const call = pi.speechCalls.at(-1);
    assert.equal(call?.instructions, "");
    assert.equal(call?.speed, undefined);
  });
});

test("provider の失敗は 502 と分類コード・マスク済み文言で返す", async () => {
  await withConfiguredBff(
    async (bff) => {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 502);
      assert.deepEqual(await jsonBody(response), {
        error: "音声生成に失敗しました: [REDACTED] は無効です",
        code: "unknown",
      });
    },
    {
      pi: {
        onGenerateSpeech: () => ({
          ok: false,
          code: "unknown",
          message: `音声生成に失敗しました: [REDACTED] は無効です`,
        }),
      },
    },
  );

  // 分類コードは provider-failure.ts の union をそのまま載せる（二重定義しない）
  await withConfiguredBff(
    async (bff) => {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 502);
      assert.deepEqual(await jsonBody(response), {
        error: "音声生成の残高が不足しています",
        code: "insufficient_credit",
      });
    },
    {
      pi: {
        onGenerateSpeech: () => ({ ok: false, code: "insufficient_credit", message: "音声生成の残高が不足しています" }),
      },
    },
  );
});

test("timeout とユーザー中断は 502 の分類コードで返る", async () => {
  await withConfiguredBff(
    async (bff) => {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 502);
      assert.deepEqual(await jsonBody(response), { error: SPEECH_TIMEOUT_MESSAGE, code: "timeout" });
    },
    { pi: { onGenerateSpeech: () => ({ ok: false, code: "timeout", message: SPEECH_TIMEOUT_MESSAGE }) } },
  );

  // 中断はリクエストの signal を生成器が待ち、abort で分類済みの結果を返す経路で見る
  await withConfiguredBff(
    async (bff, pi) => {
      const controller = new AbortController();
      const pending = bff.app.request(
        PREVIEW_PATH,
        jsonRequest(
          { model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" },
          { signal: controller.signal },
        ),
      );
      await waitFor(() => pi.speechCalls.length === 1, 3000, "生成器の呼び出し");
      controller.abort();
      const response = await pending;
      assert.equal(response.status, 502);
      assert.deepEqual(await jsonBody(response), { error: SPEECH_ABORTED_MESSAGE, code: "aborted" });
    },
    {
      pi: {
        onGenerateSpeech: (input) =>
          new Promise((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => resolve({ ok: false, code: "aborted", message: SPEECH_ABORTED_MESSAGE }),
              { once: true },
            );
          }),
      },
    },
  );
});

test("キーを model / voice 欄へ渡した 400 は、応答に入力値もキーも出さない", async () => {
  // ランタイムはあるが、マスカーが保存済みキーを知らない構成（実行時のマスカーに依存しない伏せ字）
  await withConfiguredBff(
    async (bff) => {
      const model = await bff.app.request(PREVIEW_PATH, jsonRequest({ model: KEY, voice: "", text: "こんにちは" }));
      assert.equal(model.status, 400);
      const modelBody = await jsonBody(model);
      assert.ok(String(modelBody.error).includes("[REDACTED]"), modelBody.error);
      assert.ok(!JSON.stringify(modelBody).includes(KEY), `400 の文言にキーが出ている: ${modelBody.error}`);

      const voice = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: KEY, text: "こんにちは" }),
      );
      assert.equal(voice.status, 400);
      const voiceBody = await jsonBody(voice);
      assert.ok(String(voiceBody.error).includes("[REDACTED]"), voiceBody.error);
      assert.ok(!JSON.stringify(voiceBody).includes(KEY), `400 の文言にキーが出ている: ${voiceBody.error}`);
    },
    {
      mutatePi: (pi) => {
        pi.retainSecret = () => {};
      },
    },
  );
});

test("runtime 不可は 503、DB 不通は 503 で、どちらも provider を叩かない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), { error: CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE });
    } finally {
      await bff.close();
    }
  });

  await withStoreDir(async (dir) => {
    // 会話ストアのパスに通常ファイルを指すと、DB を開く前に使えないと分かる
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "x");
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: filePath, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      assert.equal(response.status, 503);
      assert.ok(String((await jsonBody(response)).error).includes("アプリデータ（SQLite）を利用できません"));
      assert.equal(pi.speechCalls.length, 0);
    } finally {
      await bff.close();
    }
  });
});

test("provider の応答を待っている間に PUT /speech が通る（保存ロックを取らない）", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withConfiguredBff(
    async (bff, pi) => {
      const pending = bff.app.request(
        PREVIEW_PATH,
        jsonRequest({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
      );
      await waitFor(() => pi.speechCalls.length === 1, 3000, "生成器の呼び出し");

      const put = await bff.app.request(
        "/api/settings/content/speech",
        jsonRequest({ model: OTHER_MODEL, voice: "any-voice-id" }, { method: "PUT" }),
      );
      assert.equal(put.status, 200, "最大 180 秒かかる試し再生が設定の保存を塞いでいる");

      release();
      assert.equal((await pending).status, 200);
    },
    {
      pi: {
        onGenerateSpeech: async () => {
          await gate;
          return mp3Speech([1]);
        },
      },
    },
  );
});
