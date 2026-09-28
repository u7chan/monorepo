// 画像生成の薄い関数（カタログ / 画像専用 API への要求 / 失敗分類 / timeout と中断の区別）。
// 実 API は呼ばず stub provider と差し替えた fetch で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ImagesModel, ImagesProvider } from "@earendil-works/pi-ai";
import {
  createImagesGenerator,
  IMAGE_API_KEY_INVALID_MESSAGE,
  IMAGE_INSUFFICIENT_CREDIT_MESSAGE,
  IMAGE_RATE_LIMITED_MESSAGE,
  IMAGE_TIMEOUT_MESSAGE,
  IMAGE_ABORTED_MESSAGE,
  IMAGE_UNKNOWN_FAILURE_MESSAGE,
} from "../src/images";

const STUB_IMAGE_MODEL: ImagesModel<string> = {
  id: "stub-image",
  name: "Stub Image",
  api: "openrouter-images",
  provider: "stub",
  baseUrl: "https://stub.invalid/api/v1",
  input: ["text"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function stubProvider(id = "stub"): ImagesProvider {
  return {
    id,
    name: "Stub",
    auth: {},
    getModels: () => [{ ...STUB_IMAGE_MODEL, provider: id }],
  } as unknown as ImagesProvider;
}

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

/** 2xx の画像応答を組む */
function imageResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** OpenRouter のエラー形（`{"error":{"message":...}}`）で非 2xx を返す */
function errorResponse(status: number, message = `provider error ${status}`): Response {
  return imageResponse({ error: { message, code: status } }, status);
}

const baseInput = { provider: "stub", model: "stub-image", prompt: "a cafe", apiKey: "sk-image-dummy-key" };

test("カタログは provider のモデルを provider / id / name で平坦化する", () => {
  const generator = createImagesGenerator({ providers: () => [stubProvider()] });
  assert.deepEqual(generator.catalog(), [{ provider: "stub", id: "stub-image", name: "Stub Image" }]);
});

test("回帰: chat/completions ではなく画像専用 API の /images へ POST する", async () => {
  const { requests, fetchImpl } = stubFetch(() =>
    imageResponse({ data: [{ b64_json: "aGVsbG8=", media_type: "image/webp" }] }),
  );
  const generator = createImagesGenerator({ providers: () => [stubProvider()], fetchImpl });
  const result = await generator.generate(baseInput);
  assert.deepEqual(result, { ok: true, image: { mimeType: "image/webp", data: "aGVsbG8=" } });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://stub.invalid/api/v1/images");
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${baseInput.apiKey}`);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { model: "stub-image", prompt: "a cafe", n: 1 });
});

test("mimeType は data の media_type → 応答全体の media_type → png の順に落とす", async () => {
  const fromBody = stubFetch(() => imageResponse({ media_type: "image/jpeg", data: [{ b64_json: "aGVsbG8=" }] }));
  const bodyResult = await createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: fromBody.fetchImpl,
  }).generate(baseInput);
  assert.deepEqual(bodyResult, { ok: true, image: { mimeType: "image/jpeg", data: "aGVsbG8=" } });

  const missing = stubFetch(() => imageResponse({ data: [{ b64_json: "aGVsbG8=" }] }));
  const missingResult = await createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: missing.fetchImpl,
  }).generate(baseInput);
  assert.deepEqual(missingResult, { ok: true, image: { mimeType: "image/png", data: "aGVsbG8=" } });
});

test("2xx でも画像 0 件は失敗にし、応答本文をそのまま理由にしない", async () => {
  const { fetchImpl } = stubFetch(() => imageResponse({ data: [] }));
  const result = await createImagesGenerator({ providers: () => [stubProvider()], fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.equal(result.message, `${IMAGE_UNKNOWN_FAILURE_MESSAGE}（原因不明）`);
});

test("分類: 401 / 403 はキー無効、402 は残高不足、429 と 5xx は混雑", async () => {
  const cases: [number, string][] = [
    [401, IMAGE_API_KEY_INVALID_MESSAGE],
    [403, IMAGE_API_KEY_INVALID_MESSAGE],
    [402, IMAGE_INSUFFICIENT_CREDIT_MESSAGE],
    [429, IMAGE_RATE_LIMITED_MESSAGE],
    [500, IMAGE_RATE_LIMITED_MESSAGE],
    [503, IMAGE_RATE_LIMITED_MESSAGE],
  ];
  for (const [status, message] of cases) {
    const { fetchImpl } = stubFetch(() => errorResponse(status));
    const result = await createImagesGenerator({ providers: () => [stubProvider()], fetchImpl }).generate(baseInput);
    assert.equal(result.ok, false, `${status} を成功にしている`);
    if (result.ok) continue;
    assert.equal(result.message, message);
  }
});

test("分類: 未知の status はマスク済み provider メッセージ付きの原因不明にする", async () => {
  const key = "sk-image-dummy-key-0123456789";
  const { fetchImpl } = stubFetch(() => errorResponse(418, `teapot ${key}`));
  const generator = createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl,
    maskText: (text) => text.split(key).join("[REDACTED]"),
  });
  const result = await generator.generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.ok(result.message.includes("[REDACTED]"), "provider メッセージはマスクを通す");
  assert.ok(!result.message.includes(key));
});

test("分類: JSON でないエラー本文は生テキストを理由に使う", async () => {
  const { fetchImpl } = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const result = await createImagesGenerator({ providers: () => [stubProvider()], fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 5xx は混雑へ畳むため生テキストは出ない
  assert.equal(result.message, IMAGE_RATE_LIMITED_MESSAGE);

  const badRequest = stubFetch(() => new Response("<html>moderation blocked</html>", { status: 400 }));
  const rejected = await createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: badRequest.fetchImpl,
  }).generate(baseInput);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.message.includes("moderation blocked"));
});

test("分類: タイムアウトは自前タイマーで abort し、ユーザー中断と混ざらない", async () => {
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  const timedOut = createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: hangingFetch,
    timeoutMs: 20,
  });
  const result = await timedOut.generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "timeout");
  assert.equal(result.message, IMAGE_TIMEOUT_MESSAGE);

  const controller = new AbortController();
  const user = createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: hangingFetch,
    timeoutMs: 60_000,
  });
  const pending = user.generate({ ...baseInput, signal: controller.signal });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  if (aborted.ok) return;
  assert.equal(aborted.code, "aborted");
  assert.equal(aborted.message, IMAGE_ABORTED_MESSAGE);
});

test("分類: 開始前に中断済みの signal でもユーザー中断として返す", async () => {
  const controller = new AbortController();
  controller.abort();
  const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;

  const generator = createImagesGenerator({
    providers: () => [stubProvider()],
    fetchImpl: hangingFetch,
    timeoutMs: 60_000,
  });
  const result = await generator.generate({ ...baseInput, signal: controller.signal });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "aborted");
});

test("provider が見つからない / モデルがカタログに無いときは原因不明の失敗にする", async () => {
  const generator = createImagesGenerator({ providers: () => [] });
  const missingProvider = await generator.generate(baseInput);
  assert.equal(missingProvider.ok, false);
  const model = createImagesGenerator({ providers: () => [stubProvider()] });
  const missingModel = await model.generate({ ...baseInput, model: "ghost" });
  assert.equal(missingModel.ok, false);
  if (missingModel.ok) return;
  assert.equal(missingModel.code, "unknown");
});
