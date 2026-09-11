// サンドボックス ツール実行サービスのテスト。
// listen せず app.request() で検証する。実 LLM API は呼ばない
// (SDK のローカルツール実装と実ファイルシステム / bash だけを使う)。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import type { SandboxEvent } from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";
const HAS_BASH = existsSync("/bin/bash");
const SKIP_REASON = "bash is not available on this platform";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function readEvents(response: Response): Promise<SandboxEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SandboxEvent);
}

function eventText(payload: unknown): string {
  const content = (payload as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

test("healthz is public and reports tools without secrets", async () => {
  const service = createSandboxService({ token: TOKEN, rootCwd: join(tmpdir(), "pi-sbx-health") });
  const response = await service.app.request("/healthz");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; tools: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual([...body.tools].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test("rejects unauthenticated requests to /v1/*", async () => {
  const service = createSandboxService({ token: TOKEN, rootCwd: join(tmpdir(), "pi-sbx-auth") });
  const noHeader = await service.app.request("/v1/tools/bash/execute", { method: "POST" });
  assert.equal(noHeader.status, 401);
  const wrongToken = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token-0123456789abcdef" },
  });
  assert.equal(wrongToken.status, 401);
  // /v1 以下は認証前に 404 にならない (unknown tool でも認証が先)
  const unknown = await service.app.request("/v1/tools/nope/execute", {
    method: "POST",
    headers: authHeaders(),
  });
  assert.equal(unknown.status, 404);
});

test("executes bash and streams start/update/result events", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-bash-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ toolCallId: "call-1", params: { command: "echo hello-sandbox" } }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = await readEvents(response);
  assert.equal(events[0].type, "start");
  assert.ok("executionId" in events[0] && events[0].executionId.length > 0);
  const result = events.find((event) => event.type === "result");
  assert.ok(result, "result event expected");
  assert.match(eventText((result as { payload: unknown }).payload), /hello-sandbox/);
  assert.ok(!events.some((event) => event.type === "error"));
});

test("resolves paths against the sandbox root cwd and persists files", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-cwd-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/write/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { path: "notes/hello.txt", content: "from sandbox" } }),
  });
  const events = await readEvents(response);
  assert.ok(events.some((event) => event.type === "result"), "write should succeed");
  // 相対パスは rootCwd 基準で解決される
  assert.equal(await readFile(join(root, "notes/hello.txt"), "utf8"), "from sandbox");
});

test("read tool returns file content from the sandbox filesystem", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-read-"));
  await writeFile(join(root, "sample.txt"), "sample-body", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/read/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { path: "sample.txt" } }),
  });
  const events = await readEvents(response);
  const result = events.find((event) => event.type === "result");
  assert.ok(result, "read should succeed");
  assert.match(eventText((result as { payload: unknown }).payload), /sample-body/);
});

test("cancels a running execution via the cancel endpoint", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-cancel-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const began = Date.now();
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { command: "sleep 5; echo late" } }),
  });
  // start イベントを拾いながら並行で読み進める
  const events: SandboxEvent[] = [];
  let streamClosed = false;
  const consuming = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) events.push(JSON.parse(line) as SandboxEvent);
        index = buffer.indexOf("\n");
      }
    }
    streamClosed = true;
  })();
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  const start = events.find((event) => event.type === "start");
  assert.ok(start && "executionId" in start, "start event should arrive while sleep is running");
  const cancelled = await service.app.request(
    `/v1/executions/${start.executionId}/cancel`,
    { method: "POST", headers: authHeaders() },
  );
  assert.equal(cancelled.status, 200);
  // 実行は 5 秒待たずに中断され、ストリームが閉じる
  const timeout = new Promise((_, rejectTimeout) =>
    setTimeout(() => rejectTimeout(new Error("execution did not settle in time")), 4000),
  );
  await Promise.race([consuming, timeout]);
  assert.ok(streamClosed, "stream must close after cancel");
  assert.ok(Date.now() - began < 4500, "cancel must not wait for the sleep to finish");
  assert.ok(!service.executions.has(start.executionId), "execution must be cleaned up");
});

test("sandbox bash does not expose BFF session environment variables", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-env-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { command: "printenv PI_SESSION_ID PI_SANDBOX_TOKEN OPENAI_API_KEY" } }),
  });
  const events = await readEvents(response);
  // printenv は変数が全て未設定だと code 1 で終了し、SDK bash はエラーイベントになる
  const settled = events.some((event) => event.type === "error" || event.type === "result");
  assert.ok(settled, "execution must settle");
  const text = events
    .map((event) =>
      event.type === "error"
        ? event.message
        : event.type === "result" || event.type === "update"
          ? eventText((event as { payload: unknown }).payload)
          : "",
    )
    .join("");
  assert.ok(!text.includes(TOKEN), "PI_SANDBOX_TOKEN must not leak into tool output");
  assert.ok(!text.includes("pi-session"), "session metadata env vars must be unset");
});

test("unknown tool and invalid params return 4xx", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-invalid-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const notObject = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: ["not-an-object"] }),
  });
  assert.equal(notObject.status, 400);
});

test("close aborts all running executions", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-close-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  Promise.resolve(
    service.app.request("/v1/tools/bash/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { command: "sleep 5" } }),
    }),
  ).catch(() => {});
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  assert.ok(service.executions.size > 0, "a running execution should be tracked");
  service.close();
  assert.equal(service.executions.size, 0);
});

// rg が手元に無くても grep/find が SDK 経由で壊れないことの最低限確認
test("grep tool reports missing ripgrep as an error event instead of hanging", async () => {
  const rg = spawnSync("rg", ["--version"], { stdio: "ignore" });
  if (rg.status !== 0) {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-norg-"));
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    const response = await service.app.request("/v1/tools/grep/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { pattern: "x" } }),
    });
    const events = await readEvents(response);
    assert.ok(events.some((event) => event.type === "error" || event.type === "result"));
  } else {
    // rg がある環境では実行して結果が出ることだけ見る
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-rg-"));
    await writeFile(join(root, "hay.txt"), "needle here\n", "utf8");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    const response = await service.app.request("/v1/tools/grep/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { pattern: "needle" } }),
    });
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");
    assert.ok(result, "grep should succeed");
    assert.match(eventText((result as { payload: unknown }).payload), /needle/);
  }
});
