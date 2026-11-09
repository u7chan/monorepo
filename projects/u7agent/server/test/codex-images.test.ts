// Codex（ChatGPT の画像生成ツール）のアダプタ。実トークンも実 API も使わず、fetch stub と
// モック SSE だけで、要求の形・画像の取り出し・失敗の分類（401 / 429 / timeout / 中断）を固定する。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CODEX_ABORTED_MESSAGE,
  CODEX_AUTH_INVALID_MESSAGE,
  CODEX_IMAGE_TOO_LARGE_MESSAGE,
  CODEX_NO_IMAGE_MESSAGE,
  CODEX_PROVIDER_ID,
  CODEX_TIMEOUT_MESSAGE,
  CODEX_USAGE_LIMIT_MESSAGE,
  codexAccountIdOf,
  codexAuthOf,
  codexAuthStatusOf,
  createCodexImagesGenerator,
} from "../src/codex-images";
import type { CodexAuth } from "../src/images";

const AUTH: CodexAuth = { access: "dummy-access-token", accountId: "dummy-account" };

/** SDK の chat モデルと同じ形の最小のルーティングモデル。baseUrl だけが送信先を決める */
function routingModel(baseUrl = "https://codex.invalid/backend-api"): Model<Api> {
  return {
    provider: CODEX_PROVIDER_ID,
    id: "stub-routing-model",
    name: "Stub",
    api: "openai-codex-responses",
    baseUrl,
  } as unknown as Model<Api>;
}

interface Request_ {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(respond: () => Response | Promise<Response>): {
  requests: Request_[];
  fetchImpl: typeof fetch;
} {
  const requests: Request_[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return await respond();
  }) as typeof fetch;
  return { requests, fetchImpl };
}

function sseResponse(events: readonly unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const IMAGE_ITEM = {
  type: "image_generation_call",
  status: "completed",
  result: Buffer.from("hello").toString("base64"),
  output_format: "png",
  size: "1254x1254",
};

test("画像は output_item の image_generation_call から取り出し、ルーティングモデルを画像モデルにしない", async () => {
  const { requests, fetchImpl } = stubFetch(() =>
    sseResponse([
      { type: "response.created" },
      { type: "response.output_item.done", item: IMAGE_ITEM },
      { type: "response.completed", response: { output: [IMAGE_ITEM] } },
    ]),
  );
  const generator = createCodexImagesGenerator({ models: () => [routingModel()], fetchImpl });
  const result = await generator.generate({ prompt: "a cafe", auth: AUTH });
  assert.deepEqual(result, {
    ok: true,
    image: { mimeType: "image/png", data: Buffer.from("hello").toString("base64") },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://codex.invalid/backend-api/codex/responses");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${AUTH.access}`);
  assert.equal(headers.get("chatgpt-account-id"), AUTH.accountId);
  assert.equal(headers.get("accept"), "text/event-stream");
  const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "stub-routing-model");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: "image_generation" }]);
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "a cafe" }] }]);
});

