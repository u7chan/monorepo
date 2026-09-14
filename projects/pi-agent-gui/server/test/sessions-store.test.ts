import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_REQUIRED_MESSAGE } from "../src/agent";
import { createAgentCatalog } from "../src/agents";
import { ProjectStore } from "../src/projects";
import { computeMessageMetrics, SessionStore } from "../src/sessions";
import type { PiSessionLike } from "../src/sessions";
import type { ContextUsage, EventEntry, Usage } from "../src/schema";
import {
  createStubPi,
  STUB_CONTEXT_USAGE,
  STUB_USAGE,
  type StubSession,
  waitFor,
} from "./stub-pi";

test("runs a message in the background and records the conversation history", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 5 }), catalog });
  const record = await store.create({ agentId: "agent-general" });

  const result = store.postMessage(record, "こんにちは");
  assert.equal(result.queued, false);
  assert.equal(store.statusOf(record), "running", "the run must keep going without any subscriber");

  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const payload = store.payload(record);
  assert.equal(payload.status, "completed");
  assert.deepEqual(
    payload.messages.map((message) => [message.role, message.text]),
    [["user", "こんにちは"], ["assistant", "スタブの返答です"]],
  );
  assert.equal(payload.title, "こんにちは");
  assert.ok(payload.lastSeq > 0);

  const allEvents: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => allEvents.push(entry));
  const types = allEvents.map((entry) => entry.type);
  assert.ok(types.includes("run_start"));
  assert.ok(types.includes("text"));
  assert.ok(types.includes("run_end"));
  const runEnd = allEvents.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.data.status, "completed");

  // A client at the latest cursor receives no replay.
  const fresh: typeof allEvents = [];
  store.subscribe(record, payload.lastSeq, (entry) => fresh.push(entry));
  assert.equal(fresh.length, 0);

  await store.close();
});

test("messages posted during a run are queued and executed sequentially", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 20 }), catalog });
  const record = await store.create({ agentId: "agent-builder" });

  const first = store.postMessage(record, "1つ目");
  assert.equal(first.queued, false);
  const second = store.postMessage(record, "2つ目");
  assert.equal(second.queued, true);
  assert.equal(second.queueDepth, 1);
  const third = store.postMessage(record, "3つ目");
  assert.equal(third.queueDepth, 2);
  assert.equal(store.statusOf(record), "running");

  await waitFor(
    () => record.session.messages.filter((message) => message.role === "user").length === 3,
    5000,
    "all queued messages to run",
  );
  await waitFor(() => store.statusOf(record) === "completed", 5000, "final completion");

  const userTexts = record.session.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  assert.deepEqual(userTexts, ["1つ目", "2つ目", "3つ目"]);
  const queuedEvents: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => queuedEvents.push(entry));
  assert.equal(queuedEvents.filter((entry) => entry.type === "queued").length, 2);

  await store.close();
});

test("stop aborts the active run and clears the queue", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 50 }), catalog });
  const record = await store.create({ agentId: "agent-builder" });

  store.postMessage(record, "止まるメッセージ");
  store.postMessage(record, "キャンセルされるメッセージ");
  assert.equal(record.queue.length, 1);

  const stopResult = await store.stop(record);
  assert.equal(stopResult.ok, true);

  await waitFor(() => store.statusOf(record) === "stopped", 3000, "stopped status");
  assert.equal(record.queue.length, 0, "queued messages are dropped on stop");

  const events: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => events.push(entry));
  const runEnd = events.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.data.status, "stopped");

  // The session can still accept new work afterwards.
  store.postMessage(record, "次のメッセージ");
  await waitFor(() => store.statusOf(record) === "completed", 5000, "recovery run");
  assert.equal(store.payload(record).messages.at(-1)?.text, "スタブの返答です");

  await store.close();
});

test("destroy aborts, disposes and notifies subscribers", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 30 }), catalog });
  const record = await store.create({ agentId: "agent-general" });
  store.postMessage(record, "削除される会話");

  const seen: EventEntry[] = [];
  let closed = false;
  const unsubscribe = store.subscribe(
    record,
    undefined,
    (entry) => seen.push(entry),
    () => {
      closed = true;
    },
  );

  await store.destroy(record);
  assert.equal(store.get(record.id), undefined);
  assert.ok(record.session.disposed);
  assert.equal(closed, true);
  assert.equal(seen.at(-1)?.type, "session_deleted");
  unsubscribe();

  await store.close();
});

