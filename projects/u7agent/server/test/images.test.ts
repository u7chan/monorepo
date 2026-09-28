// 画像生成の薄い関数（カタログ / 失敗分類 / timeout と中断の区別）。実 API は呼ばず stub provider で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantImages, ImagesContext, ImagesModel, ImagesOptions, ImagesProvider } from "@earendil-works/pi-ai";
import {
  createImagesGenerator,
  IMAGE_API_KEY_INVALID_MESSAGE,
  IMAGE_INSUFFICIENT_CREDIT_MESSAGE,
  IMAGE_RATE_LIMITED_MESSAGE,
  IMAGE_TIMEOUT_MESSAGE,
  IMAGE_ABORTED_MESSAGE,
} from "../src/images";

const STUB_IMAGE_MODEL: ImagesModel<string> = {
  id: "stub-image",
  name: "Stub Image",
  api: "openrouter-images",
  provider: "stub",
  baseUrl: "https://stub.invalid",
  input: ["text"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function stubProvider(run: (options?: ImagesOptions) => Promise<AssistantImages>, id = "stub"): ImagesProvider {
  return {
    id,
    name: "Stub",
    auth: {},
    getModels: () => [{ ...STUB_IMAGE_MODEL, provider: id }],
    generateImages: (_model: ImagesModel<string>, _context: ImagesContext, options?: ImagesOptions) => run(options),
  } as unknown as ImagesProvider;
}

function assistantImages(overrides: Partial<AssistantImages> = {}): AssistantImages {
  return {
    api: "openrouter-images",
    provider: "stub",
    model: "stub-image",
    output: [],
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/** provider が fetch を 1 回呼んでから失敗を返す形。非 2xx の status は包んだ fetch が記録する */
function failingWithStatus(status: number, message = `provider error ${status}`) {
  return stubProvider(async (options) => {
    const response = await options?.fetch?.("https://stub.invalid/chat/completions", { method: "POST" });
    await response?.text();
    return assistantImages({ stopReason: "error", errorMessage: message });
  });
}

const baseInput = { provider: "stub", model: "stub-image", prompt: "a cafe", apiKey: "sk-image-dummy-key" };

test("カタログは provider のモデルを provider / id / name で平坦化する", () => {
  const generator = createImagesGenerator({ providers: () => [stubProvider(async () => assistantImages())] });
  assert.deepEqual(generator.catalog(), [{ provider: "stub", id: "stub-image", name: "Stub Image" }]);
});

test("成功: 最初の画像を mimeType / base64 で返し、text しか無い出力は失敗にする", async () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  const success = createImagesGenerator({
    providers: () => [stubProvider(async () => assistantImages({ output: [image] }))],
  });
  assert.deepEqual(await success.generate(baseInput), { ok: true, image: { mimeType: "image/png", data: "aGVsbG8=" } });

  const textOnly = createImagesGenerator({
    providers: () => [
      stubProvider(async () =>
        assistantImages({ output: [{ type: "text", text: "I can not draw that" }], stopReason: "stop" }),
      ),
    ],
  });
  const failed = await textOnly.generate(baseInput);
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.code, "unknown", "画像 0 件は成功にしない");
  assert.ok(failed.message.includes("I can not draw that"), "provider メッセージを添える");
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
    const generator = createImagesGenerator({
      providers: () => [failingWithStatus(status)],
      fetchImpl: async () => new Response("{}", { status }),
    });
    const result = await generator.generate(baseInput);
    assert.equal(result.ok, false, `${status} を成功にしている`);
    if (result.ok) continue;
    assert.equal(result.message, message);
  }
});

test("分類: 非 2xx でも未知の status はマスク済み provider メッセージ付きの原因不明にする", async () => {
  const key = "sk-image-dummy-key-0123456789";
  const generator = createImagesGenerator({
    providers: () => [failingWithStatus(418, `teapot ${key}`)],
    fetchImpl: async () => new Response("{}", { status: 418 }),
    maskText: (text) => text.split(key).join("[REDACTED]"),
  });
  const result = await generator.generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unknown");
  assert.ok(result.message.includes("[REDACTED]"), "provider メッセージはマスクを通す");
  assert.ok(!result.message.includes(key));
});

test("分類: タイムアウトは自前タイマーで abort し、ユーザー中断と混ざらない", async () => {
  const hanging = stubProvider(
    (options) =>
      new Promise<AssistantImages>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(assistantImages({ stopReason: "aborted" })), {
          once: true,
        });
      }),
  );
  const timedOut = createImagesGenerator({ providers: () => [hanging], timeoutMs: 20 });
  const result = await timedOut.generate(baseInput);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "timeout");
  assert.equal(result.message, IMAGE_TIMEOUT_MESSAGE);

  const controller = new AbortController();
  const user = createImagesGenerator({ providers: () => [hanging], timeoutMs: 60_000 });
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
  const generator = createImagesGenerator({
    providers: () => [
      stubProvider(
        (options) =>
          new Promise<AssistantImages>((resolve) => {
            if (options?.signal?.aborted) resolve(assistantImages({ stopReason: "aborted" }));
            else options?.signal?.addEventListener("abort", () => resolve(assistantImages({ stopReason: "aborted" })));
          }),
      ),
    ],
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
  const model = createImagesGenerator({ providers: () => [stubProvider(async () => assistantImages())] });
  const missingModel = await model.generate({ ...baseInput, model: "ghost" });
  assert.equal(missingModel.ok, false);
  if (missingModel.ok) return;
  assert.equal(missingModel.code, "unknown");
});
