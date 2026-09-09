// HTTP 系テスト (port of test/sessions.test.js の HTTP 部分を app.request() 化)。
// listen せず、createBffApp に stub pi を注入して検証する。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import type { PiBff } from "../src/agent";
import { createBffApp } from "../src/app";

/**
 * Minimal stub of the pi runtime/session used by the store. It mimics the
 * event flow of createAgentSession(): subscribe/prompt/abort + agent events.
 * Abort interrupts the in-flight chunk delay; the prompt loop then unwinds and
 * emits agent_settled itself, mirroring the real SDK.
 */
function createStubSession({ reply = "スタブの返答です", chunkDelayMs = 0 } = {}) {
  const listeners = new Set<(event: unknown) => void>();
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>((resolveSleep) => {
    if (ms <= 0) {
      resolveSleep();
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      sleepers.delete(wake);
      resolveSleep();
    };
    const timer = setTimeout(wake, ms);
    timer.unref?.();
    sleepers.add(wake);
  });
  const session = {
    sessionId: `pi-${Math.random().toString(36).slice(2, 10)}`,
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as Array<{ role: string; content: unknown }>,
    isStreaming: false,
    disposed: false,
    abortRequested: false,
    sessionManager: { getCwd: () => "/tmp/project" },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
    async abort() {
      if (!session.isStreaming) return;
      session.abortRequested = true;
      for (const wake of [...sleepers]) wake();
    },
    dispose() {
      session.disposed = true;
    },
    async prompt(text: string) {
      session.abortRequested = false;
      session.isStreaming = true;
      try {
        session.messages.push({ role: "user", content: text });
        session.emit({ type: "agent_start" });
        session.emit({ type: "message_start", message: { role: "assistant" } });
        const assistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
        session.messages.push(assistant);
        const chunks = [reply.slice(0, 3), reply.slice(3)].filter(Boolean);
        for (const chunk of chunks) {
          await sleep(chunkDelayMs);
          if (session.abortRequested) break;
          (assistant.content[0] as { text: string }).text += chunk;
          session.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
        if (session.abortRequested) assistant.stopReason = "aborted";
      } finally {
        session.emit({ type: "agent_settled" });
        session.isStreaming = false;
      }
    },
  };
  return session;
}

function createStubPi(options = {}) {
  const sessions: ReturnType<typeof createStubSession>[] = [];
  return {
    cwd: "/tmp/project",
    selectedModel: { provider: "stub", id: "stub-model" },
    availableModels: [{ provider: "stub", id: "stub-model" }],
    tools: ["read"],
    sessions,
    createSession: async () => {
      const session = createStubSession(options);
      sessions.push(session);
      return { session };
    },
  };
}

/** store が受ける PiBff の最小模倣であることを明示するためのキャスト */
function asPiBff(pi: unknown): PiBff {
  return pi as PiBff;
}

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function createSession(app: Hono, agentId = "agent-cat") {
  const response = await app.request("/api/sessions", jsonPost({ agentId }));
  assert.equal(response.status, 201);
  return (await response.json()) as { sessionId: string };
}

type ParsedSseEvent = { id: number | null; type: string; data: any };

/** Response.json() は unknown を返すためテスト用に any に寄せる */
const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

test("server exposes the async session API end to end", async () => {
  const pi = createStubPi({ chunkDelayMs: 10 });
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(pi) });
  const { app } = bff;

  try {
    const health = await jsonBody(app.request("/api/health"));
    assert.equal(health.ready, true);

    const created = await createSession(app);
    assert.ok(created.sessionId);

    // Subscribe before sending: the SSE stream must deliver the whole run.
    const eventsResponse = await app.request(`/api/sessions/${created.sessionId}/events?after=0`);
    assert.equal(eventsResponse.status, 200);
    assert.match(eventsResponse.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(eventsResponse.headers.get("cache-control") || "", /no-transform/);

    const postResponse = await app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "非同期で動いて" }));
    assert.equal(postResponse.status, 202);
    const postBody = await jsonBody(postResponse);
    assert.equal(postBody.queued, false);
    assert.equal(postBody.sessionId, created.sessionId);

    const events = await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "run_end"));
    assert.equal(events[0].type, "run_start");
    assert.equal(events.at(-1)?.data?.status, "completed");
    const textEvents = events.filter((entry) => entry.type === "text");
    assert.equal(textEvents.map((entry) => entry.data.delta).join(""), "スタブの返答です");

    const listed = await jsonBody(app.request("/api/sessions"));
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].sessionId, created.sessionId);

    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.status, "completed");

    const stopped = await app.request(`/api/sessions/${created.sessionId}/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    const stopBody = await jsonBody(stopped);
    assert.equal(stopBody.sessionId, created.sessionId);
    assert.equal(stopBody.ok, true);

    const deleted = await app.request(`/api/sessions/${created.sessionId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const gone = await app.request(`/api/sessions/${created.sessionId}`);
    assert.equal(gone.status, 404);
    assert.deepEqual(await jsonBody(gone), { error: "Session not found" });
  } finally {
    await bff.close();
  }
});

