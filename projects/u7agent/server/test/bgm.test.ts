import assert from "node:assert/strict";
import test from "node:test";
import { assertBgmMp3, BGM_API_URL, BGM_LIMITS, BGM_MODEL, createBgmGenerator } from "../src/bgm";
import { createMutableSecretMasker } from "../src/redact";
import { bgmAudio, bgmEvent, bgmStop, SYNTHETIC_BGM_SSE, SYNTHETIC_MP3 } from "./fixtures/bgm-sse";

const key = "sk-bgm-dummy-key-not-real";
const input = () => ({ prompt: "明るいレースゲーム", apiKey: key, signal: new AbortController().signal });

function response(text: string, split = text.length, captures = { canceled: 0 }) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + split));
        offset = Math.min(bytes.length, offset + split);
      },
      cancel() {
        captures.canceled += 1;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("公開資料に基づく暫定要求は固定モデル・voice省略・MP3・instrumental、再送なし", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const generator = createBgmGenerator({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return response(SYNTHETIC_BGM_SSE);
    },
  });
  assert.deepEqual(await generator.generate(input()), new Uint8Array(SYNTHETIC_MP3));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, BGM_API_URL);
  assert.deepEqual(JSON.parse(requests[0].init.body as string), {
    model: BGM_MODEL,
    messages: [{ role: "user", content: "明るいレースゲーム\n\nInstrumental only, no vocals." }],
    modalities: ["text", "audio"],
    audio: { format: "mp3" },
    stream: true,
  });
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), `Bearer ${key}`);
});

test("SSEとネットワーク境界を分け、コメント・CR/LF・UTF-8・usage終端再掲を扱う", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    for (const split of [1, 7, 37, 1024]) {
      const text = SYNTHETIC_BGM_SSE.replace(": keep-alive", ": 日本語keep-alive").replaceAll("\n", ending);
      const generator = createBgmGenerator({ fetchImpl: async () => response(text, split) });
      assert.deepEqual(await generator.generate(input()), new Uint8Array(SYNTHETIC_MP3));
    }
  }
  const multiLine =
    'event: message\nid: 1\ndata: {"choices":\ndata: [{"delta":{"audio":{"data":"' +
    SYNTHETIC_MP3.toString("base64") +
    '"}}}]}\n\n';
  const text = multiLine + bgmEvent(bgmStop) + bgmEvent({ choices: [], usage: {} }) + "data: [DONE]\n\n";
  assert.deepEqual(
    await createBgmGenerator({ fetchImpl: async () => response(text, 3) }).generate(input()),
    new Uint8Array(SYNTHETIC_MP3),
  );
});

test("独立したBase64イベントを連結し、別のtrackや音声配列は拒否する", async () => {
  const parts = [SYNTHETIC_MP3.subarray(0, 5), SYNTHETIC_MP3.subarray(5)];
  const text =
    parts.map((part) => bgmEvent(bgmAudio(part.toString("base64")))).join("") + bgmEvent(bgmStop) + "data: [DONE]\n\n";
  assert.deepEqual(
    await createBgmGenerator({ fetchImpl: async () => response(text) }).generate(input()),
    new Uint8Array(SYNTHETIC_MP3),
  );
  for (const bad of [
    bgmEvent(bgmAudio()) + bgmEvent(bgmAudio(undefined, "another")),
    bgmEvent({ choices: [{ delta: { audio: [{ data: "AAAA" }] } }] }),
    bgmEvent({ choices: [{ delta: {} }, { delta: {} }] }),
    bgmEvent({ choices: [{ index: 1, delta: {} }] }),
  ])
    await assert.rejects(
      createBgmGenerator({ fetchImpl: async () => response(bad) }).generate(input()),
      /トラック|複数|未対応/,
    );
});

test("不正JSON・Base64/padding・空音声・EOF・異常終端・refusal・200内errorは失敗する", async () => {
  const end = bgmEvent(bgmStop) + "data: [DONE]\n\n";
  for (const bad of [
    "data: {broken}\n\n",
    "data: [DONE]\n\n",
    bgmEvent(bgmStop) + "data: [DONE]\n\n",
    bgmEvent(bgmAudio()),
    bgmEvent(bgmAudio()) + bgmEvent(bgmStop),
    bgmEvent(bgmAudio()) + "data: [DONE]\n\n",
    bgmEvent({ choices: [{ delta: {}, finish_reason: "length" }] }),
    bgmEvent({ choices: [{ delta: { refusal: "no" } }] }),
    bgmEvent({ error: { message: "provider failure" } }),
    bgmEvent(bgmAudio()) + bgmEvent(bgmStop) + bgmEvent(bgmAudio()) + "data: [DONE]\n\n",
    ...["!AAA", " A==", "AAA", "A===", "AA=A", "AB==", "AAB=", "AA==AAAA", "", "UklGRg=="].map(
      (data) => bgmEvent(bgmAudio(data)) + end,
    ),
  ]) {
    let calls = 0;
    await assert.rejects(
      createBgmGenerator({
        fetchImpl: async () => {
          calls += 1;
          return response(bad, 13);
        },
      }).generate(input()),
      Error,
      bad.slice(0, 160),
    );
    assert.equal(calls, 1);
  }
});

