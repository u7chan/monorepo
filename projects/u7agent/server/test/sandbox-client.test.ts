// fetch をスタブし、NDJSON の解釈と abort / 認証エラーの扱い、JSON 経路 (listFiles) の写像を検証する (実接続・実 LLM API なし)。

import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_INPUT_MAX_BYTES } from "../src/image-format";
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
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(init.body)), {
    toolCallId: "call-1",
    params: { command: "echo final" },
  });
});

test("forwards the session cwd to the sandbox and omits it for the workspace root", async () => {
  const { calls, impl } = stubFetch(() =>
    ndjsonResponse([
      `${JSON.stringify({ type: "start", executionId: "exec-1" })}\n`,
      `${JSON.stringify({ type: "result", payload: { content: [] } })}\n`,
    ]),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });

  await client.execute("ls", { params: {}, cwd: "nested/proj" });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { params: {}, cwd: "nested/proj" });

  // 未所属セッションは root なのでキーごと省略する
  await client.execute("ls", { params: {} });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { params: {} });
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

test("write / edit のポリシー拒否は 200 の error イベントとしてモデル向け文言のまま reject する", async () => {
  const message =
    "Cannot write or edit outside the session working directory: /workspace/cafe.html. " +
    "Allowed locations are /workspace/.u7agent/sessions/aaaa111111 (working directory) and /workspace/.agents/skills (common skills). " +
    "Retry with a path relative to the working directory (for example, `cafe.html`).";
  const { calls, impl } = stubFetch(() =>
    ndjsonResponse([
      `${JSON.stringify({ type: "start", executionId: "exec-3" })}\n`,
      `${JSON.stringify({ type: "error", message })}\n`,
    ]),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  await assert.rejects(
    client.execute("write", {
      params: { path: "/workspace/cafe.html", content: "x" },
      cwd: ".u7agent/sessions/aaaa111111",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, message, "HTTP 400 の経路を通すと文言が JSON ラッパーに包まれる");
      assert.doesNotMatch(error.message, /\{"error"/);
      assert.doesNotMatch(error.message, /HTTP 400/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
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
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  // path が空でも query は落とさない (サンドボックス側の既定は root)
  await client.listFiles("");
  assert.equal(calls[1].url, "http://sandbox.test:8080/v1/files?path=");
});

test("listSkills は 200 でも本文が契約外なら 502 にする (切断・プロキシの HTML など)", async () => {
  const { calls, impl } = stubFetch(
    () =>
      new Response("<!doctype html><title>502 Bad Gateway</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  await assert.rejects(client.listSkills(".agents/skills"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError, "サンドボックス側の問題として扱う");
    assert.equal(error.status, 502);
    assert.match(error.message, /スキル一覧の応答が不正です/);
    return true;
  });
  assert.equal(calls[0].url, "http://sandbox.test/v1/skills?dir=.agents%2Fskills");
});

test("listFiles relays sandbox 4xx messages and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(
      () =>
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

// ---------------------------------------------------------------------------
// createDir (POST /v1/dirs。JSON 経路)
// ---------------------------------------------------------------------------

test("createDir posts the path and parses the created directory", async () => {
  const { calls, impl } = stubFetch(
    () =>
      new Response(JSON.stringify({ path: "a/b" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  const result = await client.createDir("a/b");
  assert.deepEqual(result, { path: "a/b" });
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/dirs");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(init.body)), { path: "a/b" });
});

test("createDir relays sandbox 4xx messages and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(
      () =>
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
  await assert.rejects(client.createDir("../etc"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 400);
    assert.equal(error.message, "Path outside the workspace: /etc");
    return true;
  });

  const broken = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(503, "boom"),
  });
  await assert.rejects(broken.createDir("a"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 503\): boom/);
    return true;
  });

  const unauthorized = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: "wrong",
    fetchImpl: sandboxError(401, "Unauthorized"),
  });
  await assert.rejects(unauthorized.createDir("a"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /認証に失敗/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// rawFile (GET /v1/files/raw。ストリーム中継)
// ---------------------------------------------------------------------------

test("rawFile relays the status and range headers and sends Range only when it is given", async () => {
  const { calls, impl } = stubFetch((call) => {
    const range = (call.init?.headers as Record<string, string> | undefined)?.Range;
    return new Response(new Uint8Array([2, 3]), {
      status: range === undefined ? 200 : 206,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": "2",
        ...(range === undefined ? {} : { "Content-Range": "bytes 1-2/4" }),
        "Accept-Ranges": "bytes",
      },
    });
  });
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  const partial = await client.rawFile("uploads/bgm.mp3", { range: "bytes=1-2" });
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/files/raw?path=uploads%2Fbgm.mp3");
  const partialInit = calls[0].init;
  assert.ok(partialInit, "fetch が init 付きで呼ばれる");
  assert.equal((partialInit.headers as Record<string, string>).Range, "bytes=1-2");
  assert.equal((partialInit.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.equal(partial.status, 206);
  assert.equal(partial.contentType, "audio/mpeg");
  assert.equal(partial.contentLength, 2);
  assert.equal(partial.contentRange, "bytes 1-2/4");
  assert.equal(partial.acceptRanges, "bytes");
  assert.deepEqual(new Uint8Array(await new Response(partial.body).arrayBuffer()), new Uint8Array([2, 3]));

  const whole = await client.rawFile("uploads/bgm.mp3");
  assert.equal(whole.status, 200);
  const wholeInit = calls[1].init;
  assert.ok(wholeInit, "fetch が init 付きで呼ばれる");
  assert.equal((wholeInit.headers as Record<string, string>).Range, undefined, "Range が無いのに送っている");
});

test("rawFile keeps 416 as a response and relays other 4xx messages", async () => {
  // 416 は Content-Range (全体の長さ) を中継するため例外にしない
  const notSatisfiable = stubFetch(
    () =>
      new Response(JSON.stringify({ error: "Range is not satisfiable" }), {
        status: 416,
        headers: { "Content-Type": "application/json", "Content-Range": "bytes */4" },
      }),
  ).impl;
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: notSatisfiable });
  const response = await client.rawFile("uploads/bgm.mp3", { range: "bytes=9-" });
  assert.equal(response.status, 416);
  assert.equal(response.contentRange, "bytes */4");
  assert.deepEqual(await new Response(response.body).json(), { error: "Range is not satisfiable" });

  const missing = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(
      () =>
        new Response(JSON.stringify({ error: "Path not found: x" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ).impl,
  });
  await assert.rejects(missing.rawFile("nope.png"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.message, "Path not found: x");
    return true;
  });
});

// ---------------------------------------------------------------------------
// readImageInput (GET /v1/files/image-input。許可範囲付きの入力読取)
// ---------------------------------------------------------------------------

test("readImageInput sends path and every scope, and returns the received bytes", async () => {
  const { calls, impl } = stubFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Length": "3" } }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  const controller = new AbortController();
  const bytes = await client.readImageInput(
    "generated/a.png",
    ["projects/app", ".u7agent/uploads/0123456789"],
    controller.signal,
  );
  assert.deepEqual(new Uint8Array(bytes), new Uint8Array([1, 2, 3]));
  assert.equal(
    calls[0].url,
    "http://sandbox.test/v1/files/image-input?path=generated%2Fa.png&scope=projects%2Fapp&scope=.u7agent%2Fuploads%2F0123456789",
  );
  assert.equal((calls[0].init?.headers as Record<string, string> | undefined)?.Authorization, `Bearer ${TOKEN}`);
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "期限付きの signal を渡す");
});

test("readImageInput propagates the user abort to the request", async () => {
  const { calls, impl } = stubFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  const controller = new AbortController();
  const pending = client.readImageInput("x.png", [""], controller.signal);
  controller.abort();
  await assert.rejects(pending);
  const passed = calls[0].init?.signal;
  assert.ok(passed instanceof AbortSignal);
  assert.equal(passed.aborted, true, "ユーザー中断を読み取りへ伝播する");
});

test("readImageInput accepts only a whole 200 response and rejects partial content", async () => {
  // 206 は完成画像ではない。本文を捨てて、provider を呼ぶ前に拒否する
  const partial = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { "Content-Length": "3", "Content-Range": "bytes 0-2/300" },
        }),
    ).impl,
  });
  await assert.rejects(partial.readImageInput("x.png", [""]), /全体応答だけを受け付けます/);

  const notSatisfiable = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(() => new Response(null, { status: 416, headers: { "Content-Range": "bytes */300" } })).impl,
  });
  await assert.rejects(notSatisfiable.readImageInput("x.png", [""]), /全体応答だけを受け付けます/);
});

