// 設定変更の応答適用の回帰テスト。
//
// PATCH /settings の応答や回復 GET を待っている間に、サイドバーで別の
// セッションへ切り替えられる。遅延した応答が返っても、切替後のセッションの
// 表示 (履歴 / Model / Effort / lastSeq / 活動表示) を上書きしないことを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { applySettingsChange, type SettingsChangeDeps } from "../src/hooks/settingsChange";
import type { SessionPayload } from "../src/types";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function payload(sessionId: string, thinkingLevel = "low"): SessionPayload {
  return {
    sessionId,
    piSessionId: `pi-${sessionId}`,
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    queueDepth: 0,
    lastSeq: 1,
    run: null,
    messages: [],
    thinkingLevel,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを進めて、await 中の処理を進める */
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

function createHarness() {
  let current = SESSION_A;
  const record = {
    applied: [] as SessionPayload[],
    recovered: [] as string[],
    errors: [] as unknown[],
    successes: 0,
    requests: [] as Array<{ sessionId: string; selection: { thinkingLevel?: string } }>,
  };
  const deps = (overrides: Partial<SettingsChangeDeps> = {}): SettingsChangeDeps => ({
    isCurrentSession: () => current === SESSION_A,
    request: async (sessionId, selection) => {
      record.requests.push({ sessionId, selection });
      return payload(sessionId);
    },
    recover: async (sessionId) => {
      record.recovered.push(sessionId);
      return payload(sessionId, "medium");
    },
    applyPayload: (next) => {
      record.applied.push(next);
    },
    onSuccess: () => {
      record.successes += 1;
    },
    onError: (error) => {
      record.errors.push(error);
    },
    ...overrides,
  });
  return {
    record,
    deps,
    switchTo: (sessionId: string) => {
      current = sessionId;
    },
  };
}

test("applies the response when the same session is still selected", async () => {
  const harness = createHarness();
  await applySettingsChange(SESSION_A, { thinkingLevel: "high" }, harness.deps());

  assert.deepEqual(harness.record.requests, [
    { sessionId: SESSION_A, selection: { thinkingLevel: "high" } },
  ]);
  assert.equal(harness.record.applied.length, 1);
  assert.equal(harness.record.applied[0].sessionId, SESSION_A);
  assert.equal(harness.record.successes, 1);
  assert.deepEqual(harness.record.errors, []);
});

test("discards a delayed success response after switching to another session", async () => {
  const harness = createHarness();
  const response = deferred<SessionPayload>();
  const running = applySettingsChange(
    SESSION_A,
    { thinkingLevel: "high" },
    harness.deps({ request: () => response.promise }),
  );

  // サイドバーで B を選択し、その GET が完了してから A の応答が返る
  harness.switchTo(SESSION_B);
  response.resolve(payload(SESSION_A, "high"));
  await running;

  assert.deepEqual(harness.record.applied, [], "B の表示を A の応答で上書きしない");
  assert.equal(harness.record.successes, 0);
  assert.deepEqual(harness.record.errors, []);
});

test("recovers the server state and reports the error when the same session is still selected", async () => {
  const harness = createHarness();
  const response = deferred<SessionPayload>();
  const running = applySettingsChange(
    SESSION_A,
    { thinkingLevel: "high" },
    harness.deps({ request: () => response.promise }),
  );

  const failure = new Error("Invalid session settings");
  response.reject(failure);
  await running;

  assert.deepEqual(harness.record.recovered, [SESSION_A]);
  assert.equal(harness.record.applied.length, 1);
  assert.equal(harness.record.applied[0].thinkingLevel, "medium", "回復 GET の実効値を表示する");
  assert.equal(harness.record.successes, 0);
  assert.deepEqual(harness.record.errors, [failure]);
});

test("discards a delayed failure response after switching to another session", async () => {
  const harness = createHarness();
  const response = deferred<SessionPayload>();
  const running = applySettingsChange(
    SESSION_A,
    { thinkingLevel: "high" },
    harness.deps({ request: () => response.promise }),
  );

  harness.switchTo(SESSION_B);
  response.reject(new Error("Invalid session settings"));
  await running;

  assert.deepEqual(harness.record.applied, [], "B の表示を A の回復 GET で上書きしない");
  assert.deepEqual(harness.record.recovered, [], "切替済みなら回復 GET も投げない");
  assert.deepEqual(harness.record.errors, [], "切替後の活動表示を失敗で汚さない");
});

test("discards a recovery response that races with a session switch", async () => {
  const harness = createHarness();
  const response = deferred<SessionPayload>();
  const recovery = deferred<SessionPayload>();
  const running = applySettingsChange(
    SESSION_A,
    { thinkingLevel: "high" },
    harness.deps({
      request: () => response.promise,
      recover: () => {
        harness.record.recovered.push(SESSION_A);
        return recovery.promise;
      },
    }),
  );

  response.reject(new Error("Invalid session settings"));
  await tick();
  assert.deepEqual(harness.record.recovered, [SESSION_A], "切替前は回復 GET を投げる");

  // 回復 GET の待機中に切り替える
  harness.switchTo(SESSION_B);
  recovery.resolve(payload(SESSION_A, "medium"));
  await running;

  assert.deepEqual(harness.record.applied, []);
  assert.deepEqual(harness.record.errors, []);
});

test("still reports the original error when the recovery request fails", async () => {
  const harness = createHarness();
  const response = deferred<SessionPayload>();
  const failure = new Error("Model is not available: stub/ghost");
  const running = applySettingsChange(
    SESSION_A,
    { thinkingLevel: "high" },
    harness.deps({
      request: () => response.promise,
      recover: async () => {
        throw new Error("Session not found");
      },
    }),
  );

  response.reject(failure);
  await running;

  assert.deepEqual(harness.record.applied, []);
  assert.deepEqual(harness.record.errors, [failure]);
});