test("MP3はID3タグの後のLayer IIIヘッダか生フレームのみ、空・RIFF・ID3だけを拒否", () => {
  assert.doesNotThrow(() => assertBgmMp3(SYNTHETIC_MP3));
  assert.doesNotThrow(() =>
    assertBgmMp3(Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), SYNTHETIC_MP3])),
  );
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("RIFFsomething"),
    Buffer.from([73, 68, 51, 4]),
    Buffer.from([255, 249, 144, 100, 0]),
  ])
    assert.throws(() => assertBgmMp3(bytes));
});

test("各サイズ上限で受信停止しreaderを解放する（上限はテストで縮小）", async () => {
  assert.deepEqual(BGM_LIMITS, { audio: 33554432, event: 50331648, total: 67108864, error: 65536 });
  const cases = [
    { limits: { audio: SYNTHETIC_MP3.length - 1 }, text: SYNTHETIC_BGM_SSE, pattern: /音声サイズ/ },
    { limits: { event: 60 }, text: "data: " + "a".repeat(61), pattern: /イベントサイズ/ },
    { limits: { event: 60 }, text: ":" + "a".repeat(61) + "\n\n", pattern: /イベントサイズ/ },
    { limits: { total: 100 }, text: ":" + "a".repeat(30) + "\n\n" + SYNTHETIC_BGM_SSE, pattern: /総受信/ },
  ];
  for (const { limits, text, pattern } of cases) {
    const capture = { canceled: 0 };
    const res = response(text, 1, capture);
    await assert.rejects(createBgmGenerator({ limits, fetchImpl: async () => res }).generate(input()), pattern);
    assert.equal(res.body!.locked, false);
    assert.equal(capture.canceled, 1);
  }
});

test("CRLFがチャンクをまたいでもイベント上限は正規化前の受信バイトで判定する", async () => {
  const keepalive = ":comment\r\n:comment\r\n\r\n";
  const capture = { canceled: 0 };
  const result = response(keepalive + ":unread\n\n", 1, capture);
  const generator = createBgmGenerator({
    fetchImpl: async () => result,
    limits: { event: Buffer.byteLength(keepalive) - 1 },
  });
  await assert.rejects(generator.generate(input()), /イベントサイズ上限/);
  assert.equal(capture.canceled, 1);
  assert.equal(result.body?.locked, false);
});

test("非2xx本文は64KiBまで、外部メッセージはmask後500文字までで再送しない", async () => {
  const mask = createMutableSecretMasker([key]);
  for (const status of [400, 401, 402, 429, 500]) {
    let calls = 0;
    const generator = createBgmGenerator({
      maskText: mask.mask,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: `${key}${"x".repeat(1000)}` } }), { status });
      },
    });
    await assert.rejects(
      generator.generate(input()),
      (error: Error) =>
        !error.message.includes(key) && error.message.includes("[REDACTED]") && error.message.length <= 500,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    createBgmGenerator({
      fetchImpl: async () => new Response("x".repeat(BGM_LIMITS.error + 1), { status: 400 }),
    }).generate(input()),
    /本文の上限/,
  );
  await assert.rejects(
    createBgmGenerator({
      maskText: mask.mask,
      fetchImpl: async () => response(bgmEvent({ error: { message: key + "z".repeat(600) } })),
    }).generate(input()),
    (error: Error) => !error.message.includes(key) && error.message.length <= 500,
  );
});

test("ヘッダ待ちとSSE読取りの中断で、接続・readerを解放する", async () => {
  const controller = new AbortController();
  let resolve!: (res: Response) => void;
  const pending = createBgmGenerator({
    fetchImpl: () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  }).generate({ ...input(), signal: controller.signal });
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
  const capture = { canceled: 0 };
  const late = response(SYNTHETIC_BGM_SSE, 1, capture);
  resolve(late);
  await new Promise((yes) => setImmediate(yes));
  assert.equal(capture.canceled, 1);

  const abort = new AbortController();
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled += 1;
    },
  });
  const waiting = createBgmGenerator({
    fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  }).generate({ ...input(), signal: abort.signal });
  await new Promise((yes) => setImmediate(yes));
  abort.abort(new Error("stop reading"));
  await assert.rejects(waiting, /stop reading/);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});
