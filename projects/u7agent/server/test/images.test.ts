// 画像生成の薄い関数（カタログ / 画像専用 API への要求 / 失敗分類 / timeout と中断の区別）。
// 実 API は呼ばず stub provider と差し替えた fetch で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createImagesGenerator,
  IMAGE_API_KEY_INVALID_MESSAGE,
  IMAGE_INSUFFICIENT_CREDIT_MESSAGE,
  IMAGE_RATE_LIMITED_MESSAGE,
  IMAGE_TIMEOUT_MESSAGE,
  IMAGE_ABORTED_MESSAGE,
  IMAGE_UNKNOWN_FAILURE_MESSAGE,
  imageModelCatalog,
} from "../src/images";

const STUB_IMAGE_MODEL: ImageModel<ImageApi> = {
  id: "stub-image",
  name: "Stub Image",
  type: "image",
  api: "openrouter-images",
  provider: "stub",
  baseUrl: "https://stub.invalid/api/v1",
  input: ["text"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** テスト用の SDK 同梱カタログの代わり。provider ごとの URL / ヘッダのひな形として使う */
function stubModels(id = "stub"): ImageModel<ImageApi>[] {
  return [{ ...STUB_IMAGE_MODEL, provider: id }];
}

/** ひな形として借りる送信先（baseUrl とヘッダ）。ヘッダのキー順に依存させない */
function destinationOf(model: ImageModel<ImageApi>): string {
  const headers = Object.entries(model.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `${model.baseUrl} ${JSON.stringify(headers)}`;
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
  const generator = createImagesGenerator({ models: () => stubModels() });
  assert.deepEqual(generator.catalog(), [{ provider: "stub", id: "stub-image", name: "Stub Image" }]);
});

test("SDK 同梱カタログはルーター用メタモデルを落とす", () => {
  const catalog = imageModelCatalog();
  assert.ok(catalog.length > 0, "カタログが空");
  // /images に存在しない openrouter/auto* は生成が必ず 404 になるので、選択肢へ出さない
  assert.deepEqual(
    catalog.filter((entry) => entry.id.startsWith("openrouter/")),
    [],
  );
  assert.ok(catalog.some((entry) => entry.id === "openai/gpt-image-2"));
});

test("SDK 同梱カタログの openrouter は全モデルが同じ baseUrl / ヘッダを使う（崩れたら server/src/images.ts のひな形の流用を置き換える）", () => {
  const models = builtinModels()
    .getModelsOfType("image")
    .filter((model) => model.provider === "openrouter");
  assert.ok(models.length > 0, "SDK 同梱カタログに openrouter の画像モデルが無い");
  const destinations = new Set(models.map((model) => destinationOf(model)));
  assert.equal(destinations.size, 1, `provider 内で送信先 / ヘッダが揃っていない: ${[...destinations].join(" / ")}`);
});

test("回帰: chat/completions ではなく画像専用 API の /images へ POST する", async () => {
  const { requests, fetchImpl } = stubFetch(() =>
    imageResponse({ data: [{ b64_json: "aGVsbG8=", media_type: "image/webp" }] }),
  );
  const generator = createImagesGenerator({ models: () => stubModels(), fetchImpl });
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
    models: () => stubModels(),
    fetchImpl: fromBody.fetchImpl,
  }).generate(baseInput);
  assert.deepEqual(bodyResult, { ok: true, image: { mimeType: "image/jpeg", data: "aGVsbG8=" } });

  const missing = stubFetch(() => imageResponse({ data: [{ b64_json: "aGVsbG8=" }] }));
  const missingResult = await createImagesGenerator({
    models: () => stubModels(),
    fetchImpl: missing.fetchImpl,
  }).generate(baseInput);
  assert.deepEqual(missingResult, { ok: true, image: { mimeType: "image/png", data: "aGVsbG8=" } });
});

test("2xx でも画像 0 件は失敗にし、生の応答本文は理由にしない", async () => {
  const { fetchImpl } = stubFetch(() => imageResponse({ data: [] }));
  const result = await createImagesGenerator({ models: () => stubModels(), fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.equal(result.message, `${IMAGE_UNKNOWN_FAILURE_MESSAGE}（原因不明）`);

  // 構造化された error.message は 2xx でも添える（docs/image-generation.md の失敗分類）
  const structured = stubFetch(() => imageResponse({ data: [], error: { message: "moderation blocked" } }));
  const rejected = await createImagesGenerator({
    models: () => stubModels(),
    fetchImpl: structured.fetchImpl,
  }).generate(baseInput);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.message.includes("moderation blocked"));
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
    const result = await createImagesGenerator({ models: () => stubModels(), fetchImpl }).generate(baseInput);
    assert.equal(result.ok, false, `${status} を成功にしている`);
    if (result.ok) continue;
    assert.equal(result.message, message);
  }
});

