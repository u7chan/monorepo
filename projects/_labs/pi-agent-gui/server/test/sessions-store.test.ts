import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { SessionStore } from "../src/sessions";
import type { PiSessionLike } from "../src/sessions";
import type { EventEntry } from "../src/schema";
import {
  createStubPi,
  waitFor,
} from "./stub-pi";

test("runs a message in the background and records the conversation history", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 5 }), catalog });
  const record = await store.create({ agentId: "agent-cat" });

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
  const record = await store.create({ agentId: "agent-cat" });
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
  await store.create({ agentId: "agent-cat" });
  assert.equal(pi.createInputs.at(-1)?.model, undefined, "モデル未指定ならランタイムへ委ねる");
  assert.equal(pi.createInputs.at(-1)?.thinkingLevel, undefined);

  await store.close();
});

test("keeps the agent snapshot of each chat after definition edits and deletes", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-cat" });
  const before = store.payload(record).agent;
  const summaryBefore = store.summary(record);

  catalog.updateAgent("agent-cat", { name: "別の名前", description: "別の説明" });
  catalog.removeAgent("agent-cat");

  assert.deepEqual(store.payload(record).agent, before);
  assert.equal(store.summary(record).agentName, summaryBefore.agentName);
  assert.equal(store.summary(record).agentId, "agent-cat");

  // 新規チャットは新しい定義を使う
  const next = await store.create({ agentId: "agent-builder" });
  assert.equal(store.payload(next).agent?.name, "実装パートナー");

  await store.close();
});

test("model-only change keeps the effective effort, then SDK clamping wins", async () => {
  const catalog = createAgentCatalog();
  const pi = createStubPi();
  const store = new SessionStore({ pi, catalog });
  const record = await store.create({ agentId: "agent-cat", thinkingLevel: "low" });
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
  const record = await store.create({ agentId: "agent-cat" });
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
  const record = await store.create({ agentId: "agent-cat", thinkingLevel: "low" });

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
  const record = await store.create({ agentId: "agent-cat" });

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
  const record = await store.create({ agentId: "agent-cat", thinkingLevel: "low" });

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
  const record = await store.create({ agentId: "agent-cat" });

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
  const record = await store.create({ agentId: "agent-cat" });

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