test("projects resolve the session cwd and are reported as a root-relative path", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const projects = new ProjectStore();
  const project = projects.create({ cwd: "nested/proj" });
  const store = new SessionStore({ pi, catalog, projects });

  const unaffiliated = await store.create({ agentId: "agent-general" });
  assert.equal(pi.createInputs.at(-1)?.cwd, "", "未所属は root を渡す");
  assert.equal(store.payload(unaffiliated).cwd, "");
  assert.equal("projectId" in store.payload(unaffiliated), false);
  assert.equal("projectId" in store.summary(unaffiliated), false);

  const record = await store.create({ agentId: "agent-general", projectId: project.id });
  assert.equal(pi.createInputs.at(-1)?.cwd, "nested/proj");
  assert.equal(record.projectId, project.id);
  assert.equal(store.payload(record).cwd, "nested/proj");
  assert.equal(store.payload(record).projectId, project.id);
  assert.equal(store.summary(record).projectId, project.id);

  // 未知の projectId は未所属へ落とさず 400
  await assert.rejects(
    () => store.create({ agentId: "agent-general", projectId: "ghost" }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Project not found/);
      return true;
    },
  );
  assert.equal(pi.sessions.length, 2, "400 のセッションは作らない");

  await store.close();
});

test("create rejects a project that disappears while the runtime is creating the session", async () => {
  // create() は resolveProject() の後で await pi.createSession() を挟むため、その間に
  // DELETE /api/projects/:id (remove + destroyByProject) が走ると破棄対象のスナップショットに載らない。
  // 登録直前の再確認で孤児を残さず 400 にすることを固定する。
  const catalog = createAgentCatalog();
  const projects = new ProjectStore();
  const project = projects.create({ cwd: "proj-a" });
  const base = createStubPi();
  let releaseCreate: () => void = () => {};
  const creating = new Promise<void>((resolveCreate) => {
    releaseCreate = resolveCreate;
  });
  let started = false;
  const pi = {
    ...base,
    createSession: async (input: Parameters<typeof base.createSession>[0] = {}) => {
      started = true;
      await creating;
      return base.createSession(input);
    },
  };
  const store = new SessionStore({ pi, catalog, projects });

  const pending = store.create({ agentId: "agent-general", projectId: project.id });
  await waitFor(() => started, 3000, "runtime session creation started");

  // セッション作成中にプロジェクトを削除する (destroyByProject にはこのセッションが見えていない)
  projects.remove(project.id);
  await store.destroyByProject(project.id);
  releaseCreate();

  await assert.rejects(pending, (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /Project not found/);
    return true;
  });
  assert.equal(store.size, 0, "削除済みプロジェクトを参照するセッションを登録しない");
  assert.deepEqual(store.list(), []);

  const created = base.sessions.at(-1) as StubSession;
  await waitFor(() => created.disposed === true, 3000, "created session disposal");
  assert.equal(created.disposed, true, "作成済みの SDK セッションは dispose する");

  await store.close();
});

test("destroyByProject aborts, disposes and notifies only its own sessions", async () => {
  const catalog = createAgentCatalog();
  const projects = new ProjectStore();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 30 }), catalog, projects });
  const project = projects.create({ cwd: "proj-a" });
  const other = projects.create({ cwd: "proj-b" });

  const target = await store.create({ agentId: "agent-general", projectId: project.id });
  const sibling = await store.create({ agentId: "agent-general", projectId: other.id });
  const unaffiliated = await store.create({ agentId: "agent-general" });
  store.postMessage(target, "破棄される実行");

  const seen: EventEntry[] = [];
  let closed = false;
  store.subscribe(
    target,
    undefined,
    (entry) => seen.push(entry),
    () => {
      closed = true;
    },
  );

  await store.destroyByProject(project.id);

  const stub = target.session as StubSession;
  assert.equal(store.get(target.id), undefined);
  assert.equal(stub.disposed, true);
  assert.equal(stub.abortRequested, true, "実行中は abort する");
  assert.equal(closed, true, "購読中の接続も閉じる");
  assert.equal(seen.at(-1)?.type, "session_deleted");
  // 他のプロジェクトと未所属のセッションは残る
  assert.equal(store.get(sibling.id), sibling);
  assert.equal(store.get(unaffiliated.id), unaffiliated);
  assert.equal(sibling.session.disposed, false);

  await store.close();
});