test("分類: 未知の status はマスク済み provider メッセージ付きの原因不明にする", async () => {
  const key = "sk-image-dummy-key-0123456789";
  const { fetchImpl } = stubFetch(() => errorResponse(418, `teapot ${key}`));
  const generator = createImagesGenerator({
    models: () => stubModels(),
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
  const result = await createImagesGenerator({ models: () => stubModels(), fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 5xx は混雑へ畳むため生テキストは出ない
  assert.equal(result.message, IMAGE_RATE_LIMITED_MESSAGE);

  const badRequest = stubFetch(() => new Response("<html>moderation blocked</html>", { status: 400 }));
  const rejected = await createImagesGenerator({
    models: () => stubModels(),
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
    models: () => stubModels(),
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
    models: () => stubModels(),
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
    models: () => stubModels(),
    fetchImpl: hangingFetch,
    timeoutMs: 60_000,
  });
  const result = await generator.generate({ ...baseInput, signal: controller.signal });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "aborted");
});

test("provider が見つからないときだけローカルで失敗にする", async () => {
  const generator = createImagesGenerator({ models: () => [] });
  const missingProvider = await generator.generate(baseInput);
  assert.equal(missingProvider.ok, false);
  if (missingProvider.ok) return;
  assert.equal(missingProvider.code, "unknown");
  assert.match(missingProvider.message, /画像モデルが見つかりません/);
});

test("SDK カタログに無い id (live のみのモデル) も provider の URL で送る", async () => {
  const { requests, fetchImpl } = stubFetch(() => imageResponse({ data: [{ b64_json: "aGVsbG8=" }] }));
  const generator = createImagesGenerator({ models: () => stubModels(), fetchImpl });
  const result = await generator.generate({ ...baseInput, model: "inclusionai/ming-image-0.1-design-layer" });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://stub.invalid/api/v1/images", "provider の baseUrl を使う");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    model: "inclusionai/ming-image-0.1-design-layer",
    prompt: "a cafe",
    n: 1,
  });
});

// --- 参照画像（input_references）。指定時だけ送り、入力の base64 は結果へ出さない ---

test("参照ありは /images へ input_references を指定順で送り、chat/completions へ戻らない", async () => {
  const { requests, fetchImpl } = stubFetch(() =>
    imageResponse({ data: [{ b64_json: "aGVsbG8=", media_type: "image/png" }] }),
  );
  const generator = createImagesGenerator({ models: () => stubModels(), fetchImpl });
  const inputReferences = ["data:image/png;base64,iVBORw0KGgo=", "data:image/webp;base64,UklGRg=="];
  const result = await generator.generate({ ...baseInput, inputReferences });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://stub.invalid/api/v1/images");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "stub-image",
    prompt: "a cafe",
    n: 1,
    input_references: inputReferences.map((url) => ({ type: "image_url", image_url: { url } })),
  });
});

test("input_references が空配列なら従来の送信 JSON のまま", async () => {
  const { requests, fetchImpl } = stubFetch(() => imageResponse({ data: [{ b64_json: "aGVsbG8=" }] }));
  const generator = createImagesGenerator({ models: () => stubModels(), fetchImpl });
  await generator.generate({ ...baseInput, inputReferences: [] });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { model: "stub-image", prompt: "a cafe", n: 1 });
});

test("参照ありでも失敗分類・timeout・中断の扱いは変わらない", async () => {
  // 401 はキー無効のまま
  const invalidKey = stubFetch(() => errorResponse(401));
  const rejected = await createImagesGenerator({
    models: () => stubModels(),
    fetchImpl: invalidKey.fetchImpl,
  }).generate({ ...baseInput, inputReferences: ["data:image/png;base64,iVBORw0KGgo="] });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.code, "invalid_key");

  // ユーザー中断は aborted として分類する
  const controller = new AbortController();
  const hanging = stubFetch(
    (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const aborted = createImagesGenerator({ models: () => stubModels(), fetchImpl: hanging.fetchImpl }).generate({
    ...baseInput,
    inputReferences: ["data:image/png;base64,iVBORw0KGgo="],
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());
  const abortedResult = await aborted;
  assert.equal(abortedResult.ok, false);
  if (abortedResult.ok) return;
  assert.equal(abortedResult.code, "aborted");
});

test("参照画像がある失敗では provider の自由文を結果へ載せず、分類と固定文言だけを返す", async () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const dataUrl = `data:image/png;base64,${base64}`;
  const requestBody = {
    model: baseInput.model,
    prompt: baseInput.prompt,
    n: 1,
    input_references: [{ type: "image_url", image_url: { url: dataUrl } }],
  };
  const escapedOnce = JSON.stringify(requestBody).replaceAll("/", "\\/");
  // エスケープ済みの要求 JSON をもう一度 JSON 文字列化した反射（表記の列挙では追えない形）
  const escapedTwice = JSON.stringify(escapedOnce);
  const wrapped = `invalid image: data:image/png;base64,${(base64.match(/.{1,20}/g) ?? []).join("\n")}`;
  const reflections: [string, string][] = [
    ["plain", `invalid image: ${dataUrl} (raw ${base64})`],
    ["escaped once", `invalid image: ${escapedOnce}`],
    ["escaped twice", `invalid image: ${escapedTwice}`],
    ["wrapped base64", wrapped],
  ];
  for (const [label, reflection] of reflections) {
    const { fetchImpl } = stubFetch(() => errorResponse(400, reflection));
    const result = await createImagesGenerator({ models: () => stubModels(), fetchImpl }).generate({
      ...baseInput,
      inputReferences: [dataUrl],
    });
    assert.equal(result.ok, false, label);
    if (result.ok) continue;
    // 表記の列挙で追い切れない反射に備え、入力がある失敗では本文を返さない
    assert.equal(result.message, `${IMAGE_UNKNOWN_FAILURE_MESSAGE}（原因不明）`, label);
    for (const needle of [base64, base64.slice(0, 32), "data:image", escapedOnce.slice(0, 24)]) {
      assert.ok(!result.message.includes(needle), `${label}: 入力画像のデータが結果へ出ている`);
    }
  }
});

test("参照画像が無い失敗では従来どおり provider の理由（マスク済み）を添える", async () => {
  const { fetchImpl } = stubFetch(() => errorResponse(400, "moderation blocked"));
  const result = await createImagesGenerator({ models: () => stubModels(), fetchImpl }).generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /moderation blocked/);
});
