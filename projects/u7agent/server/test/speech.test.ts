// 音声生成の薄い関数（音声専用 API への要求 / 形式の選択と再試行 / 応答の受け取り / 失敗分類 / timeout と中断の区別）。
// 実 API は呼ばず stub provider と差し替えた fetch で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpeechGenerator,
  SPEECH_ABORTED_MESSAGE,
  SPEECH_API_KEY_INVALID_MESSAGE,
  SPEECH_API_URL,
  SPEECH_CONTENT_TYPE_MESSAGE,
  SPEECH_EMPTY_RESPONSE_MESSAGE,
  SPEECH_INSUFFICIENT_CREDIT_MESSAGE,
  SPEECH_PCM_PARAMETERS_MESSAGE,
  SPEECH_RATE_LIMITED_MESSAGE,
  SPEECH_TIMEOUT_MESSAGE,
  SPEECH_UNKNOWN_FAILURE_MESSAGE,
} from "../src/speech";

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** fetch を差し替え、送信先・ヘッダ・本文をテストから見えるようにする */
function stubFetch(handler: (request: RecordedRequest, index: number) => Response | Promise<Response>): {
  requests: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = { url: String(input), init };
    requests.push(request);
    return handler(request, requests.length - 1);
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

/** pcm 専用モデルの形式違い 400（実測の文言） */
function formatHintResponse(format: "mp3" | "pcm", message?: string): Response {
  return errorResponse(400, message ?? `Gemini TTS only supports response_format="${format}". Got "mp3".`);
}

const baseInput = {
  provider: "openrouter",
  model: "google/gemini-3.8-flash-tts",
  text: "こんにちは",
  apiKey: "sk-speech-dummy-key",
};

/** 1 回だけ生成し、その応答につながるリクエストも返す */
async function generateOnce(
  contentType: string,
  bytes?: number[],
): Promise<{
  requests: RecordedRequest[];
  result: Awaited<ReturnType<ReturnType<typeof createSpeechGenerator>["generate"]>>;
}> {
  const { requests, fetchImpl } = stubFetch(() => audioResponse(bytes, contentType));
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  return { requests, result };
}

/** 送った `response_format` を取り出す */
function sentFormat(request: RecordedRequest | undefined): unknown {
  return (JSON.parse(String(request?.init?.body)) as { response_format?: unknown }).response_format;
}

test("音声専用 API へ POST し、メモが無ければ mp3 から送り、voice は指定があるときだけ送る", async () => {
  const { requests, fetchImpl } = stubFetch(() => audioResponse());
  const generator = createSpeechGenerator({ fetchImpl });

  const withoutVoice = await generator.generate(baseInput);
  assert.equal(withoutVoice.ok, true);
  if (!withoutVoice.ok) return;
  assert.equal(withoutVoice.speech.format, "mp3");
  assert.equal(withoutVoice.speech.contentType, "audio/mpeg");
  assert.deepEqual([...new Uint8Array(withoutVoice.speech.audio)], [1, 2, 3]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, SPEECH_API_URL);
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${baseInput.apiKey}`);
  // API の既定は pcm なので、mp3 を送らないと再生できるファイルにならない
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

test("応答の形式は Content-Type だけで決め、mp3 は audio/mpeg、pcm は audio/pcm を読む", async () => {
  const mp3 = await generateOnce("Audio/MPEG; charset=binary");
  assert.equal(mp3.requests.length, 1, "Content-Type が対応形式なら再試行しない");
  assert.equal(mp3.result.ok, true);
  if (mp3.result.ok && mp3.result.speech.format === "mp3") {
    assert.equal(mp3.result.speech.contentType, "audio/mpeg");
    assert.deepEqual([...new Uint8Array(mp3.result.speech.audio)], [1, 2, 3]);
  } else {
    assert.fail("audio/mpeg を mp3 として読んでいない");
  }

  const pcm = await generateOnce("audio/pcm;rate=24000;channels=1", [1, 2, 3, 4]);
  assert.equal(pcm.requests.length, 1);
  assert.equal(pcm.result.ok, true);
  if (pcm.result.ok && pcm.result.speech.format === "pcm") {
    assert.equal(pcm.result.speech.contentType, "audio/pcm");
    assert.equal(pcm.result.speech.sampleRate, 24000);
    assert.equal(pcm.result.speech.channels, 1);
    assert.deepEqual([...new Uint8Array(pcm.result.speech.audio)], [1, 2, 3, 4]);
  } else {
    assert.fail("audio/pcm を pcm として読んでいない");
  }

  // 区切りの空白の有無を許す（パラメータ付きの Content-Type は両方の綴りがありうる）
  const spaced = await generateOnce("audio/pcm; rate=44100; channels=2");
  assert.equal(spaced.result.ok, true);
  if (spaced.result.ok && spaced.result.speech.format === "pcm") {
    assert.equal(spaced.result.speech.sampleRate, 44100);
    assert.equal(spaced.result.speech.channels, 2);
  } else {
    assert.fail("空白付きのパラメータを読んでいない");
  }
});

test("Content-Type が audio/mpeg / audio/pcm 以外の 2xx は失敗にする", async () => {
  for (const contentType of ["audio/ogg", "audio/wav", "text/html", "application/json", ""]) {
    const { result } = await generateOnce(contentType);
    assert.deepEqual(result, { ok: false, code: "unknown", message: SPEECH_CONTENT_TYPE_MESSAGE }, contentType);
  }
});

test("pcm の rate / channels が無い・不正な応答は失敗にする（推測しない）", async () => {
  const cases = [
    "audio/pcm",
    "audio/pcm;channels=1",
    "audio/pcm;rate=24000",
    "audio/pcm;rate=abc;channels=1",
    "audio/pcm;rate=24000.5;channels=1",
    "audio/pcm;rate=0;channels=0",
  ];
  for (const contentType of cases) {
    const { result } = await generateOnce(contentType);
    assert.deepEqual(result, { ok: false, code: "unknown", message: SPEECH_PCM_PARAMETERS_MESSAGE }, contentType);
  }
});

test("2xx でも本文が 0 バイトの応答は失敗にする", async () => {
  const { result } = await generateOnce("audio/mpeg", []);
  assert.deepEqual(result, { ok: false, code: "unknown", message: SPEECH_EMPTY_RESPONSE_MESSAGE });
});

test("形式違いを示す 400 のときだけ他方の形式へ 1 回だけ再試行する", async () => {
  const { requests, fetchImpl } = stubFetch((_request, index) =>
    index === 0 ? formatHintResponse("pcm") : audioResponse([4, 5], "audio/pcm;rate=24000;channels=1"),
  );
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.speech.format, "pcm");
  assert.equal(requests.length, 2, "再試行は 1 回だけ");
  assert.equal(sentFormat(requests[0]), "mp3");
  assert.equal(sentFormat(requests[1]), "pcm");
});

test("形式違いの検知は引用符・空白・大小の揺れを許す", async () => {
  for (const message of [
    `model only supports response_format='pcm'`,
    `Only supports response_format = PCM`,
    `provider: only supports response_format = "pcm"`,
  ]) {
    const { requests, fetchImpl } = stubFetch((_request, index) =>
      index === 0 ? formatHintResponse("pcm", message) : audioResponse([1], "audio/pcm;rate=24000;channels=1"),
    );
    const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
    assert.equal(result.ok, true, message);
    assert.equal(requests.length, 2, message);
    assert.equal(sentFormat(requests[1]), "pcm", message);
  }
});

test("形式違いを示さない 400 は再試行せず、今までどおり分類する", async () => {
  const { requests, fetchImpl } = stubFetch(() => errorResponse(400, "voice is not supported"));
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.ok(result.message.includes("voice is not supported"));
  assert.equal(requests.length, 1);
});

test("再試行しても解消しなければ 2 回で止め、最後の応答で分類する", async () => {
  const { requests, fetchImpl } = stubFetch((_request, index) =>
    index === 0
      ? formatHintResponse("pcm")
      : formatHintResponse("mp3", `still not pcm: only supports response_format = 'mp3'`),
  );
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.ok(result.message.includes("still not pcm"), result.message);
  assert.equal(result.message.includes("Got"), false, "1 回目の provider メッセージを出している");
  assert.equal(requests.length, 2, "再試行は 1 回まで");
});

test("最終的な失敗は最後の試行の status と provider メッセージで分類する", async () => {
  const { requests, fetchImpl } = stubFetch((_request, index) =>
    index === 0 ? formatHintResponse("pcm") : errorResponse(402),
  );
  const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
  assert.deepEqual(result, { ok: false, code: "insufficient_credit", message: SPEECH_INSUFFICIENT_CREDIT_MESSAGE });
  assert.equal(requests.length, 2);
});

test("学習した形式はメモから先に送り、再試行を繰り返さない", async () => {
  const { requests, fetchImpl } = stubFetch((_request, index) =>
    index === 0 ? formatHintResponse("pcm") : audioResponse([1], "audio/pcm;rate=24000;channels=1"),
  );
  const generator = createSpeechGenerator({ fetchImpl });
  await generator.generate(baseInput);
  const second = await generator.generate(baseInput);
  assert.equal(second.ok, true);
  assert.equal(requests.length, 3, "2 回目は再試行なしで pcm を送る");
  assert.equal(sentFormat(requests[2]), "pcm");
});

test("メモは要求した形式ではなく応答の Content-Type で確定した実形式にする", async () => {
  const { requests, fetchImpl } = stubFetch((_request, index) =>
    // 1 回目は「pcm のみ」と言われて pcm で再試行するが、返ってきたのは mp3 だった
    index === 0 ? formatHintResponse("pcm") : audioResponse([1], "audio/mpeg"),
  );
  const generator = createSpeechGenerator({ fetchImpl });
  const first = await generator.generate(baseInput);
  assert.equal(first.ok && first.speech.format, "mp3");
  await generator.generate(baseInput);
  assert.equal(requests.length, 3);
  assert.equal(sentFormat(requests[2]), "mp3", "応答で確定した実形式を先に送っていない");
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
    const { requests, fetchImpl } = stubFetch(() => errorResponse(status));
    const result = await createSpeechGenerator({ fetchImpl }).generate(baseInput);
    assert.equal(result.ok, false, `${status} を成功にしている`);
    if (result.ok) continue;
    assert.equal(result.message, message);
    assert.equal(requests.length, 1, `${status} で再試行している`);
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

test("分類: 期限は両試行で共有し、再試行中の待機にも掛かる", async () => {
  const { requests, fetchImpl } = stubFetch((request, index) => {
    if (index === 0) return formatHintResponse("pcm");
    return new Promise<Response>((_resolve, reject) => {
      request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const result = await createSpeechGenerator({ fetchImpl, timeoutMs: 20 }).generate(baseInput);
  assert.deepEqual(result, { ok: false, code: "timeout", message: SPEECH_TIMEOUT_MESSAGE });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.init?.signal, requests[1]?.init?.signal, "期限は 1 つの controller を共有する");
  assert.equal(requests[1]?.init?.signal?.aborted, true);
});

test("分類: ユーザー中断は再試行中の待機にも掛かる", async () => {
  const controller = new AbortController();
  let notifySecond: () => void = () => {};
  const secondStarted = new Promise<void>((resolve) => {
    notifySecond = resolve;
  });
  const { requests, fetchImpl } = stubFetch((request, index) => {
    if (index === 0) return formatHintResponse("pcm");
    notifySecond();
    return new Promise<Response>((_resolve, reject) => {
      request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const pending = createSpeechGenerator({ fetchImpl, timeoutMs: 60_000 }).generate({
    ...baseInput,
    signal: controller.signal,
  });
  await secondStarted;
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: "aborted", message: SPEECH_ABORTED_MESSAGE });
  assert.equal(requests.length, 2);
});

test("分類: 再試行の前に中断済みなら再試行せず aborted を返す", async () => {
  const controller = new AbortController();
  const { requests, fetchImpl } = stubFetch(() => {
    controller.abort();
    return formatHintResponse("pcm");
  });
  const result = await createSpeechGenerator({ fetchImpl, timeoutMs: 60_000 }).generate({
    ...baseInput,
    signal: controller.signal,
  });
  assert.deepEqual(result, { ok: false, code: "aborted", message: SPEECH_ABORTED_MESSAGE });
  assert.equal(requests.length, 1, "中断済みの signal で再試行している");
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
