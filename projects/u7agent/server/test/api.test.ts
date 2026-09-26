// createBffApp に stub pi を注入し、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import { AUTH_REQUIRED_MESSAGE, deriveRuntimeModelDiagnostics, MODEL_WHITELIST_EMPTY_MESSAGE } from "../src/agent";
import { createBffApp } from "../src/app";
import { BUILTIN_SKILLS } from "../src/builtin-skills";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../src/sandbox/client";
import {
  asPiBff,
  createStubPi,
  STUB_CONTEXT_USAGE,
  STUB_MODEL,
  STUB_PLAIN_MODEL,
  STUB_USAGE,
  stubModel,
} from "./stub-pi";

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

async function createSession(app: Hono) {
  const response = await app.request("/api/sessions", jsonPost({}));
  assert.equal(response.status, 201);
  return (await response.json()) as { sessionId: string };
}

/** /api/files と /api/projects が使うサンドボックスの stub。受けたパスを記録する。 */
function stubWorkspace(): { workspace: SandboxWorkspaceClient; dirs: string[]; listings: string[] } {
  const dirs: string[] = [];
  const listings: string[] = [];
  return {
    dirs,
    listings,
    workspace: {
      previewFile: async () => ({ text: "" }),
      listFiles: async (path: string) => {
        listings.push(path);
        return { path: path || ".", entries: [], truncated: false };
      },
      // ファイルスキルの発見はこのテストでは扱わない (専用のテストで検証する)
      listSkills: async () => ({ skills: [] }),
      createDir: async (path: string) => {
        dirs.push(path);
        return { path };
      },
      // 削除 / リネーム / アップロード / 生配信はこのテストでは扱わない
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
      // ダウンロードはこのテストでは扱わない
      downloadEntry: async () => ({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
        body: null,
      }),
      checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
    },
  };
}

/** SSE のカーソルは世代つき (`<generation>:<seq>`) が契約。payload から世代を引いて URL を組む */
async function eventsUrl(app: Hono, sessionId: string, after?: number): Promise<string> {
  const payload = await jsonBody(app.request(`/api/sessions/${sessionId}`));
  const query = new URLSearchParams({
    generation: String(payload.eventGeneration),
    after: String(after ?? payload.lastSeq),
  });
  return `/api/sessions/${sessionId}/events?${query.toString()}`;
}

type ParsedSseEvent = { id: number | null; type: string; data: any };

/** Response.json() は unknown を返すためテスト用に any に寄せる */
const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

test("server exposes the async session API end to end", async () => {
  const pi = createStubPi({ chunkDelayMs: 10 });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;

  try {
    const health = await jsonBody(app.request("/api/health"));
    assert.equal(health.ready, true);

    const created = await createSession(app);
    assert.ok(created.sessionId);

    // リプレイではなく、購読中のランがライブ配信されることを見るため先に接続する
    const eventsResponse = await app.request(await eventsUrl(app, created.sessionId, 0));
    assert.equal(eventsResponse.status, 200);
    assert.match(eventsResponse.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(eventsResponse.headers.get("cache-control") || "", /no-transform/);

    const postResponse = await app.request(
      `/api/sessions/${created.sessionId}/messages`,
      jsonPost({ text: "非同期で動いて" }),
    );
    assert.equal(postResponse.status, 202);
    const postBody = await jsonBody(postResponse);
    assert.equal(postBody.queued, false);
    assert.equal(postBody.sessionId, created.sessionId);

    const events = await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "run_end"));
    // ping は状態を持たない生存確認なので、状態の並びを見るときは除く
    const stateEvents = events.filter((entry) => entry.type !== "ping");
    assert.equal(stateEvents[0].type, "run_start");
    assert.equal(stateEvents.at(-1)?.data?.status, "completed");
    const textEvents = events.filter((entry) => entry.type === "text");
    assert.equal(textEvents.map((entry) => entry.data.delta).join(""), "スタブの返答です");

    const listed = await jsonBody(app.request("/api/sessions"));
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].sessionId, created.sessionId);

    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.status, "completed");
    // SDK の message.timestamp が DTO の at へそのまま通ること (リロード後の時刻の正)
    assert.deepEqual(
      payload.messages.map((message: { at?: number }) => message.at),
      pi.sessions[0].messages.map((message) => message.timestamp),
    );

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

test("SSE sends the heartbeat as a visible ping event that does not move the cursor", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    // コメント行 (`:`) は EventSource のイベントにならずクライアントから見えないため、可視イベントで届く
    const eventsResponse = await app.request(await eventsUrl(app, created.sessionId, 0));
    const events = await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "ping"));
    const ping = events.find((entry) => entry.type === "ping");
    assert.equal(ping?.id, null, "id を付けない = Last-Event-ID (差分再開のカーソル) を動かさない");
    assert.deepEqual(ping?.data, {});
  } finally {
    await bff.close();
  }
});