test("readImageInput relays 4xx messages and rejects a truncated or oversized body", async () => {
  const notFound = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(() => new Response(JSON.stringify({ error: "Path not found: x" }), { status: 404 })).impl,
  });
  await assert.rejects(notFound.readImageInput("x.png", [""]), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 404);
    return true;
  });

  // Content-Length より短い本文は完成画像として返さない
  const truncated = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(
      () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "Content-Length": "4" } }),
    ).impl,
  });
  await assert.rejects(truncated.readImageInput("x.png", [""]), /受信が途中で終わりました/);

  // 宣言された Content-Length が上限を超える応答は本文を読まずに拒む
  const declaredTooLarge = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "Content-Length": String(IMAGE_INPUT_MAX_BYTES + 1) },
        }),
    ).impl,
  });
  await assert.rejects(declaredTooLarge.readImageInput("x.png", [""]), /大きすぎます/);

  // Content-Length が無くても実受信バイト数で止める
  const streamedTooLarge = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index <= IMAGE_INPUT_MAX_BYTES / (1024 * 1024); index += 1) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }).impl,
  });
  await assert.rejects(streamedTooLarge.readImageInput("x.png", [""]), /大きすぎます/);

  const empty = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: stubFetch(() => new Response(null, { status: 200 })).impl,
  });
  await assert.rejects(empty.readImageInput("x.png", [""]));
});