test("resolves model and thinking level per field: request → definition → app default", async () => {
  const catalog = createAgentCatalog();
  catalog.updateAgent("agent-builder", {
    model: { provider: "stub", id: "stub-plain" },
    thinkingLevel: "low",
  });
  const pi = createStubPi({ defaultThinkingLevel: "medium" });
  const store = new SessionStore({ pi, catalog });

  // 定義のみ: 定義の model / thinkingLevel が SDK へ渡る
  const fromDefinition = await store.create({ agentId: "agent-builder" });
  assert.deepEqual(pi.createInputs.at(-1)?.model, { provider: "stub", id: "stub-plain" });
  assert.equal(pi.createInputs.at(-1)?.thinkingLevel, "low");
  assert.equal(store.payload(fromDefinition).model, "stub/stub-plain");

  // リクエストが定義より優先され、項目ごとに独立して解決される
  await store.create({
    agentId: "agent-builder",
    model: { provider: "stub", id: "stub-model" },
    // thinkingLevel は指定しない → 定義の low を維持
  });
  assert.deepEqual(pi.createInputs.at(-1)?.model, { provider: "stub", id: "stub-model" });
  assert.equal(pi.createInputs.at(-1)?.thinkingLevel, "low");

  // Model 未指定 + Effort だけ指定
  await store.create({ agentId: "agent-builder", thinkingLevel: "high" });
  assert.deepEqual(pi.createInputs.at(-1)?.model, { provider: "stub", id: "stub-plain" });
  assert.equal(pi.createInputs.at(-1)?.thinkingLevel, "high");

  // 定義に model がある場合はアプリ既定へフォールバックしない
  await store.create({ agentId: "agent-general" });
  assert.equal(pi.createInputs.at(-1)?.model, undefined, "モデル未指定ならランタイムへ委ねる");
  assert.equal(pi.createInputs.at(-1)?.thinkingLevel, undefined);

  await store.close();
});

test("keeps the agent snapshot of each chat after definition edits and deletes", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general" });
  const before = store.payload(record).agent;
  const summaryBefore = store.summary(record);

  catalog.updateAgent("agent-general", { name: "別の名前", description: "別の説明" });
  catalog.removeAgent("agent-general");

  assert.deepEqual(store.payload(record).agent, before);
  assert.equal(store.summary(record).agentName, summaryBefore.agentName);
  assert.equal(store.summary(record).agentId, "agent-general");

  // 新規チャットは新しい定義を使う
  const next = await store.create({ agentId: "agent-builder" });
  assert.equal(store.payload(next).agent?.name, "コード実装");

  await store.close();
});

test("model-only change keeps the effective effort, then SDK clamping wins", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general", thinkingLevel: "low" });
  assert.equal(record.session.thinkingLevel, "low");

  // 推論対応モデルへの変更: 変更前の low を再適用する (SDK の切替既定に任せない)
  const payload = await store.updateSettings(record, {
    model: { provider: "stub", id: "stub-model" },
  });
  assert.equal(payload.model, "stub/stub-model");
  assert.equal(payload.thinkingLevel, "low");
  assert.equal((record.session as unknown as { modelSwitchDefault: string }).modelSwitchDefault, "medium");

  // 非推論モデルへ変更: SDK 補正後の off が実効値になる
  const plain = await store.updateSettings(record, { model: { provider: "stub", id: "stub-plain" } });
  assert.equal(plain.model, "stub/stub-plain");
  assert.equal(plain.thinkingLevel, "off");
  assert.equal(plain.supportsThinking, false);
  assert.deepEqual(plain.availableThinkingLevels, ["off"]);

  // 推論モデルへ戻し、要求 Effort も同時に指定する
  const both = await store.updateSettings(record, {
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "high",
  });
  assert.equal(both.thinkingLevel, "high");
  assert.equal(both.supportsThinking, true);
  assert.ok(both.availableThinkingLevels?.includes("high"));

  // Effort のみの変更も反映される
  const effortOnly = await store.updateSettings(record, { thinkingLevel: "minimal" });
  assert.equal(effortOnly.thinkingLevel, "minimal");
  assert.equal(effortOnly.model, "stub/stub-model");

  await store.close();
});

