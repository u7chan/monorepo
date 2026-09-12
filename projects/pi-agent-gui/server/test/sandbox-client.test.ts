// fetch をスタブし、NDJSON の解釈と abort / 認証エラーの扱い、JSON 経路 (listFiles) の写像を検証する (実接続・実 LLM API なし)。

import assert from "node:assert/strict";
import test from "node:test";
import { createSandboxToolClient, SandboxRequestError } from "../src/sandbox/client";

const TOKEN = "client-test-token-0123456789";

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

interface StubCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (call: StubCall) => Response | Promise<Response>) {
  const calls: StubCall[] = [];
  const impl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: StubCall = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, impl };
}

test("forwards onUpdate, resolves with the result payload, and sends auth header", async () => {
  const { calls, impl } = stubFetch(() =>
    ndjsonResponse([
      `${JSON.stringify({ type: "start", executionId: "exec-1" })}\n`,
      `${JSON.stringify({ type: "update", payload: { content: [{ type: "text", text: "partial" }] } })}\n`,
      `${JSON.stringify({ type: "result", payload: { content: [{ type: "text", text: "final" }], details: { exitCode: 0 } } })}\n`,
    ]),
  );
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test:8080/",
    token: TOKEN,
    fetchImpl: impl,
  });
  const updates: Array<{ content: unknown }> = [];
  const result = await client.execute("bash", {
    toolCallId: "call-1",
    params: { command: "echo final" },
    onUpdate: (partial) => updates.push(partial),
  });
  assert.deepEqual(result.content, [{ type: "text", text: "final" }]);
  assert.deepEqual(result.details, { exitCode: 0 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].content, [{ type: "text", text: "partial" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/tools/bash/execute");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    toolCallId: "call-1",
    params: { command: "echo final" },
  });
});

test("rejects with the sandbox error message on error events", async () => {
  const { impl } = stubFetch(() =>
    ndjsonResponse([
      `${JSON.stringify({ type: "start", executionId: "exec-2" })}\n`,
      `${JSON.stringify({ type: "error", message: "Command aborted" })}\n`,
    ]),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  await assert.rejects(client.execute("bash", { params: {} }), /Command aborted/);
});

test("maps HTTP errors to actionable messages", async () => {
  const unauthorized = stubFetch(() => new Response("Unauthorized", { status: 401 }));
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: "wrong",
    fetchImpl: unauthorized.impl,
  });
  await assert.rejects(client.execute("bash", { params: {} }), /認証に失敗/);

  const unknown = stubFetch(() => new Response("not found", { status: 404 }));
  const client2 = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: unknown.impl });
  await assert.rejects(client2.execute("nope", { params: {} }), /ツールがありません/);

  const down = stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const client3 = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: down.impl });
  await assert.rejects(client3.execute("bash", { params: {} }), /接続できません/);
});

test("aborted signal triggers the cancel endpoint and rejects with Operation aborted", async () => {
  const { calls, impl } = stubFetch((call) => {
    // cancel 要求には即座に応答する (実サーバ相当)。signal も尊重する。
    if (call.url.endsWith("/v1/executions/exec-3/cancel")) {
      assert.ok(!call.init?.signal?.aborted, "cancel request must not be issued with an already-aborted signal");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // 本物のサーバのように、abort されるまで終わらないストリームを返し、signal abort で read() を reject させる
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "start", executionId: "exec-3" })}\n`));
        call.init?.signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(new Error("The operation was aborted"));
            } catch {
              // 既にエラー通知済み
            }
          },
          { once: true },
        );
        // close しない
      },
    });
    return new Response(stream, { status: 200 });
  });
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  const external = new AbortController();
  const pending = client.execute("bash", { params: { command: "sleep 5" }, signal: external.signal });
  // start イベントが処理されるのを待ってから abort
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  external.abort();
  await assert.rejects(pending, /Operation aborted/);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const cancelCall = calls.find((call) => call.url.endsWith("/v1/executions/exec-3/cancel"));
  assert.ok(cancelCall, `cancel endpoint should be called: ${calls.map((call) => call.url).join(", ")}`);
  assert.ok(
    !cancelCall.init?.signal?.aborted,
    "cancel request must carry its own live signal (not the already-aborted stream controller)",
  );
});

test("rejects immediately when the signal is already aborted", async () => {
  const { calls, impl } = stubFetch(() => new Response("", { status: 200 }));
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.execute("bash", { params: {}, signal: controller.signal }), /Operation aborted/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// listFiles (GET /v1/files。JSON 経路)
// ---------------------------------------------------------------------------

test("listFiles sends the encoded path and auth header, and parses the JSON listing", async () => {
  const { calls, impl } = stubFetch(
    () =>
      new Response(
        JSON.stringify({ path: "src/client", entries: [{ name: "app.ts", type: "file", size: 3 }], truncated: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  const listing = await client.listFiles("src/client");
  assert.equal(listing.path, "src/client");
  assert.deepEqual(listing.entries, [{ name: "app.ts", type: "file", size: 3 }]);
  assert.equal(listing.truncated, false);
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/files?path=src%2Fclient");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  // path が空でも query は落とさない (サンドボックス側の既定は root)
  await client.listFiles("");
  assert.equal(calls[1].url, "http://sandbox.test:8080/v1/files?path=");
});

test("listFiles relays sandbox 4xx messages and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(() =>
      new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ).impl;

  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(400, "Path outside the workspace: /etc"),
  });
  await assert.rejects(client.listFiles("../../etc"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 400);
    assert.equal(error.message, "Path outside the workspace: /etc");
    return true;
  });

  const missing = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(404, "Path not found: /workspace/nope"),
  });
  await assert.rejects(missing.listFiles("nope"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 404);
    return true;
  });

  const unauthorized = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: "wrong",
    fetchImpl: sandboxError(401, "Unauthorized"),
  });
  await assert.rejects(unauthorized.listFiles("."), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /認証に失敗/);
    return true;
  });

  const broken = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(500, "boom"),
  });
  await assert.rejects(broken.listFiles("."), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 500\): boom/);
    return true;
  });

  const down = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: (() => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  await assert.rejects(down.listFiles("."), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /接続できません/);
    return true;
  });
});