test("projects are created from a new or an existing directory and listed in creation order", async () => {
  const { workspace, dirs, listings } = stubWorkspace();
  // プロジェクトはモデルランタイムに依存しない (pi: null でも登録できる)
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  const { app } = bff;
  try {
    assert.deepEqual(await jsonBody(app.request("/api/projects")), { projects: [] });

    const created = await app.request("/api/projects", jsonPost({ cwd: "proj-a", create: true }));
    assert.equal(created.status, 201);
    const createdBody = await jsonBody(created);
    assert.equal(createdBody.project.cwd, "proj-a");
    assert.equal(createdBody.project.name, "proj-a", "name 省略時は cwd の basename");
    assert.equal(typeof createdBody.project.id, "string");
    assert.equal(typeof createdBody.project.createdAt, "number");
    assert.deepEqual(dirs, ["proj-a"], "create: true はサンドボックスで mkdir する");
    assert.deepEqual(listings, []);

    const existing = await app.request(
      "/api/projects",
      jsonPost({ cwd: "nested/existing/", name: "既存ディレクトリ" }),
    );
    assert.equal(existing.status, 201);
    assert.equal((await jsonBody(existing)).project.cwd, "nested/existing", "cwd は正規化して保存する");
    assert.deepEqual(listings, ["nested/existing"], "create 省略時は一覧取得でディレクトリを確認する");

    const listed = await jsonBody(app.request("/api/projects"));
    assert.deepEqual(
      listed.projects.map((project: { cwd: string; name: string }) => [project.cwd, project.name]),
      [
        ["proj-a", "proj-a"],
        ["nested/existing", "既存ディレクトリ"],
      ],
    );

    // 同じ cwd の二重登録は 409 (サンドボックスへは触らない)
    const duplicate = await app.request("/api/projects", jsonPost({ cwd: "proj-a", create: true }));
    assert.equal(duplicate.status, 409);
    assert.match((await jsonBody(duplicate)).error, /already exists/);
    assert.deepEqual(dirs, ["proj-a"]);
  } finally {
    await bff.close();
  }
});

test("project creation rejects an absolute path, traversal, the workspace root and the app dir", async () => {
  const { workspace, dirs, listings } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  const { app } = bff;
  try {
    for (const cwd of [
      "/etc",
      "../outside",
      "a/../../b",
      "",
      ".",
      ".u7agent",
      ".u7agent/",
      ".u7agent/uploads/x",
      ".u7agent/sessions/abc",
      "./.u7agent",
    ]) {
      const response = await app.request("/api/projects", jsonPost({ cwd }));
      assert.equal(response.status, 400, `cwd=${JSON.stringify(cwd)}`);
    }
    // body の形が違う場合も 400
    assert.equal((await app.request("/api/projects", jsonPost({}))).status, 400);
    assert.equal((await app.request("/api/projects", jsonPost({ cwd: "a", create: "yes" }))).status, 400);

    assert.deepEqual(dirs, []);
    assert.deepEqual(listings, []);
    assert.deepEqual((await jsonBody(app.request("/api/projects"))).projects, []);
  } finally {
    await bff.close();
  }
});

test("project creation relays sandbox failures and answers 503 without a sandbox", async () => {
  const unconfigured = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    const response = await unconfigured.app.request("/api/projects", jsonPost({ cwd: "proj" }));
    assert.equal(response.status, 503);
    assert.match((await jsonBody(response)).error, /PI_SANDBOX_URL/);
  } finally {
    await unconfigured.close();
  }

  // 実在しないディレクトリ (サンドボックスの 404) は文言ごとそのまま返す
  const missing = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: null,
    workspace: {
      previewFile: async () => ({ text: "" }),
      listFiles: async () => {
        throw new SandboxRequestError("Path not found: /workspace/nope", 404);
      },
      listSkills: async () => ({ skills: [] }),
      createDir: async (path: string) => ({ path }),
      // 削除 / リネーム / アップロード / 生配信はこのテストでは扱わない
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
      // ダウンロードはこのテストでは扱わない
      downloadEntry: async () => ({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
        body: null,
      }),
      checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
    },
  });
  try {
    const response = await missing.app.request("/api/projects", jsonPost({ cwd: "nope" }));
    assert.equal(response.status, 404);
    assert.match((await jsonBody(response)).error, /Path not found/);
    assert.deepEqual((await jsonBody(missing.app.request("/api/projects"))).projects, []);
  } finally {
    await missing.close();
  }
});