test("settings change keeps session identity, history and title, and leaves others untouched", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ chunkDelayMs: 0 });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general" });
  const other = await store.create({ agentId: "agent-builder" });

  store.postMessage(record, "タイトルになるメッセージ");
  await waitFor(() => store.statusOf(record) === "completed");
  const before = store.payload(record);

  const after = await store.updateSettings(record, { thinkingLevel: "high" });

  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.piSessionId, before.piSessionId);
  assert.equal(after.title, before.title);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(store.payload(other).model, "stub/stub-model");
  assert.equal(store.payload(other).thinkingLevel, "medium");
  assert.equal(store.list().length, 2);

  await store.close();
});

test("rejects an unavailable model and keeps the effective values unchanged", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general", thinkingLevel: "low" });

  await assert.rejects(
    () => store.updateSettings(record, { model: { provider: "stub", id: "ghost" } }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /not available/);
      return true;
    },
  );
  assert.equal(store.payload(record).model, "stub/stub-model");
  assert.equal(store.payload(record).thinkingLevel, "low");
  assert.equal(record.changingSettings, false, "the guard is released after a validation error");

  await store.close();
});

test("rejects settings changes while running, queued or not idle", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ chunkDelayMs: 40 });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general" });

  store.postMessage(record, "実行中");
  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "high" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );
  assert.equal(record.session.thinkingLevel, "medium");

  store.postMessage(record, "キュー待ち");
  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "high" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );

  await store.stop(record);
  await waitFor(() => store.statusOf(record) === "stopped", 3000, "stopped");

  // ランは無いが SDK が非 idle の場合も 409
  Object.defineProperty(record.session, "isIdle", { value: false, configurable: true });
  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "high" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );
  Object.defineProperty(record.session, "isIdle", { value: true, configurable: true });

  await store.close();
});

test("reserves the change synchronously and rejects concurrent sends and changes", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ setModelDelayMs: 60 });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general", thinkingLevel: "low" });

  const changing = store.updateSettings(record, { model: { provider: "stub", id: "stub-model" } });
  assert.equal(record.changingSettings, true, "the flag is reserved before the async setModel");

  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "max" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );
  assert.throws(
    () => store.postMessage(record, "設定変更中の送信"),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );

  const payload = await changing;
  assert.equal(record.changingSettings, false, "the guard is released after the change");
  assert.equal(payload.thinkingLevel, "low");

  store.postMessage(record, "解除後の送信");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "post-change run");

  await store.close();
});

test("releases the guard when the SDK change fails", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ setModelFailures: 1 });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general" });

  await assert.rejects(
    () => store.updateSettings(record, { model: { provider: "stub", id: "stub-plain" } }),
    /No API key/,
  );
  assert.equal(record.changingSettings, false);

  // 失敗後も変更を受け付ける
  const payload = await store.updateSettings(record, { model: { provider: "stub", id: "stub-plain" } });
  assert.equal(payload.model, "stub/stub-plain");

  await store.close();
});

test("emits a resync event with the effective values on settings change", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-general" });

  const seen: EventEntry[] = [];
  store.subscribe(record, record.seq, (entry) => seen.push(entry));

  const payload = await store.updateSettings(record, { thinkingLevel: "high" });
  const resync = seen.find((entry) => entry.type === "resync");
  assert.ok(resync, "a resync event is recorded");
  assert.equal(resync.data.lastSeq, payload.lastSeq);
  assert.equal(resync.data.thinkingLevel, "high");
  assert.equal(resync.seq, payload.lastSeq, "resync data carries its own seq for cursors");

  await store.close();
});

test("maps the SDK message timestamp to the payload at field", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi(), catalog });
  const record = await store.create({ agentId: "agent-general" });

  record.session.messages.push({ role: "user", content: "時刻のある履歴", timestamp: 1700000000000 });
  const payload = store.payload(record);
  assert.equal(payload.messages.at(-1)?.at, 1700000000000);

  await store.close();
});