// ---------------------------------------------------------------------------
// deleteDirectory (DELETE /v1/dirs。JSON 経路)
// ---------------------------------------------------------------------------

test("deleteDirectory sends DELETE with recursive=true and does not read the 204 body", async () => {
  // 本文が無い応答で response.json() を呼ぶと throw するため、resolve すること自体が本文を読まない証明になる
  const { calls, impl } = stubFetch(() => new Response(null, { status: 204 }));
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  await client.deleteDirectory("dir/sub");
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/dirs?path=dir%2Fsub&recursive=true");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal(init.method, "DELETE");
  assert.equal(init.body, undefined, "削除のリクエストに本文を載せない");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
});

test("deleteDirectory relays sandbox 4xx messages and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: message }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ).impl;

  const notEmpty = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(400, "Directory is not empty: /workspace/dir"),
  });
  await assert.rejects(notEmpty.deleteDirectory("dir"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 400);
    assert.match(error.message, /not empty/);
    return true;
  });

  const missing = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(404, "Path not found: /workspace/nope"),
  });
  await assert.rejects(missing.deleteDirectory("nope"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 404);
    return true;
  });

  const broken = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(500, "boom"),
  });
  await assert.rejects(broken.deleteDirectory("dir"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /ディレクトリを削除できませんでした/);
    return true;
  });

  const down = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: (() => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  await assert.rejects(down.deleteDirectory("dir"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /接続できません/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// renameEntry (POST /v1/files/rename。JSON 経路)
// ---------------------------------------------------------------------------

test("renameEntry posts the path and name and parses the new path", async () => {
  const { calls, impl } = stubFetch(
    () =>
      new Response(JSON.stringify({ path: "uploads/shot.png", name: "shot.png" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  const result = await client.renameEntry("uploads/photo.png", "shot.png");
  assert.deepEqual(result, { path: "uploads/shot.png", name: "shot.png" });
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/files/rename");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(init.body)), { path: "uploads/photo.png", name: "shot.png" });
});

test("renameEntry relays the sandbox 409 conflict and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: message }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ).impl;

  const conflict = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(409, "Already exists: /workspace/b.txt"),
  });
  await assert.rejects(conflict.renameEntry("a.txt", "b.txt"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Already exists: /workspace/b.txt");
    return true;
  });

  const invalid = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(400, "Invalid name: a/b"),
  });
  await assert.rejects(invalid.renameEntry("a.txt", "a/b"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 400);
    return true;
  });

  const broken = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(500, "boom"),
  });
  await assert.rejects(broken.renameEntry("a.txt", "b.txt"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /名前を変更できませんでした/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// moveEntry (POST /v1/files/move。JSON 経路)
// ---------------------------------------------------------------------------

test("moveEntry posts from and to and parses the moved path", async () => {
  const { calls, impl } = stubFetch(
    () =>
      new Response(JSON.stringify({ path: "spaces/s1/moved" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test:8080/", token: TOKEN, fetchImpl: impl });
  const result = await client.moveEntry("old", "spaces/s1/moved");
  assert.deepEqual(result, { path: "spaces/s1/moved" });
  assert.equal(calls[0].url, "http://sandbox.test:8080/v1/files/move");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(init.body)), { from: "old", to: "spaces/s1/moved" });
});

test("moveEntry relays the sandbox 409 conflict and maps the rest to 502", async () => {
  const sandboxError = (status: number, message: string) =>
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: message }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ).impl;

  const conflict = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(409, "Already exists: /workspace/b.txt"),
  });
  await assert.rejects(conflict.moveEntry("a.txt", "b.txt"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Already exists: /workspace/b.txt");
    return true;
  });

  const outside = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(400, "Path outside the workspace: /etc"),
  });
  await assert.rejects(outside.moveEntry("a.txt", "../b.txt"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 400);
    return true;
  });

  const broken = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: sandboxError(500, "boom"),
  });
  await assert.rejects(broken.moveEntry("a.txt", "b.txt"), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 502);
    assert.match(error.message, /移動できませんでした/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// downloadEntry / checkDownload (GET /v1/files/download[/check]。exclude は繰り返しの query)
// ---------------------------------------------------------------------------

/**
 * 除外名は「param なし = BFF 未指定（サンドボックスが既定を使う）」と「空値のみ = 除外なし」を
 * 区別する唯一の手段なので、組み立てた URL をここで固定する（サンドボックス側の受け取りは
 * sandbox-archive.test.ts が見る）。
 */
test("downloadEntry / checkDownload は exclude を繰り返しで送り、空リストでも 1 つ送る", async () => {
  const download = stubFetch(
    () =>
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": "attachment; filename*=UTF-8''src.zip",
        },
      }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: download.impl });
  await client.downloadEntry("src/nested", ["node_modules", "dist"]);
  assert.equal(
    download.calls[0].url,
    "http://sandbox.test/v1/files/download?path=src%2Fnested&exclude=node_modules&exclude=dist",
  );
  // 空リストは「明示空」を伝えるマーカー。ここで param を落とすと保存した「除外なし」が既定に戻る
  await client.downloadEntry("src", []);
  assert.equal(download.calls[1].url, "http://sandbox.test/v1/files/download?path=src&exclude=");

  const check = stubFetch(
    () =>
      new Response(JSON.stringify({ kind: "archive", name: "src.zip", bytes: 0, entries: 0, skipped: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const checkClient = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: check.impl });
  await checkClient.checkDownload("src", ["dist", "node_modules"]);
  assert.equal(
    check.calls[0].url,
    "http://sandbox.test/v1/files/download/check?path=src&exclude=dist&exclude=node_modules",
  );
  await checkClient.checkDownload("src", []);
  assert.equal(check.calls[1].url, "http://sandbox.test/v1/files/download/check?path=src&exclude=");
});