test("sessions bind to a project and stay when the project is released", async () => {
  const pi = createStubPi({ chunkDelayMs: 40 });
  const { workspace, dirs, listings } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi), workspace });
  const { app } = bff;
  try {
    const project = (await jsonBody(await app.request("/api/projects", jsonPost({ cwd: "proj-a", create: true }))))
      .project;

    // 未所属セッションの cwd は root ("")
    const unaffiliated = await jsonBody(app.request("/api/sessions", jsonPost({})));
    assert.equal(unaffiliated.cwd, "");
    assert.equal(unaffiliated.projectId, undefined);

    const response = await app.request("/api/sessions", jsonPost({ projectId: project.id }));
    assert.equal(response.status, 201);
    const payload = await jsonBody(response);
    assert.equal(payload.projectId, project.id);
    assert.equal(payload.cwd, "proj-a", "payload.cwd は rootCwd 相対");
    assert.equal(pi.createInputs.at(-1)?.cwd, "proj-a", "SDK へも所属プロジェクトの cwd を渡す");

    const listed = await jsonBody(app.request("/api/sessions"));
    const bound = listed.sessions.find((session: { sessionId: string }) => session.sessionId === payload.sessionId);
    const free = listed.sessions.find((session: { sessionId: string }) => session.sessionId === unaffiliated.sessionId);
    assert.equal(bound.projectId, project.id);
    assert.equal("projectId" in free, false, "未所属はキー自体を省略する");

    // 未知の projectId は未所属へ落とさず 400
    const unknown = await app.request("/api/sessions", jsonPost({ projectId: "ghost" }));
    assert.equal(unknown.status, 400);
    assert.match((await jsonBody(unknown)).error, /Project not found/);

    // 実行中のセッションは解除で abort されるが、履歴と record は残る
    await app.request(`/api/sessions/${payload.sessionId}/messages`, jsonPost({ text: "実行中" }));
    const running = pi.sessions.at(-1)!;

    const deleted = await app.request(`/api/projects/${project.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await jsonBody(deleted), { ok: true });

    assert.equal(running.abortRequested, true);
    assert.equal(running.disposed, false, "解除では dispose しない");

    const released = await jsonBody(app.request(`/api/sessions/${payload.sessionId}`));
    assert.equal(released.projectId, undefined, "解除後は未所属として解決される");
    const remaining = await jsonBody(app.request("/api/sessions"));
    assert.deepEqual(
      remaining.sessions.map((session: { sessionId: string }) => session.sessionId).sort(),
      [payload.sessionId, unaffiliated.sessionId].sort(),
      "セッションは残る",
    );
    assert.deepEqual((await jsonBody(app.request("/api/projects"))).projects, []);
    // ディレクトリは触らない (解除でサンドボックスを呼ばない)
    assert.deepEqual(dirs, ["proj-a"]);
    assert.deepEqual(listings, []);

    assert.equal((await app.request(`/api/projects/${project.id}`, { method: "DELETE" })).status, 404);
  } finally {
    await bff.close();
  }
});

test("assistant usage reaches the client through SSE and the session payload", async () => {
  const pi = createStubPi({ chunkDelayMs: 5 });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const eventsResponse = await app.request(await eventsUrl(app, created.sessionId, 0));
    const posted = await app.request(
      `/api/sessions/${created.sessionId}/messages`,
      jsonPost({ text: "usage を見せて" }),
    );
    assert.equal(posted.status, 202);
    const events = await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "run_end"));

    const usageEvents = events.filter((entry) => entry.type === "usage");
    assert.equal(usageEvents.length, 1, "assistant の message_end ごとに 1 件");
    const usageEvent = usageEvents[0];
    assert.deepEqual(usageEvent.data.usage, STUB_USAGE);
    assert.ok(usageEvent.data.metrics.durationMs >= 5, "chunk の遅延が duration に乗る");
    assert.deepEqual(usageEvent.data.context, STUB_CONTEXT_USAGE);
    assert.ok(
      events.indexOf(usageEvent) < events.findIndex((entry) => entry.type === "run_end"),
      "バブルが開いている間に届く",
    );

    // context は SDK の履歴反映後に run_end でも配る (usage の値は 1 応答分古い)
    const runEnd = events.find((entry) => entry.type === "run_end");
    assert.deepEqual(runEnd?.data.context, STUB_CONTEXT_USAGE);

    // リロード / resync の正は payload 側 (同じ値が戻る)
    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.deepEqual(payload.messages.at(-1).usage, STUB_USAGE);
    assert.deepEqual(payload.messages.at(-1).metrics, usageEvent.data.metrics);
    assert.deepEqual(payload.context, STUB_CONTEXT_USAGE);
  } finally {
    await bff.close();
  }
});

test("compaction reaches the client through SSE and stays in the session payload", async () => {
  const pi = createStubPi({ chunkDelayMs: 40 });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const eventsResponse = await app.request(await eventsUrl(app, created.sessionId, 0));
    const posted = await app.request(
      `/api/sessions/${created.sessionId}/messages`,
      jsonPost({ text: "圧縮される会話" }),
    );
    assert.equal(posted.status, 202);
    const seen = collectSse(
      eventsResponse,
      (list) => list.some((entry) => entry.type === "compaction") && list.some((entry) => entry.type === "resync"),
    );
    await pi.sessions[0].compact({
      reason: "threshold",
      summarizeCount: 1,
      summary: "e2e の要約",
      tokensBefore: 42_000,
      estimatedTokensAfter: 8_000,
    });
    const events = await seen;

    const compactionIndex = events.findIndex((entry) => entry.type === "compaction");
    const resyncIndex = events.findIndex((entry) => entry.type === "resync");
    assert.ok(compactionIndex >= 0, "compaction イベントが届く");
    assert.equal(resyncIndex, compactionIndex + 1, "compaction の直後に resync が届く");

    const compactionEvent = events[compactionIndex];
    assert.equal(compactionEvent.data.count, 1);
    assert.equal(compactionEvent.data.compaction.summary, "e2e の要約");
    assert.equal(compactionEvent.data.compaction.reason, "threshold");

    // リロード / 再接続は payload 側を正とする
    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(payload.compactions.length, 1);
    assert.equal(payload.compactions[0].summary, "e2e の要約");
    assert.equal(payload.compactions[0].tokensBefore, 42_000);
    assert.equal(payload.compactions[0].estimatedTokensAfter, 8_000);
    assert.equal(typeof payload.compactions[0].beforeMessageIndex, "number");
    assert.ok(!payload.messages.some((message: { text: string }) => message.text.includes("要約")));
  } finally {
    await bff.close();
  }
});

test("手動圧縮 API は完了まで待って実効状態を返し、実行中は 409 になる", async () => {
  const pi = createStubPi({ chunkDelayMs: 100, manualCompaction: { summary: "手動の要約", tokensBefore: 42_000 } });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const created = await createSession(app);

    const response = await app.request(`/api/sessions/${created.sessionId}/compact`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sessionId: created.sessionId, status: "idle" });

    const payload = await jsonBody(app.request(`/api/sessions/${created.sessionId}`));
    assert.equal(payload.compactions.length, 1);
    assert.equal(payload.compactions[0].summary, "手動の要約");
    assert.equal(payload.compactions[0].reason, "manual");
    assert.equal(payload.compactionStartedAt, undefined, "終端では開始時刻を載せない");

    // 実行中は idle ではないので 409 (キューは POST /messages が担う)
    const posted = await app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "実行中の会話" }));
    assert.equal(posted.status, 202);
    const busy = await app.request(`/api/sessions/${created.sessionId}/compact`, { method: "POST" });
    assert.equal(busy.status, 409);

    const missing = await app.request("/api/sessions/unknown/compact", { method: "POST" });
    assert.equal(missing.status, 404);
  } finally {
    await bff.close();
  }
});

test("server still answers when the pi runtime failed to initialize", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null });
  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, false);

    const response = await bff.app.request("/api/sessions", jsonPost({}));
    assert.equal(response.status, 503);
    const body = await jsonBody(response);
    assert.equal(body.error, "ランタイムを利用できません");
  } finally {
    await bff.close();
  }
});

test("reports missing API-key authentication before creating an unusable session", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
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

test("an empty PI_MODELS whitelist surfaces a whitelist-caused failure", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(
      createStubPi({
        availableModels: [],
        selectedModel: null,
        modelWhitelistExcludesAll: true,
        availabilityError: MODEL_WHITELIST_EMPTY_MESSAGE,
        createSessionRejects: 1,
      }),
    ),
  });
  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, false);
    assert.equal(health.errorCode, "model_whitelist_empty");
    assert.equal(health.error, MODEL_WHITELIST_EMPTY_MESSAGE);
    // 原因が whitelist だと分かる文言を返し、認証エラーとは混同しない
    assert.match(health.error, /PI_MODELS/);
    assert.notEqual(health.errorCode, "authentication_required");
    assert.deepEqual(health.availableModels, []);
    assert.deepEqual(health.modelOptions, []);

    const response = await bff.app.request("/api/sessions", jsonPost({}));
    assert.equal(response.status, 503);
    assert.equal((await jsonBody(response)).error, MODEL_WHITELIST_EMPTY_MESSAGE);
  } finally {
    await bff.close();
  }
});

test("health exposes the model picker options and the app default thinking level", async () => {
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
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

test("health keeps its existing model contract while runtime models expose separate whitelist and availability flags", async () => {
  const catalogOnlyModel = stubModel({
    provider: "stub",
    id: "catalog-only",
    name: "Catalog Only Model",
    reasoning: false,
  });
  const runtimeDiagnostics = deriveRuntimeModelDiagnostics({
    catalog: [STUB_MODEL, STUB_PLAIN_MODEL, catalogOnlyModel],
    available: [STUB_MODEL, STUB_PLAIN_MODEL],
    providerIds: ["stub"],
    authStatuses: new Map([
      ["stub", { configured: true, source: "models_json_command", label: "private command details" }],
    ]),
    whitelist: [{ provider: "stub", id: "stub-model" }],
    requestedModel: { provider: "stub", id: "stub-plain" },
    versions: { piCodingAgent: "0.87.1", piAi: "0.87.1", commitHash: "test-build" },
  });
  const pi = createStubPi({
    runtimeDiagnostics,
    availableModels: [STUB_MODEL],
    selectedModel: STUB_MODEL,
  });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });

  try {
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, true);
    assert.equal(health.model, "stub/stub-model");
    assert.deepEqual(health.availableModels, ["stub/stub-model"]);
    assert.deepEqual(
      health.modelOptions.map(({ name }: { name: string }) => name),
      ["Stub Model"],
    );
    assert.equal(health.defaultThinkingLevel, "medium");
    assert.equal(health.defaultModelError, undefined);
    assert.equal(health.errorCode, undefined);
    assert.equal(health.runtimeDiagnostics.status, "available");
    assert.equal(health.runtimeDiagnostics.availableCount, 2);
    assert.equal(health.runtimeDiagnostics.whitelistCount, 1);
    assert.equal(health.runtimeDiagnostics.piModel.status, "not_in_whitelist");
    assert.equal(health.runtimeDiagnostics.piModel.available, true);
    assert.equal(health.runtimeDiagnostics.piModel.inWhitelist, false);
    assert.ok(!JSON.stringify(health).includes("Catalog Only Model"), "health must not include the full catalog");
    assert.ok(!("models" in health.runtimeDiagnostics), "health diagnostics contain summaries, not model rows");
    assert.ok(!JSON.stringify(health).includes("private command details"));

    const response = await bff.app.request("/api/runtime/models");
    assert.equal(response.status, 200);
    const runtimeModels = await jsonBody(response);
    assert.equal(runtimeModels.catalogCount, 3);
    assert.equal(runtimeModels.whitelistConfigured, true);
    assert.deepEqual(
      runtimeModels.providers[0].models.map(({ id, available, inWhitelist }: any) => [id, available, inWhitelist]),
      [
        ["stub-model", true, true],
        ["stub-plain", true, false],
        ["catalog-only", false, false],
      ],
    );
    assert.deepEqual(runtimeModels.providers[0].auth, {
      configured: true,
      source: "models_json_command",
      environmentVariables: [],
    });
    assert.ok(!JSON.stringify(runtimeModels).includes("private command details"));
  } finally {
    await bff.close();
  }
});

test("runtime models returns a fixed secret-free 503 when the runtime is unavailable", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null });
  try {
    const response = await bff.app.request("/api/runtime/models");
    assert.equal(response.status, 503);
    assert.deepEqual(await jsonBody(response), { error: "ランタイムのモデル情報を取得できません" });
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.runtimeDiagnostics.status, "unavailable");
    assert.equal(health.runtimeDiagnostics.unavailableReason, "runtime_unavailable");
  } finally {
    await bff.close();
  }
});

test("an unusable PI_MODEL keeps ready true and surfaces a default model error", async () => {
  const pi = createStubPi({
    selectedModel: null,
    defaultModelError: "指定された既定モデルは利用できません: stub/ghost",
  });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app, catalog } = bff;
  try {
    const definitionAgent = catalog.createAgent({
      name: "定義ありエージェント",
      model: { provider: "stub", id: "stub-plain" },
      thinkingLevel: "low",
    });

    // 定義の model / thinkingLevel が使われる
    const fromDefinition = await app.request("/api/sessions", jsonPost({ agentId: definitionAgent.id }));
    assert.equal(fromDefinition.status, 201);
    const defined = await jsonBody(fromDefinition);
    assert.equal(defined.model, "stub/stub-plain");
    assert.equal(defined.thinkingLevel, "off", "SDK が非推論モデルの非対応値を補正する");

    // リクエストは項目ごとに定義を上書きする
    const fromRequest = await app.request(
      "/api/sessions",
      jsonPost({
        agentId: definitionAgent.id,
        model: { provider: "stub", id: "stub-model" },
        thinkingLevel: "high",
      }),
    );
    assert.equal(fromRequest.status, 201);
    const requested = await jsonBody(fromRequest);
    assert.equal(requested.model, "stub/stub-model");
    assert.equal(requested.thinkingLevel, "high");
    assert.equal(requested.supportsThinking, true);

    // アプリ既定 (medium) は定義もリクエストも無い項目にだけ使われる。既定のエージェントは
    // ユーザー定義の 1 件目ではなくビルトイン
    const appDefault = await app.request("/api/sessions", jsonPost({}));
    const payload = await jsonBody(appDefault);
    assert.equal(payload.model, "stub/stub-model");
    assert.equal(payload.thinkingLevel, "medium");
    assert.equal(payload.agent.id, "agent-general");

    // 不正な値は SDK 作成前に 400
    const invalidModel = await app.request("/api/sessions", jsonPost({ model: { provider: "stub", id: "ghost" } }));
    assert.equal(invalidModel.status, 400);
    assert.match((await jsonBody(invalidModel)).error, /not available/);

    const invalidLevel = await app.request("/api/sessions", jsonPost({ thinkingLevel: "ultra" }));
    assert.equal(invalidLevel.status, 400);

    const nullModel = await app.request("/api/sessions", jsonPost({ model: null }));
    assert.equal(nullModel.status, 400);
    assert.equal(pi.sessions.length, 3, "400 は SDK 作成まで到達しない");
  } finally {
    await bff.close();
  }
});

test("a session runs on its own model when it differs from the app default", async () => {
  // アプリ既定 (health.model) と会話の実効モデルが違うとき、送信に使うモデルが
  // 会話の選択値から動かないことを検証する。
  const pi = createStubPi({ selectedModel: STUB_MODEL });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const health = await jsonBody(app.request("/api/health"));
    assert.equal(health.model, "stub/stub-model");

    const created = await app.request("/api/sessions", jsonPost({ model: { provider: "stub", id: "stub-plain" } }));
    assert.equal(created.status, 201);
    const session = await jsonBody(created);
    assert.equal(session.model, "stub/stub-plain", "会話の実効モデルは作成時の指定");
    assert.notEqual(session.model, health.model);

    const eventsResponse = await app.request(await eventsUrl(app, session.sessionId, 0));
    const posted = await app.request(
      `/api/sessions/${session.sessionId}/messages`,
      jsonPost({ text: "この会話のモデルで実行して" }),
    );
    assert.equal(posted.status, 202);
    await collectSse(eventsResponse, (list) => list.some((entry) => entry.type === "run_end"));

    // prompt が届いたのは会話の pi セッション (会話のモデル)。health の既定は使われない。
    const runSession = pi.sessions.find((item) => item.sessionId === session.piSessionId);
    assert.ok(runSession, "会話の pi セッションが実行に使われる");
    assert.equal(runSession?.model?.provider, "stub");
    assert.equal(runSession?.model?.id, "stub-plain");
    assert.equal(runSession?.messages[0]?.content, "この会話のモデルで実行して");

    // health / 取得 / 一覧はいずれも既定と会話モデルを混ぜない
    assert.equal((await jsonBody(app.request("/api/health"))).model, "stub/stub-model");
    assert.equal((await jsonBody(app.request(`/api/sessions/${session.sessionId}`))).model, "stub/stub-plain");
    const listed = await jsonBody(app.request("/api/sessions"));
    const listedSession = listed.sessions.find((item: { sessionId: string }) => item.sessionId === session.sessionId);
    assert.equal(listedSession.model, "stub/stub-plain");
  } finally {
    await bff.close();
  }
});

test("chat settings endpoint validates the body and reports missing sessions", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const created = await createSession(app);
    const eventsResponse = await app.request(await eventsUrl(app, created.sessionId, 0));

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
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi({ chunkDelayMs: 40 })),
  });
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null });
  try {
    const missing = await bff.app.request("/api/unknown");
    assert.equal(missing.status, 404);
    assert.deepEqual(await jsonBody(missing), { error: "Not found" });

    const wrongMethod = await bff.app.request("/api/agents/nope", jsonPost({}));
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
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

test("catalog endpoints expose and update agent suggestions", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const initial = await jsonBody(app.request("/api/agents"));
    // ビルトインは別フィールドで返り、ユーザー定義の agents には含まれない。初期状態のユーザー定義はずんだもんだけ
    assert.deepEqual(initial.builtinAgent.suggestions, [
      { label: "プロジェクトを説明して", prompt: "このプロジェクトの構成を簡単に教えて" },
      { label: "テストを確認して", prompt: "まずテストがあるか確認して" },
      { label: "README をレビューして", prompt: "README を読んで改善案を3つ出して" },
    ]);
    assert.deepEqual(
      initial.agents.map((agent: { id: string }) => agent.id),
      ["agent-zundamon"],
    );
    assert.equal(Object.hasOwn(initial.agents[0], "suggestions"), false);

    // suggestions を省略した作成はキーごと落ちる
    const plain = await app.request("/api/agents", jsonPost({ name: "定型なし" }));
    assert.equal(plain.status, 201);
    assert.equal(Object.hasOwn((await jsonBody(plain)).agent, "suggestions"), false);

    // 作成時も正規化して受け付ける
    const created = await app.request(
      "/api/agents",
      jsonPost({ name: "定型あり", suggestions: [{ label: " 押す ", prompt: " 送る " }] }),
    );
    assert.equal(created.status, 201);
    const createdAgent = (await jsonBody(created)).agent;
    assert.deepEqual(createdAgent.suggestions, [{ label: "押す", prompt: "送る" }]);

    const saved = await app.request(
      `/api/agents/${createdAgent.id}`,
      jsonPatch({ suggestions: [{ label: "足した", prompt: "追加のプロンプト" }] }),
    );
    assert.equal(saved.status, 200);
    assert.deepEqual((await jsonBody(saved)).agent.suggestions, [{ label: "足した", prompt: "追加のプロンプト" }]);

    const reloaded = await jsonBody(app.request("/api/agents"));
    assert.deepEqual(reloaded.agents.find((agent: { id: string }) => agent.id === createdAgent.id).suggestions, [
      { label: "足した", prompt: "追加のプロンプト" },
    ]);

    // 空配列で解除すると応答からもキーが消える
    const cleared = await app.request(`/api/agents/${createdAgent.id}`, jsonPatch({ suggestions: [] }));
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn((await jsonBody(cleared)).agent, "suggestions"), false);
    const afterClear = await jsonBody(app.request("/api/agents"));
    assert.equal(
      Object.hasOwn(
        afterClear.agents.find((agent: { id: string }) => agent.id === createdAgent.id),
        "suggestions",
      ),
      false,
    );
  } finally {
    await bff.close();
  }
});

/** PNG / webp の署名だけを持つ data URL (server は署名まで見る)。上限の検証に使う */
function iconDataUrl(mime: "png" | "webp", bytes: number): string {
  const body = Buffer.alloc(bytes, 0);
  if (mime === "png") Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  else {
    body.write("RIFF", 0, "latin1");
    body.write("WEBP", 8, "latin1");
  }
  return `data:image/${mime};base64,${body.toString("base64")}`;
}

test("catalog endpoints round-trip agent icons", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const icon = iconDataUrl("webp", 32);
    const created = await app.request("/api/agents", jsonPost({ name: "アイコンあり", icon }));
    assert.equal(created.status, 201);
    const createdAgent = (await jsonBody(created)).agent;
    assert.equal(createdAgent.icon, icon);

    // GET で取り直しても残る
    const reloaded = await jsonBody(app.request("/api/agents"));
    assert.equal(reloaded.agents.find((agent: { id: string }) => agent.id === createdAgent.id).icon, icon);

    // 形式違いは catalog が 400 で断り、16 KiB 超も 400 で既存値を変えない
    const wrongMime = await app.request(
      `/api/agents/${createdAgent.id}`,
      jsonPatch({ icon: "data:image/svg+xml;base64,PHN2Zy8+" }),
    );
    assert.equal(wrongMime.status, 400);
    assert.equal((await jsonBody(wrongMime)).error, "Icon must be a webp or png data URL");
    const tooLarge = await app.request(
      `/api/agents/${createdAgent.id}`,
      jsonPatch({ icon: iconDataUrl("png", 16 * 1024 + 1) }),
    );
    assert.equal(tooLarge.status, 400);
    assert.equal((await jsonBody(tooLarge)).error, "Icon must be at most 16 KiB");
    const afterReject = await jsonBody(app.request("/api/agents"));
    assert.equal(afterReject.agents.find((agent: { id: string }) => agent.id === createdAgent.id).icon, icon);

    // null で解除すると応答からもキーが消える
    const cleared = await app.request(`/api/agents/${createdAgent.id}`, jsonPatch({ icon: null }));
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn((await jsonBody(cleared)).agent, "icon"), false);
  } finally {
    await bff.close();
  }
});

test("単体の作成は 64 KiB の body 上限に従う", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    // 16 KiB のアイコン 1 件は systemPrompt と同居できる
    const icon = iconDataUrl("png", 16 * 1024);
    const created = await app.request("/api/agents", jsonPost({ name: "1 件", icon }));
    assert.equal(created.status, 201);

    // 上限を超える本文は bodyGuard が検証より先に 413 で断る
    const oversized = await app.request(
      "/api/agents",
      jsonPost({ name: "大きい", icon, systemPrompt: "x".repeat(64 * 1024) }),
    );
    assert.equal(oversized.status, 413);
    assert.equal((await jsonBody(oversized)).error, "Request body is too large");
  } finally {
    await bff.close();
  }
});

test("the built-in agent rejects updates and deletes", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const patched = await app.request("/api/agents/agent-general", jsonPatch({ name: "乗っ取り" }));
    assert.equal(patched.status, 400);
    assert.deepEqual(await jsonBody(patched), { error: "Built-in agent cannot be updated" });

    const deleted = await app.request("/api/agents/agent-general", { method: "DELETE" });
    assert.equal(deleted.status, 400);
    assert.deepEqual(await jsonBody(deleted), { error: "Built-in agent cannot be deleted" });
  } finally {
    await bff.close();
  }
});

test("組み込みスキルはカタログの一覧とスキル一覧の対象外", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const builtinNames = BUILTIN_SKILLS.map((skill) => skill.name);
    const catalog = (await jsonBody(app.request("/api/agents"))) as {
      skills: Array<{ name: string }>;
      builtinSkills: Array<{ name: string; description: string }>;
    };
    // カタログのスキルは 0 件から始まり、組み込みは別フィールドで全件が返る
    assert.deepEqual(catalog.skills, []);
    assert.deepEqual(
      catalog.builtinSkills,
      BUILTIN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description })),
    );
    const skills = (await jsonBody(app.request("/api/skills"))) as { skills: Array<{ name: string }> };
    assert.deepEqual(
      skills.skills.map((skill) => skill.name).filter((name) => builtinNames.includes(name)),
      [],
    );
  } finally {
    await bff.close();
  }
});

test("初期状態はスキル 0 件で、ずんだもんは通常のユーザー定義として削除できる", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    const initial = await jsonBody(app.request("/api/agents"));
    assert.deepEqual(initial.skills, []);
    assert.deepEqual(
      initial.agents.map((agent: { id: string }) => agent.id),
      ["agent-zundamon"],
    );
    assert.match(initial.agents[0].systemPrompt, /なのだ/);
    assert.deepEqual(initial.agents[0].skillIds, []);

    // ビルトインと同じ応答形で返り、DELETE も通常の定義と同じく通る
    const deleted = await app.request("/api/agents/agent-zundamon", { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await jsonBody(deleted), { ok: true });
    assert.deepEqual((await jsonBody(app.request("/api/agents"))).agents, []);

    // セッションの既定はビルトインが担うので、削除後も作成できる
    const created = await app.request("/api/sessions", jsonPost({}));
    assert.equal(created.status, 201);
    assert.equal((await jsonBody(created)).agent.id, "agent-general");
  } finally {
    await bff.close();
  }
});

test("catalog CRUD validates the JSON body shape at the HTTP boundary", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app } = bff;
  try {
    // 作成は client が送る形 (model / thinkingLevel の null と空 suggestions) をそのまま受ける
    const created = await app.request(
      "/api/agents",
      jsonPost({ name: " 型付き ", model: null, thinkingLevel: null, suggestions: [] }),
    );
    assert.equal(created.status, 201);
    const createdAgent = (await jsonBody(created)).agent;
    assert.equal(createdAgent.name, "型付き");
    assert.equal(Object.hasOwn(createdAgent, "model"), false);
    assert.equal(Object.hasOwn(createdAgent, "thinkingLevel"), false);
    const agentPath = `/api/agents/${createdAgent.id}`;

    // PATCH はキー省略で現在値を維持し、null で解除する
    const set = await app.request(
      agentPath,
      jsonPatch({ model: { provider: "stub", id: "stub-model" }, thinkingLevel: "high" }),
    );
    assert.equal(set.status, 200);
    const setAgent = (await jsonBody(set)).agent;
    assert.deepEqual(setAgent.model, { provider: "stub", id: "stub-model" });
    assert.equal(setAgent.thinkingLevel, "high");

    const kept = await app.request(agentPath, jsonPatch({ name: "維持" }));
    assert.equal(kept.status, 200);
    const keptAgent = (await jsonBody(kept)).agent;
    assert.equal(keptAgent.name, "維持");
    assert.deepEqual(keptAgent.model, { provider: "stub", id: "stub-model" });
    assert.equal(keptAgent.thinkingLevel, "high");

    const cleared = await app.request(agentPath, jsonPatch({ model: null, thinkingLevel: null }));
    assert.equal(cleared.status, 200);
    const clearedAgent = (await jsonBody(cleared)).agent;
    assert.equal(Object.hasOwn(clearedAgent, "model"), false);
    assert.equal(Object.hasOwn(clearedAgent, "thinkingLevel"), false);

    // 空 body の PATCH は no-op (bodyGuard が "{}" に置き換える)
    const noop = await app.request(agentPath, jsonPatch({}));
    assert.equal(noop.status, 200);
    assert.deepEqual(await jsonBody(noop), { agent: clearedAgent });

    const noBody = await app.request(agentPath, { method: "PATCH" });
    assert.equal(noBody.status, 200);
    assert.deepEqual(await jsonBody(noBody), { agent: clearedAgent });

    // route は形・型だけを見る。違反は 400 で、必須判定の文言は catalog のまま
    for (const body of [
      { name: 1 },
      { model: "x" },
      { thinkingLevel: "ultra" },
      { suggestions: "x" },
      { skillIds: "x" },
    ]) {
      const invalid = await app.request("/api/agents", jsonPost(body));
      assert.equal(invalid.status, 400, JSON.stringify(body));
      assert.equal((await jsonBody(invalid)).error, "Invalid request body");

      const invalidPatch = await app.request(agentPath, jsonPatch(body));
      assert.equal(invalidPatch.status, 400, JSON.stringify(body));
      assert.equal((await jsonBody(invalidPatch)).error, "Invalid request body");
    }

    const nameless = await app.request("/api/agents", jsonPost({ description: "名前がない" }));
    assert.equal(nameless.status, 400);
    assert.equal((await jsonBody(nameless)).error, "Agent name is required");

    const createdSkill = await app.request(
      "/api/skills",
      jsonPost({ name: "スキル", description: "説明", body: "本文" }),
    );
    assert.equal(createdSkill.status, 201);
    const createdSkillId = (await jsonBody(createdSkill)).skill.id;
    const skillPath = `/api/skills/${createdSkillId}`;

    const updatedSkill = await app.request(skillPath, jsonPatch({ body: "変更後" }));
    assert.equal(updatedSkill.status, 200);
    const updatedSkillBody = await jsonBody(updatedSkill);
    assert.equal(updatedSkillBody.skill.name, "スキル");
    assert.equal(updatedSkillBody.skill.body, "変更後");

    const invalidSkill = await app.request(skillPath, jsonPatch({ body: 1 }));
    assert.equal(invalidSkill.status, 400);
    assert.equal((await jsonBody(invalidSkill)).error, "Invalid request body");

    // 旧フィールド名 prompt は未知キーとして捨てず 400 にする (本文が変わらないまま 200 で成功と誤認させない)
    for (const method of ["PATCH", "PUT"] as const) {
      const legacyPrompt = await app.request(skillPath, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "旧本文" }),
      });
      assert.equal(legacyPrompt.status, 400, method);
      assert.equal((await jsonBody(legacyPrompt)).error, "Invalid request body");
    }
    const skillsAfterLegacy = (await jsonBody(app.request("/api/skills"))) as {
      skills: Array<{ id: string; body: string }>;
    };
    assert.equal(skillsAfterLegacy.skills.find((skill) => skill.id === createdSkillId)?.body, "変更後");

    const bodyless = await app.request("/api/skills", jsonPost({ name: "本文なし" }));
    assert.equal(bodyless.status, 400);
    assert.equal((await jsonBody(bodyless)).error, "Skill name and body are required");
  } finally {
    await bff.close();
  }
});

test("catalog CRUD reads the JSON body whatever the request Content-Type is", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(createStubPi()) });
  const { app, catalog } = bff;
  try {
    const agent = catalog.createAgent({ name: "型テスト用エージェント" });
    const agentPath = `/api/agents/${agent.id}`;
    // fetch は string body に text/plain を補うため、Content-Type 無しはバイト列で送る
    const noContentType = await app.request(agentPath, {
      method: "PATCH",
      body: new TextEncoder().encode(JSON.stringify({ name: "改名" })),
    });
    assert.equal(noContentType.status, 200);
    assert.equal((await jsonBody(noContentType)).agent.name, "改名");

    const textPlain = await app.request(agentPath, {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ description: "説明を変える" }),
    });
    assert.equal(textPlain.status, 200);
    assert.equal((await jsonBody(textPlain)).agent.description, "説明を変える");

    // zValidator の Content-Type 判定では弾かれる形 (セミコロン前の空白)
    const spacedJson = await app.request(agentPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json ; charset=utf-8" },
      body: JSON.stringify({ systemPrompt: "役割を変える" }),
    });
    assert.equal(spacedJson.status, 200);
    assert.equal((await jsonBody(spacedJson)).agent.systemPrompt, "役割を変える");

    const createdSkill = await app.request("/api/skills", jsonPost({ name: "型テスト用スキル", body: "元の本文" }));
    assert.equal(createdSkill.status, 201);
    const skillPath = `/api/skills/${(await jsonBody(createdSkill)).skill.id}`;
    const skill = await app.request(skillPath, {
      method: "PATCH",
      body: new TextEncoder().encode(JSON.stringify({ body: "本文を変える" })),
    });
    assert.equal(skill.status, 200);
    assert.equal((await jsonBody(skill)).skill.body, "本文を変える");

    // 形・型の検証も Content-Type に依らない
    const invalid = await app.request(agentPath, {
      method: "PATCH",
      body: new TextEncoder().encode(JSON.stringify({ name: 1 })),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await jsonBody(invalid)).error, "Invalid request body");

    // 壊れた JSON は Content-Type に関係なく 400 (無しはバイト列で送る)
    const brokenBodies = [
      { headers: {}, body: new TextEncoder().encode("{oops") },
      { headers: { "Content-Type": "text/plain" }, body: "{oops" },
      { headers: { "Content-Type": "application/json" }, body: "{oops" },
    ];
    for (const broken of brokenBodies) {
      const response = await app.request(agentPath, { method: "PATCH", ...broken });
      assert.equal(response.status, 400, JSON.stringify(broken.headers));
      assert.equal((await jsonBody(response)).error, "Request body must be valid JSON");
    }

    const unchanged = await jsonBody(app.request("/api/agents"));
    assert.equal(
      unchanged.agents.find((item: { id: string }) => item.id === agent.id).name,
      "改名",
      "400 は body を適用しない",
    );
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
    sessionStoreDir: null,
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, clientDistDir: emptyDir });
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

async function collectSse(
  response: Response,
  predicate: (events: ParsedSseEvent[]) => boolean,
  timeoutMs = 5000,
): Promise<ParsedSseEvent[]> {
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
    if (line.startsWith("id:")) {
      // id は `<generation>:<seq>` (世代は別途 resync で判定する)
      const raw = line.slice(3).trim();
      id = Number(raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw);
    } else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!type) return null;
  return { id, type, data: data ? JSON.parse(data) : null };
}