test("omits the at key for histories without a timestamp", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi(), catalog });
  const record = await store.create({ agentId: "agent-general" });

  record.session.messages.push({ role: "user", content: "時刻の無い履歴" });

  const payload = store.payload(record);
  assert.equal(Object.hasOwn(payload.messages[0], "at"), false, "at must be absent, not null/undefined");

  await store.close();
});

// --- 応答メタ情報 ---

test("derives the response metrics from the observed event times", () => {
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 1000, firstTokenAt: 1900, endedAt: 2800, outputTokens: 45 }),
    { durationMs: 1800, ttftMs: 900, tokensPerSecond: 50 },
  );

  // スパンが 0 以下なら全体の duration で割る
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 1000, firstTokenAt: 2000, endedAt: 2000, outputTokens: 20 }),
    { durationMs: 1000, ttftMs: 1000, tokensPerSecond: 20 },
  );

  // duration も 0 なら tok/s は出さない (ゼロ除算や Infinity を配信しない)
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 1000, firstTokenAt: 1000, endedAt: 1000, outputTokens: 20 }),
    { durationMs: 0, ttftMs: 0 },
  );

  // delta を 1 度も観測していない (非ストリーミング) メッセージは TTFT 無しで平均を出す
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 1000, firstTokenAt: undefined, endedAt: 2000, outputTokens: 30 }),
    { durationMs: 1000, tokensPerSecond: 30 },
  );

  // usage が無い / 0 のときは tok/s を出さない
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 0, firstTokenAt: 500, endedAt: 1500, outputTokens: 0 }),
    { durationMs: 1500, ttftMs: 500 },
  );
  assert.deepEqual(
    computeMessageMetrics({ startedAt: 0, firstTokenAt: 500, endedAt: 1500, outputTokens: undefined }),
    { durationMs: 1500, ttftMs: 500 },
  );

  // message_start を観測していないときは何も出さない
  assert.equal(
    computeMessageMetrics({ startedAt: undefined, firstTokenAt: 10, endedAt: 20, outputTokens: 5 }),
    undefined,
  );
});

test("emits usage per assistant message and keeps it in the payload for resync", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 5 }), catalog });
  const record = await store.create({ agentId: "agent-general" });
  const events: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => events.push(entry));

  store.postMessage(record, "usage を見せて");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const types = events.map((entry) => entry.type);
  const usageEvent = events.find((entry) => entry.type === "usage");
  assert.ok(usageEvent, "assistant の message_end で usage を 1 件出す");
  assert.equal(types.filter((type) => type === "usage").length, 1);
  assert.ok(types.indexOf("usage") < types.indexOf("run_end"), "バブルが開いている間に届く");

  assert.deepEqual(usageEvent.data.usage, STUB_USAGE);
  assert.ok(usageEvent.data.metrics, "BFF 計測の応答時間が入る");
  assert.ok(usageEvent.data.metrics.durationMs >= 5, "chunk の遅延が duration に乗る");
  assert.ok((usageEvent.data.metrics.ttftMs ?? -1) >= 0, "最初の delta で TTFT を記録する");
  assert.ok((usageEvent.data.metrics.tokensPerSecond ?? 0) > 0, "output トークンから tok/sを出す");
  assert.deepEqual(usageEvent.data.context, STUB_CONTEXT_USAGE);

  // リロード / 再接続の正になる payload にも同じ値が乗る
  const payload = store.payload(record);
  assert.deepEqual(payload.context, STUB_CONTEXT_USAGE);
  const assistant = payload.messages.at(-1);
  assert.deepEqual(assistant?.usage, STUB_USAGE);
  assert.deepEqual(assistant?.metrics, usageEvent.data.metrics);
  assert.equal(payload.messages[0]?.usage, undefined, "user メッセージには載せない");

  await store.close();
});