test("planDownload は maxFileBytes を省略時に送らず、応答をそのまま返す", async () => {
  const payload = {
    kind: "archive",
    name: "src.zip",
    entries: 1,
    bytes: 3,
    files: [{ name: "a.txt", size: 3 }],
    truncated: false,
    links: [],
    linksTruncated: false,
    oversizeFiles: [],
    oversizeTruncated: false,
    hasIndexHtml: false,
    skipped: [],
  };
  const { calls, impl } = stubFetch(
    () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: impl });
  assert.deepEqual(await client.planDownload("src", []), payload);
  assert.equal(calls[0].url, "http://sandbox.test/v1/files/download/plan?path=src&exclude=");
  await client.planDownload("src", ["dist", "node_modules"], 25 * 1024 * 1024);
  assert.equal(
    calls[1].url,
    "http://sandbox.test/v1/files/download/plan?path=src&exclude=dist&exclude=node_modules&maxFileBytes=26214400",
  );

  // 413 は download / check と同じく status を保って透過する (プレビュー側が limited に写す)
  const tooLarge = stubFetch(
    () => new Response(JSON.stringify({ error: "Download is too large (max 10 bytes)" }), { status: 413 }),
  );
  const failing = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: tooLarge.impl });
  await assert.rejects(failing.planDownload("src", []), (error: unknown) => {
    assert.ok(error instanceof SandboxRequestError);
    assert.equal(error.status, 413);
    return true;
  });
});

