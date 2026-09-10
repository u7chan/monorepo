// HTTP 系テスト (port of test/sessions.test.js の HTTP 部分を app.request() 化)。
// listen せず、createBffApp に stub pi を注入して検証する。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import { AUTH_REQUIRED_MESSAGE } from "../src/agent";
import { createBffApp } from "../src/app";
import { asPiBff, createStubPi, STUB_MODEL, STUB_PLAIN_MODEL } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonPatch = (payload: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function createSession(app: Hono, agentId = "agent-general") {
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

test("reports missing API-key authentication before creating an unusable session", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    pi: asPiBff(
      createStubPi({
        availableModels: [],
        selectedModel: null,
        availabilityError: AUTH_REQUIRED_MESSAGE,
        createSessionRejects: 1,
      }),
    ),
  });
  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, false);
    assert.equal(health.errorCode, "authentication_required");
    assert.equal(health.error, AUTH_REQUIRED_MESSAGE);
    assert.deepEqual(health.modelOptions, []);

    const response = await bff.app.request("/api/sessions", jsonPost({}));
    assert.equal(response.status, 503);
    assert.equal((await jsonBody(response)).error, AUTH_REQUIRED_MESSAGE);
  } finally {
    await bff.close();
  }
});

test("health exposes the model picker options and the app default thinking level", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    pi: asPiBff(createStubPi({ defaultThinkingLevel: "low" })),
  });
  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, true);
    assert.equal(health.model, "stub/stub-model");
    assert.equal(health.defaultThinkingLevel, "low");
    assert.equal(health.defaultModelError, undefined);
    assert.deepEqual(
      health.modelOptions.map((option: { supportsThinking: boolean; thinkingLevels: string[] }) => [
        option.supportsThinking,
        option.thinkingLevels,
      ]),
      [
        [true, ["off", "minimal", "low", "medium", "high"]],
        [false, ["off"]],
      ],
    );
    assert.deepEqual(
      health.modelOptions.map((option: { name: string }) => option.name),
      ["Stub Model", "Stub Plain"],
    );
  } finally {
    await bff.close();
  }
});

test("an unusable PI_MODEL keeps ready true and surfaces a default model error", async () => {
  const pi = createStubPi({
    selectedModel: null,
    defaultModelError: "PI_MODEL のモデルは利用できません: stub/ghost",
  });
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const health = await jsonBody(app.request("/api/health"));
    assert.equal(health.ready, true, "他候補があるなら ready のままにする");
    assert.equal(health.model, undefined);
    assert.match(health.defaultModelError, /stub\/ghost/);
    assert.equal(health.errorCode, undefined);

    // 明示モデル無しの作成は 503 (別モデルへ黙って fallback しない)
    const fallback = await app.request("/api/sessions", jsonPost({}));
    assert.equal(fallback.status, 503);
    assert.match((await jsonBody(fallback)).error, /stub\/ghost/);

    // 有効なモデルを明示すれば作成できる
    const created = await app.request("/api/sessions", jsonPost({ model: { provider: "stub", id: "stub-plain" } }));
    assert.equal(created.status, 201);
    const payload = await jsonBody(created);
    assert.equal(payload.model, "stub/stub-plain");
    assert.deepEqual(pi.createInputs.at(-1)?.model, { provider: "stub", id: "stub-plain" });
  } finally {
    await bff.close();
  }
});

test("session creation resolves request → definition → app default per field", async () => {
  const pi = createStubPi({ defaultThinkingLevel: "medium" });
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(pi) });
  const { app, catalog } = bff;
  try {
    catalog.updateAgent("agent-reviewer", {
      model: { provider: "stub", id: "stub-plain" },
      thinkingLevel: "low",
    });

    // 定義の model / thinkingLevel が使われる
    const fromDefinition = await app.request("/api/sessions", jsonPost({ agentId: "agent-reviewer" }));
    assert.equal(fromDefinition.status, 201);
    const defined = await jsonBody(fromDefinition);
    assert.equal(defined.model, "stub/stub-plain");
    assert.equal(defined.thinkingLevel, "low");

    // リクエストは項目ごとに定義を上書きする
    const fromRequest = await app.request(
      "/api/sessions",
      jsonPost({
        agentId: "agent-reviewer",
        model: { provider: "stub", id: "stub-model" },
        thinkingLevel: "high",
      }),
    );
    assert.equal(fromRequest.status, 201);
    const requested = await jsonBody(fromRequest);
    assert.equal(requested.model, "stub/stub-model");
    assert.equal(requested.thinkingLevel, "high");
    assert.equal(requested.supportsThinking, true);

    // アプリ既定 (medium) は定義もリクエストも無い項目にだけ使われる
    const appDefault = await app.request("/api/sessions", jsonPost({ agentId: "agent-general" }));
    const payload = await jsonBody(appDefault);
    assert.equal(payload.model, "stub/stub-model");
    assert.equal(payload.thinkingLevel, "medium");

    // 不正な値は SDK 作成前に 400
    const invalidModel = await app.request(
      "/api/sessions",
      jsonPost({ agentId: "agent-general", model: { provider: "stub", id: "ghost" } }),
    );
    assert.equal(invalidModel.status, 400);
    assert.match((await jsonBody(invalidModel)).error, /not available/);

    const invalidLevel = await app.request(
      "/api/sessions",
      jsonPost({ agentId: "agent-general", thinkingLevel: "ultra" }),
    );
    assert.equal(invalidLevel.status, 400);

    const nullModel = await app.request(
      "/api/sessions",
      jsonPost({ agentId: "agent-general", model: null }),
    );
    assert.equal(nullModel.status, 400);
    assert.equal(pi.sessions.length, 3, "400 は SDK 作成まで到達しない");
  } finally {
    await bff.close();
  }
});