test("omits usage and context keys the SDK does not report, keeping the BFF metrics", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ usage: null, contextUsage: null }), catalog });
  const record = await store.create({ agentId: "agent-general" });
  const events: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => events.push(entry));

  store.postMessage(record, "usage 非対応のプロバイダ");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  // usage が無くても BFF が測った応答時間は出す (0 と偽らない)
  const usageEvent = events.find((entry) => entry.type === "usage");
  assert.ok(usageEvent);
  assert.equal(usageEvent.data.usage, undefined);
  assert.equal(usageEvent.data.context, undefined);
  assert.ok(usageEvent.data.metrics);
  assert.equal(usageEvent.data.metrics.tokensPerSecond, undefined, "output が無いので tok/s も出さない");

  // 契約は「未報告ならキーを省略」。null や 0 に置き換えない
  const payload = store.payload(record);
  const assistant = payload.messages.at(-1);
  assert.equal(Object.hasOwn(assistant ?? {}, "usage"), false);
  assert.equal(Object.hasOwn(assistant ?? {}, "metrics"), true, "BFF 計測の応答時間は載る");
  assert.equal(Object.hasOwn(payload, "context"), false);

  await store.close();
});

test("delivers the context again after the SDK has added the message to its history", async () => {
  const catalog = createAgentCatalog();
  // compaction 直後: message_end の時点では SDK がまだ今回の応答を履歴へ入れていないので不明値
  const beforeHistory: ContextUsage = { tokens: null, contextWindow: 128_000, percent: null };
  const afterHistory: ContextUsage = { tokens: 120, contextWindow: 128_000, percent: 0.1 };
  const store = new SessionStore({
    pi: createStubPi({ chunkDelayMs: 5, contextUsage: afterHistory, contextUsageBeforeHistory: beforeHistory }),
    catalog,
  });
  const record = await store.create({ agentId: "agent-general" });
  const events: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => events.push(entry));

  store.postMessage(record, "compaction 直後の応答");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const usageEvent = events.find((entry) => entry.type === "usage");
  const runEnd = events.find((entry) => entry.type === "run_end");
  assert.ok(usageEvent && runEnd);
  assert.deepEqual(usageEvent.data.context, beforeHistory, "usage は SDK の履歴反映前なので不明値");
  // ここで確定値を配らないと、クライアントはリロードするまでゲージを ? のままにする
  assert.deepEqual(runEnd.data.context, afterHistory, "run_end は履歴反映後の値を配る");
  assert.deepEqual(store.payload(record).context, afterHistory, "payload も同じ値");

  await store.close();
});

test("keeps a reported zero usage as is and tolerates a post-compaction context", async () => {
  const catalog = createAgentCatalog();
  const zeroUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const compacted: ContextUsage = { tokens: null, contextWindow: 128_000, percent: null };
  const store = new SessionStore({
    pi: createStubPi({ usage: zeroUsage, contextUsage: compacted }),
    catalog,
  });
  const record = await store.create({ agentId: "agent-general" });

  store.postMessage(record, "0 の usage");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const payload = store.payload(record);
  assert.deepEqual(payload.messages.at(-1)?.usage, zeroUsage, "報告された 0 はそのまま通す (表示側が隠す)");
  assert.deepEqual(payload.context, compacted, "compaction 直後の null でも壊れない");

  await store.close();
});

test("normalizes the run error at the settlement callers, including falsy thrown values", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi(), catalog });
  const record = await store.create({ agentId: "agent-general" });

  // 正規化は例外を受け取った境界で行い、status の判定も正規化後の文字列で決める。
  // 空メッセージの Error / throw "" はエラー無し、throw された falsy な値は文言化してエラーになる。
  const cases: Array<{ thrown: unknown; status: "completed" | "error"; error?: string }> = [
    { thrown: new Error(), status: "completed" },
    { thrown: "", status: "completed" },
    { thrown: undefined, status: "error", error: "undefined" },
    { thrown: null, status: "error", error: "null" },
    { thrown: 0, status: "error", error: "0" },
    { thrown: new Error("モデルの実行に失敗しました"), status: "error", error: "モデルの実行に失敗しました" },
    { thrown: new Error("No API key found"), status: "error", error: AUTH_REQUIRED_MESSAGE },
  ];

  for (const { thrown, status, error } of cases) {
    record.session.prompt = async () => {
      throw thrown;
    };
    store.postMessage(record, "エラー経路");
    await waitFor(() => store.statusOf(record) === status, 3000, `run status of ${String(thrown)}`);
    const run = store.payload(record).run;
    assert.equal(run?.status, status);
    assert.equal(run?.error, error);
  }

  await store.close();
});