// 待受プロセスの観測は serve の所有者照合の唯一の入力なので、query の組み立てと応答の写像を固定する
// (サンドボックス側の受け取りは sandbox-process-scan.test.ts が見る)。
test("scanListeners は port と scan を query で送り、応答をそのまま写す", async () => {
  const payload = {
    inodes: [1270278],
    addressScopes: ["loopback"],
    listener: { pid: 237424, startedAt: 1_700_000_000_000, inodes: [1270278], ancestors: [237424, 1] },
  };
  const { calls, impl } = stubFetch(
    () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test/", token: TOKEN, fetchImpl: impl });
  assert.deepEqual(await client.scanListeners(8080, { scan: true }), payload);
  assert.equal(calls[0].url, "http://sandbox.test/v1/procs/listeners?port=8080&scan=true");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);

  const failure = stubFetch(
    () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } }),
  );
  const failing = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: failure.impl });
  await assert.rejects(
    () => failing.scanListeners(8080, { scan: false }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxRequestError, "サンドボックス側の失敗として分類する");
      assert.equal((error as SandboxRequestError).status, 502);
      return true;
    },
  );
});

// レンジ走査は状態表示のポーリングが使う。待受のあったポートだけを返す契約を query と応答の写像で固定する。
test("scanListenerRange は from と to を query で送り、応答をそのまま写す", async () => {
  const payload = { ports: [{ port: 18000, inodes: [1270278, 1270280] }] };
  const { calls, impl } = stubFetch(
    () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = createSandboxToolClient({ baseUrl: "http://sandbox.test/", token: TOKEN, fetchImpl: impl });
  assert.deepEqual(await client.scanListenerRange(18000, 18099), payload);
  assert.equal(calls[0].url, "http://sandbox.test/v1/procs/listeners?from=18000&to=18099");
  const init = calls[0].init;
  assert.ok(init, "fetch が init 付きで呼ばれる");
  assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.ok(init.signal, "期限の signal を付ける");

  const failure = stubFetch(
    () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } }),
  );
  const failing = createSandboxToolClient({ baseUrl: "http://sandbox.test", token: TOKEN, fetchImpl: failure.impl });
  await assert.rejects(
    () => failing.scanListenerRange(18000, 18099),
    (error: unknown) => {
      assert.ok(error instanceof SandboxRequestError, "サンドボックス側の失敗として分類する");
      assert.equal((error as SandboxRequestError).status, 502);
      return true;
    },
  );
});

// 待受観測は serve の操作を直列化するロックの内側で走るため、無期限に待つと後続の操作が全部詰まる。
// fetch / 本文が止まっても期限で抜けて abort を伝えることを固定する。
test("待受観測は本文が止まっても期限で打ち切り、abort を伝える", async () => {
  let signal: AbortSignal | undefined;
  const hanging = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // 本文を閉じない (サンドボックス側が固まった状態)
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const client = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: hanging,
    listenerScanTimeoutMs: 50,
  });
  const began = Date.now();
  await assert.rejects(
    () => client.scanListeners(8080, { scan: true }),
    (error: unknown) => {
      assert.match((error as Error).message, /タイムアウト/);
      return true;
    },
  );
  assert.ok(Date.now() - began < 4000, "期限で抜ける");
  assert.equal(signal?.aborted, true, "期限超過では fetch を abort する");

  await assert.rejects(
    () => client.scanListenerRange(18000, 18099),
    (error: unknown) => {
      assert.match((error as Error).message, /タイムアウト/);
      return true;
    },
  );
});