test("chat settings endpoint validates the body and reports missing sessions", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const base = `/api/sessions/${created.sessionId}/settings`;

    const missing = await app.request("/api/sessions/nope/settings", jsonPatch({ thinkingLevel: "high" }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await jsonBody(missing), { error: "Session not found" });

    const empty = await app.request(base, jsonPatch({}));
    assert.equal(empty.status, 400);
    assert.match((await jsonBody(empty)).error, /model or thinkingLevel/);

    const nullLevel = await app.request(base, jsonPatch({ thinkingLevel: null }));
    assert.equal(nullLevel.status, 400);
    assert.equal((await jsonBody(nullLevel)).error, "Invalid session settings");

    const unknownLevel = await app.request(base, jsonPatch({ thinkingLevel: "ultra" }));
    assert.equal(unknownLevel.status, 400);

    const shortModel = await app.request(base, jsonPatch({ model: { provider: "stub" } }));
    assert.equal(shortModel.status, 400);

    const unavailable = await app.request(base, jsonPatch({ model: { provider: "stub", id: "ghost" } }));
    assert.equal(unavailable.status, 400);
    assert.match((await jsonBody(unavailable)).error, /not available/);

    // 400 の間も値は不変
    const unchanged = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(unchanged.thinkingLevel, "medium");
  } finally {
    await bff.close();
  }
});

test("chat settings endpoint applies the effective values and resyncs subscribers", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const eventsResponse = await app.request(`/api/sessions/${created.sessionId}/events?after=0`);

    const changed = await app.request(
      `/api/sessions/${created.sessionId}/settings`,
      jsonPatch({ model: { provider: "stub", id: "stub-plain" }, thinkingLevel: "high" }),
    );
    assert.equal(changed.status, 200);
    const payload = await jsonBody(changed);
    assert.equal(payload.model, "stub/stub-plain");
    assert.equal(payload.thinkingLevel, "off", "SDK 補正後の実効値が返る");
    assert.equal(payload.supportsThinking, false);
    assert.deepEqual(payload.availableThinkingLevels, ["off"]);

    const events = await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "resync"));
    const resync = events.find((entry) => entry.type === "resync");
    assert.equal(resync?.data.thinkingLevel, "off");
    assert.equal(resync?.data.model, "stub/stub-plain");
    assert.equal(resync?.id, payload.lastSeq, "resync の seq は payload.lastSeq と一致する");

    // 一覧の model も実効値へ追従する
    const listed = await jsonBody(app.request("/api/sessions"));
    assert.equal(listed.sessions[0].model, "stub/stub-plain");
  } finally {
    await bff.close();
  }
});

test("chat settings endpoint rejects changes while the session is busy", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: asPiBff(createStubPi({ chunkDelayMs: 40 })) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const posted = await app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "実行中" }));
    assert.equal(posted.status, 202);

    const duringRun = await app.request(
      `/api/sessions/${created.sessionId}/settings`,
      jsonPatch({ thinkingLevel: "high" }),
    );
    assert.equal(duringRun.status, 409);

    const queued = await app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "待機" }));
    assert.equal(queued.status, 202);
    const duringQueue = await app.request(
      `/api/sessions/${created.sessionId}/settings`,
      jsonPatch({ thinkingLevel: "high" }),
    );
    assert.equal(duringQueue.status, 409);

    await app.request(`/api/sessions/${created.sessionId}/stop`, { method: "POST" });
    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(payload.thinkingLevel, "medium", "409 で値は変わらない");
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

    const wrongMethod = await bff.app.request("/api/agents/agent-general", jsonPost({}));
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
