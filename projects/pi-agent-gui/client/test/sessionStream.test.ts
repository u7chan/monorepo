// SSE イベント適用の回帰テスト。
//
// イベントは chat 状態 (reducer) へ流し、lastSeq はイベント適用より先に進める。
// 再接続は lastSeq を after= に使うため、逆順になると取りこぼし・重複が起きる。
import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch } from "react";
import type { ChatAction } from "../src/hooks/chatReducer";
import {
  applySessionEvent,
  isSseSilent,
  nextRetryDelayMs,
  SSE_SILENCE_TIMEOUT_MS,
  type SessionStreamDeps,
} from "../src/hooks/sessionStream";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import type { SessionPayload, SessionSummary } from "../src/types";

function payload(sessionId: string, lastSeq: number): SessionPayload {
  return {
    sessionId,
    piSessionId: `pi-${sessionId}`,
    cwd: "",
    eventGeneration: "gen-1",
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    queueDepth: 0,
    lastSeq,
    run: null,
    messages: [],
    compactions: [],
    thinkingLevel: "low",
  };
}

function createHarness() {
  const record = {
    actions: [] as ChatAction[],
    snapshots: [] as SessionPayload[],
    refreshed: 0,
    statuses: [] as RuntimeStatus[],
  };
  const dispatch: Dispatch<ChatAction> = (value) => {
    record.actions.push(value as ChatAction);
  };
  const deps: SessionStreamDeps = {
    lastSeqRef: { current: 0 },
    dispatch,
    applySnapshot: (next) => {
      record.snapshots.push(next);
    },
    refreshSessions: async (): Promise<SessionSummary[]> => {
      record.refreshed += 1;
      return [];
    },
    setRuntimeStatus: (status) => {
      record.statuses.push(status);
    },
  };
  return { record, deps };
}

test("advances lastSeq to the highest seq seen, never backwards", () => {
  const { deps } = createHarness();

  applySessionEvent({ seq: 5, type: "text", data: { delta: "a" }, at: 1 }, deps);
  assert.equal(deps.lastSeqRef.current, 5);

  applySessionEvent({ seq: 3, type: "resync", data: payload("s-1", 3), at: 2 }, deps);
  assert.equal(deps.lastSeqRef.current, 5, "リプレイの巻き戻りで after= を後退させない");
});

test("routes text events to the chat reducer", () => {
  const { record, deps } = createHarness();

  applySessionEvent({ seq: 1, type: "text", data: { delta: "hi" }, at: 7 }, deps);

  assert.deepEqual(record.actions, [{ type: "text", delta: "hi", at: 7 }]);
});

test("applies resync snapshots without dispatching chat actions", () => {
  const { record, deps } = createHarness();
  const snapshot = payload("s-1", 9);

  applySessionEvent({ seq: 9, type: "resync", data: snapshot, at: 1 }, deps);

  assert.deepEqual(record.snapshots, [snapshot]);
  assert.deepEqual(record.actions, []);
});

test("refreshes the session list on queue changes", () => {
  const { record, deps } = createHarness();

  applySessionEvent({ seq: 1, type: "queued", data: { position: 1, queueDepth: 2, prompt: "go" }, at: 1 }, deps);
  applySessionEvent({ seq: 2, type: "run_end", data: { status: "completed", queueDepth: 0 }, at: 2 }, deps);

  assert.equal(record.refreshed, 2, "キュー残数と一覧の run 状態を揃える");
});

test("reports a failed run through runtimeStatus", () => {
  const { record, deps } = createHarness();

  applySessionEvent(
    { seq: 1, type: "run_end", data: { status: "error", queueDepth: 0, error: "sandbox is down" }, at: 1 },
    deps,
  );

  assert.equal(record.statuses.length, 1);
  assert.equal(record.statuses[0].error, true);
  assert.match(record.statuses[0].detail || "", /sandbox is down/);
});

test("leaves runtimeStatus alone when a run ends normally", () => {
  const { record, deps } = createHarness();

  applySessionEvent({ seq: 1, type: "run_end", data: { status: "completed", queueDepth: 0 }, at: 1 }, deps);

  assert.deepEqual(record.statuses, []);
});

test("treats a stream that stopped sending heartbeat as silent", () => {
  const last = 1_000;

  assert.equal(isSseSilent(last, last + SSE_SILENCE_TIMEOUT_MS - 1), false, "1 回の ping を逃しただけでは切らない");
  assert.equal(isSseSilent(last, last + SSE_SILENCE_TIMEOUT_MS), true, "無音を検知して接続を張り直す");
});

test("backs off the reconnect delay for each consecutive failure", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(nextRetryDelayMs), [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(nextRetryDelayMs(5), 30_000, "上限で頭打ちにして、停止中もリクエストを叩き続けない");
  assert.equal(nextRetryDelayMs(64), 30_000);
});
