// カスタムプロバイダーの `/models` probe。classify と ID の濾し込みを、fake fetch と実 HTTP サーバーで固定する。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  CUSTOM_PROVIDER_PROBE_BODY_MAX_BYTES,
  CUSTOM_PROVIDER_PROBE_MODEL_MAX,
  CUSTOM_PROVIDER_PROBE_MESSAGES,
  probeCustomProviderModels,
} from "../src/custom-provider-probe";

const KEY = "sk-custom-dummy-key-0123456789";
const BASE = "http://192.0.2.10:11434/v1";

function fakeFetch(run: (input: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init: init ?? {} });
    return run(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test("2xx の data[].id だけを重複除去・昇順にして返し、Bearer と /models を送る", async () => {
  const fake = fakeFetch(() =>
    Response.json({
      object: "list",
      data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: " bad id " }, { id: 3 }, {}, "x", null],
    }),
  );
  const result = await probeCustomProviderModels(
    { baseUrl: `${BASE}/`, apiKey: KEY },
    { fetchImpl: fake.fetchImpl, now: () => 123 },
  );
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.url, `${BASE}/models`);
  assert.equal(fake.requests[0]!.init.method, "GET");
  assert.deepEqual((fake.requests[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.equal(fake.requests[0]!.init.redirect, "manual");
  assert.deepEqual(result, {
    checkedAt: 123,
    baseUrl: BASE,
    failure: null,
    httpStatus: null,
    models: [{ id: "a" }, { id: "b" }],
    truncated: false,
    message: null,
  });
});

test("data: [] は成功で、モデル 0 件として返す", async () => {
  const fake = fakeFetch(() => Response.json({ data: [] }));
  const result = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.failure, null);
  assert.deepEqual(result.models, []);
  assert.equal(result.truncated, false);
});

test("モデル数は上限で打ち切り、truncated を立てる", async () => {
  const ids = Array.from({ length: CUSTOM_PROVIDER_PROBE_MODEL_MAX + 5 }, (_, index) => ({
    id: `m${String(index).padStart(4, "0")}`,
  }));
  const fake = fakeFetch(() => Response.json({ data: ids }));
  const result = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.models.length, CUSTOM_PROVIDER_PROBE_MODEL_MAX);
  assert.equal(result.models[0]!.id, "m0000");
  assert.equal(result.truncated, true);
});

test("HTTP の失敗は status 付きの分類にし、分類ごとの固定文言を返す", async () => {
  const cases: { status: number; failure: keyof typeof CUSTOM_PROVIDER_PROBE_MESSAGES; httpStatus: number | null }[] = [
    { status: 401, failure: "unauthorized", httpStatus: 401 },
    { status: 403, failure: "unauthorized", httpStatus: 403 },
    { status: 404, failure: "not_found", httpStatus: 404 },
    { status: 500, failure: "http_error", httpStatus: 500 },
    { status: 302, failure: "redirected", httpStatus: null },
  ];
  for (const entry of cases) {
    const fake = fakeFetch(() => new Response(null, { status: entry.status }));
    const result = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.failure, entry.failure, `status ${entry.status}`);
    assert.equal(result.httpStatus, entry.httpStatus, `status ${entry.status}`);
    assert.equal(result.message, CUSTOM_PROVIDER_PROBE_MESSAGES[entry.failure]);
    assert.deepEqual(result.models, []);
  }
});

test("HTTP エラーでも応答本文を破棄し、接続を開いたままにしない", async () => {
  let closed = false;
  const server = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    // 本文を読み切らないと接続が残るよう、end せずにチャンクだけ送る
    response.write('{"error":"no"}');
    response.on("close", () => {
      closed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await probeCustomProviderModels(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY },
      { timeoutMs: 500 },
    );
    assert.equal(result.failure, "unauthorized");
    for (let index = 0; index < 40 && !closed; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(closed, true, "エラー応答の本文を破棄して接続を閉じる");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("3xx は実 fetch でも追わず、転送先へ要求を出さない", async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/v1/models") {
      response.writeHead(302, { location: "/v2/models" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "redirect-target" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await probeCustomProviderModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY });
    assert.equal(result.failure, "redirected");
    assert.deepEqual(hits, ["/v1/models"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("JSON でない・data が配列でない応答は invalid_response", async () => {
  for (const body of ["not json", JSON.stringify({ models: [{ id: "a" }] }), "", JSON.stringify([{ id: "a" }])]) {
    const fake = fakeFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const result = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: fake.fetchImpl });
    assert.equal(result.failure, "invalid_response", `body ${JSON.stringify(body)}`);
    assert.equal(result.httpStatus, null);
  }
});

test("本文が上限を超えたら invalid_response にし、残りを読まない", async () => {
  const chunk = new TextEncoder().encode("x".repeat(CUSTOM_PROVIDER_PROBE_BODY_MAX_BYTES + 1));
  const fake = fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
  );
  const result = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: fake.fetchImpl });
  assert.equal(result.failure, "invalid_response");
});

test("期限は timeout、接続できないときは unreachable に分ける", async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const timedOut = await probeCustomProviderModels(
    { baseUrl: BASE, apiKey: KEY },
    { fetchImpl: hanging, timeoutMs: 5 },
  );
  assert.equal(timedOut.failure, "timeout");

  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const failed = await probeCustomProviderModels({ baseUrl: BASE, apiKey: KEY }, { fetchImpl: unreachable });
  assert.equal(failed.failure, "unreachable");
});

test("baseUrl の形式は 400 として投げる", async () => {
  await assert.rejects(probeCustomProviderModels({ baseUrl: "file:///etc/passwd", apiKey: KEY }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    return true;
  });
});
