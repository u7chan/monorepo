// 音声生成の薄い関数（音声専用 API への要求 / 応答の受け取り / 失敗分類 / timeout と中断の区別）。
// 実 API は呼ばず stub provider と差し替えた fetch で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpeechGenerator,
  isAudioContentType,
  SPEECH_ABORTED_MESSAGE,
  SPEECH_API_KEY_INVALID_MESSAGE,
  SPEECH_API_URL,
  SPEECH_CONTENT_TYPE_MESSAGE,
  SPEECH_EMPTY_RESPONSE_MESSAGE,
  SPEECH_INSUFFICIENT_CREDIT_MESSAGE,
  SPEECH_RATE_LIMITED_MESSAGE,
  SPEECH_TIMEOUT_MESSAGE,
  SPEECH_UNKNOWN_FAILURE_MESSAGE,
} from "../src/speech";

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** fetch を差し替え、送信先・ヘッダ・本文をテストから見えるようにする */
function stubFetch(handler: (request: RecordedRequest) => Response | Promise<Response>): {
  requests: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = { url: String(input), init };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

/** 2xx の音声応答。OpenRouter は JSON ではなく生バイトを返す */
function audioResponse(bytes = [1, 2, 3], contentType = "audio/mpeg"): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

/** OpenRouter のエラー形（`{"error":{"message":...}}`）で非 2xx を返す */
function errorResponse(status: number, message = `provider error ${status}`): Response {
  return new Response(JSON.stringify({ error: { message, code: status } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseInput = {
  provider: "openrouter",
  model: "google/gemini-3.8-flash-tts",
  text: "こんにちは",
  apiKey: "sk-speech-dummy-key",
};

test("Content-Type の判定は audio/* だけを成功にし、パラメータと大文字小文字を無視する", () => {
  assert.equal(isAudioContentType("audio/mpeg"), true);
  assert.equal(isAudioContentType("Audio/MPEG; charset=binary"), true);
  assert.equal(isAudioContentType(" application/json"), false);
  assert.equal(isAudioContentType("text/html"), false);
  assert.equal(isAudioContentType(""), false);
});

test("音声専用 API へ POST し、mp3 を常に要求し、voice は指定があるときだけ送る", async () => {
  const { requests, fetchImpl } = stubFetch(() => audioResponse());
  const generator = createSpeechGenerator({ fetchImpl });

  const withoutVoice = await generator.generate(baseInput);
  assert.equal(withoutVoice.ok, true);
  if (!withoutVoice.ok) return;
  assert.equal(withoutVoice.speech.contentType, "audio/mpeg");
  assert.deepEqual([...new Uint8Array(withoutVoice.speech.audio)], [1, 2, 3]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, SPEECH_API_URL);
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${baseInput.apiKey}`);
  // 既定は pcm なので、mp3 を送らないと再生も保存もできない
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: baseInput.model,
    input: baseInput.text,
    response_format: "mp3",
  });

  await generator.generate({ ...baseInput, voice: "Kore" });
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    model: baseInput.model,
    input: baseInput.text,
    voice: "Kore",
    response_format: "mp3",
  });
});

test("2xx でも本文が 0 バイト / 音声以外の Content-Type は失敗にする", async () => {
  const empty = stubFetch(() => audioResponse([]));
  const emptyResult = await createSpeechGenerator({ fetchImpl: empty.fetchImpl }).generate(baseInput);
  assert.deepEqual(emptyResult, { ok: false, code: "unknown", message: SPEECH_EMPTY_RESPONSE_MESSAGE });

  const html = stubFetch(
    () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  const htmlResult = await createSpeechGenerator({ fetchImpl: html.fetchImpl }).generate(baseInput);
  assert.deepEqual(htmlResult, { ok: false, code: "unknown", message: SPEECH_CONTENT_TYPE_MESSAGE });
});

test("分類: 401 / 403 はキー無効、402 は残高不足、429 と 5xx は混雑", async () => {
  const cases: [number, string][] = [
    [401, SPEECH_API_KEY_INVALID_MESSAGE],
    [403, SPEECH_API_KEY_INVALID_MESSAGE],
    [402, SPEECH_INSUFFICIENT_CREDIT_MESSAGE],
    [429, SPEECH_RATE_LIMITED_MESSAGE],
    [500, SPEECH_RATE_LIMITED_MESSAGE],
    [502, SPEECH_RATE_LIMITED_MESSAGE],
  ];
  for (const [status, message] of cases) {
    const { fetchImpl } = stubFetch(() => errorResponse(status));
    const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
    assert.equal(result.ok, false, `${status} を成功にしている`);
    if (result.ok) continue;
    assert.equal(result.message, message);
  }
});

test("分類: 未知の status はマスク済み provider メッセージ付きの原因不明にする", async () => {
  const key = "sk-speech-dummy-key-0123456789";
  const { fetchImpl } = stubFetch(() => errorResponse(400, `voice is not supported: ${key}`));
  const result = await createSpeechGenerator({
    fetchImpl,
    maskText: (text) => text.split(key).join("[REDACTED]"),
  }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.ok(result.message.startsWith(SPEECH_UNKNOWN_FAILURE_MESSAGE));
  assert.ok(result.message.includes("[REDACTED]"), "provider メッセージはマスクを通す");
  assert.ok(!result.message.includes(key));
});

test("分類: JSON でないエラー本文も生テキストを理由に使える", async () => {
  const plain = stubFetch(
    () =>
      new Response("voice is not supported by the provider", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
  );
  const result = await createSpeechGenerator({ fetchImpl: plain.fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.message.includes("voice is not supported by the provider"));

  const badGateway = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const limited = await createSpeechGenerator({ fetchImpl: badGateway.fetchImpl }).generate(baseInput);
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.message, SPEECH_RATE_LIMITED_MESSAGE, "5xx は生テキストを出さず混雑へ畳む");
});

test("分類: タイムアウトは自前タイマーで abort し、ユーザー中断と混ざらない", async () => {
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  const timedOut = await createSpeechGenerator({ fetchImpl: hangingFetch, timeoutMs: 20 }).generate(baseInput);
  assert.equal(timedOut.ok, false);
  if (timedOut.ok) return;
  assert.equal(timedOut.code, "timeout");
  assert.equal(timedOut.message, SPEECH_TIMEOUT_MESSAGE);

  const controller = new AbortController();
  const pending = createSpeechGenerator({ fetchImpl: hangingFetch, timeoutMs: 60_000 }).generate({
    ...baseInput,
    signal: controller.signal,
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  if (aborted.ok) return;
  assert.equal(aborted.code, "aborted");
  assert.equal(aborted.message, SPEECH_ABORTED_MESSAGE);
});

test("分類: 開始前に中断済みの signal でもユーザー中断として返す", async () => {
  const controller = new AbortController();
  controller.abort();
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  const result = await createSpeechGenerator({ fetchImpl: hangingFetch, timeoutMs: 60_000 }).generate({
    ...baseInput,
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "aborted");
});

test("provider メッセージは 500 文字までに切る", async () => {
  const { fetchImpl } = stubFetch(() => errorResponse(400, "x".repeat(900)));
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // "音声生成に失敗しました: " + 500 文字
  assert.equal(result.message.length, SPEECH_UNKNOWN_FAILURE_MESSAGE.length + 2 + 500);
});