test("server still answers when the pi runtime failed to initialize", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null });
  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, false);

    const response = await bff.app.request("/api/sessions", jsonPost({}));
    assert.equal(response.status, 503);
    const body = await jsonBody(response);
    assert.equal(body.error, "Pi runtime is not ready");
  } finally {
    await bff.close();
  }
});

test("message endpoint validates the request body", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const base = `/api/sessions/${created.sessionId}/messages`;

    const empty = await app.request(base, jsonPost({ text: "   " }));
    assert.equal(empty.status, 400);
    assert.equal((await jsonBody(empty)).error, "text is required");

    const nonString = await app.request(base, jsonPost({ text: 42 }));
    assert.equal(nonString.status, 400);
    assert.equal((await jsonBody(nonString)).error, "text is required");

    const invalidJson = await app.request(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await jsonBody(invalidJson)).error, "Request body must be valid JSON");

    const tooLong = await app.request(base, jsonPost({ text: "あ".repeat(20_001) }));
    assert.equal(tooLong.status, 413);
    assert.match((await jsonBody(tooLong)).error, /Message is too long/);

    const tooLarge = await app.request(base, jsonPost({ text: "x".repeat(70 * 1024) }));
    assert.equal(tooLarge.status, 413);
    assert.equal((await jsonBody(tooLarge)).error, "Request body is too large");
  } finally {
    await bff.close();
  }
});

test("unknown api paths answer with a JSON 404", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null });
  try {
    const missing = await bff.app.request("/api/unknown");
    assert.equal(missing.status, 404);
    assert.deepEqual(await jsonBody(missing), { error: "Not found" });

    const wrongMethod = await bff.app.request("/api/agents/agent-cat", jsonPost({}));
    assert.equal(wrongMethod.status, 404);
    assert.deepEqual(await jsonBody(wrongMethod), { error: "Not found" });

    const missingSession = await bff.app.request("/api/sessions/nope");
    assert.equal(missingSession.status, 404);
    assert.deepEqual(await jsonBody(missingSession), { error: "Session not found" });
  } finally {
    await bff.close();
  }
});

test("catalog endpoints relay the normalization errors of the catalog", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const invalidReplace = await app.request("/api/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: "not-an-array", skills: [] }),
    });
    assert.equal(invalidReplace.status, 400);
    assert.equal((await jsonBody(invalidReplace)).error, "Definitions must contain skills and agents arrays");

    const nameless = await app.request("/api/agents", jsonPost({ description: "名前がない" }));
    assert.equal(nameless.status, 400);
    assert.equal((await jsonBody(nameless)).error, "Agent name is required");

    const unknownAgent = await app.request("/api/agents/nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(unknownAgent.status, 404);
    assert.deepEqual(await jsonBody(unknownAgent), { error: "Agent not found" });
  } finally {
    await bff.close();
  }
});

test("static files are served with cache and security headers", async () => {
  const distDir = await mkdtemp(join(tmpdir(), "bff-static-"));
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<html>ok</html>");
  await writeFile(join(distDir, "assets", "app.js"), "console.log(1);");
  const bff = await createBffApp({
    cwd: "/tmp/project",
    pi: asPiBff(createStubPi()),
    clientDistDir: distDir,
  });
  try {
    const root = await bff.app.request("/");
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.match(root.headers.get("content-security-policy") || "", /default-src 'self'/);

    const asset = await bff.app.request("/assets/app.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const missing = await bff.app.request("/nope.txt");
    assert.equal(missing.status, 404);
    assert.deepEqual(await jsonBody(missing), { error: "Not found" });

    // Traversal guard: client/dist の外は 404。
    const traversal = await bff.app.request("/%2e%2e%2fsecret.txt");
    assert.equal(traversal.status, 404);
    assert.deepEqual(await jsonBody(traversal), { error: "Not found" });
  } finally {
    await bff.close();
    await rm(distDir, { recursive: true, force: true });
  }
});

test("missing client build answers with a 503 hint", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "bff-empty-"));
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null, clientDistDir: emptyDir });
  try {
    const response = await bff.app.request("/");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /Client build missing/);
  } finally {
    await bff.close();
    await rm(emptyDir, { recursive: true, force: true });
  }
});

async function collectSse(response: Response, predicate: (events: ParsedSseEvent[]) => boolean, timeoutMs = 5000): Promise<ParsedSseEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: ParsedSseEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE timeout")), timeoutMs);
  });
  try {
    while (!predicate(events)) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseSseBlock(block);
        if (event) events.push(event);
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return events;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let id: number | null = null;
  let type: string | undefined;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!type) return null;
  return { id, type, data: data ? JSON.parse(data) : null };
}