test("最終応答の output にしか画像が無くても取り出し、形式は output_format から決める", async () => {
  const webp = { ...IMAGE_ITEM, output_format: "webp" };
  const { fetchImpl } = stubFetch(() => sseResponse([{ type: "response.completed", response: { output: [webp] } }]));
  const result = await createCodexImagesGenerator({ models: () => [routingModel()], fetchImpl }).generate({
    prompt: "a cafe",
    auth: AUTH,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.image.mimeType : "", "image/webp");
});

test("content-type を宣言しない応答でも SSE として読む（実測で null だった）", async () => {
  const { fetchImpl } = stubFetch(
    () => new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: IMAGE_ITEM })}\n\n`),
  );
  const result = await createCodexImagesGenerator({ models: () => [routingModel()], fetchImpl }).generate({
    prompt: "a cafe",
    auth: AUTH,
  });
  assert.equal(result.ok, true);
});

test("401 / 429 / 5xx は固定文言へ分類し、provider の本文を返さない", async () => {
  for (const [status, expected] of [
    [401, CODEX_AUTH_INVALID_MESSAGE],
    [403, CODEX_AUTH_INVALID_MESSAGE],
    [429, CODEX_USAGE_LIMIT_MESSAGE],
    [503, CODEX_USAGE_LIMIT_MESSAGE],
  ] as const) {
    const { fetchImpl } = stubFetch(() => new Response("secret-ish provider text", { status }));
    const result = await createCodexImagesGenerator({ models: () => [routingModel()], fetchImpl }).generate({
      prompt: "a cafe",
      auth: AUTH,
    });
    assert.equal(result.ok, false, String(status));
    assert.equal(result.ok ? "" : result.message, expected, String(status));
    assert.equal(JSON.stringify(result).includes("secret-ish"), false);
  }
});

test("期限はタイムアウト、ユーザー中断は中断として返し、利用枠の消費可能性を文言に含める", async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;

  const timedOut = await createCodexImagesGenerator({
    models: () => [routingModel()],
    fetchImpl: hanging,
    timeoutMs: 5,
  }).generate({ prompt: "a cafe", auth: AUTH });
  assert.deepEqual(timedOut, { ok: false, code: "timeout", message: CODEX_TIMEOUT_MESSAGE });

  const controller = new AbortController();
  const pending = createCodexImagesGenerator({ models: () => [routingModel()], fetchImpl: hanging }).generate({
    prompt: "a cafe",
    auth: AUTH,
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: "aborted", message: CODEX_ABORTED_MESSAGE });
});

test("画像が返らない 200 と、上限を超える画像は固定文言で止める", async () => {
  const empty = stubFetch(() => sseResponse([{ type: "response.completed", response: { output: [] } }]));
  const noImage = await createCodexImagesGenerator({
    models: () => [routingModel()],
    fetchImpl: empty.fetchImpl,
  }).generate({ prompt: "a cafe", auth: AUTH });
  assert.deepEqual(noImage, { ok: false, code: "unknown", message: CODEX_NO_IMAGE_MESSAGE });

  const huge = {
    ...IMAGE_ITEM,
    // 32 MiB を超える base64。復号せず長さで判定する
    result: "A".repeat(Math.ceil((33 * 1024 * 1024 * 4) / 3)),
  };
  const oversized = stubFetch(() => sseResponse([{ type: "response.output_item.done", item: huge }]));
  const tooLarge = await createCodexImagesGenerator({
    models: () => [routingModel()],
    fetchImpl: oversized.fetchImpl,
  }).generate({ prompt: "a cafe", auth: AUTH });
  assert.deepEqual(tooLarge, { ok: false, code: "unknown", message: CODEX_IMAGE_TOO_LARGE_MESSAGE });
});

test("ルーティングモデルが 1 つも無いときは provider を呼ばない", async () => {
  const { requests, fetchImpl } = stubFetch(() => sseResponse([]));
  const result = await createCodexImagesGenerator({ models: () => [], fetchImpl }).generate({
    prompt: "a cafe",
    auth: AUTH,
  });
  assert.equal(result.ok, false);
  assert.equal(requests.length, 0);
});

test("auth.json の保存値だけで認証状態を判定し、値は返さない", () => {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-codex-auth-"));
  try {
    const authPath = join(dir, "auth.json");
    assert.deepEqual(codexAuthStatusOf(authPath), { state: "missing", kind: null });

    writeFileSync(
      authPath,
      JSON.stringify({
        [CODEX_PROVIDER_ID]: { type: "oauth", access: "a", refresh: "r", expires: 2_000 },
      }),
    );
    assert.deepEqual(codexAuthStatusOf(authPath, 1_000), { state: "configured", kind: "oauth" });
    assert.deepEqual(codexAuthStatusOf(authPath, 3_000), { state: "expired", kind: "oauth" });
    assert.equal(JSON.stringify(codexAuthStatusOf(authPath, 1_000)).includes('"a"'), false);

    writeFileSync(authPath, "{ broken");
    assert.deepEqual(codexAuthStatusOf(authPath), { state: "missing", kind: null }, "壊れた保存値で落とさない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("アクセストークンの JWT claim から account id を取り、読めないトークンは使わない", () => {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
  ).toString("base64url");
  const token = `header.${payload}.signature`;
  assert.equal(codexAccountIdOf(token), "account-1");
  assert.deepEqual(codexAuthOf(token), { access: token, accountId: "account-1" });
  assert.equal(codexAccountIdOf("not-a-jwt"), undefined);
  assert.equal(codexAuthOf("not-a-jwt"), undefined);
  assert.equal(codexAuthOf(undefined), undefined);
});
