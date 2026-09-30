// 自動再試行の状態復元と表示文言の回帰テスト。
//
// 残り時間はサーバー基準 (retryAt - serverNow) で出し、ブラウザ時計は受信後の経過にだけ使う。
// 予定時刻を過ぎても次の message_start が来ないときは「開始待ち」へ切り替える。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import { applySessionEvent, type SessionStreamDeps } from "../src/hooks/sessionStream";
import { activityDisplay, retryActivityText, retryRemainingMs } from "../src/lib/retryState";
import type { SessionPayload } from "../src/types";

const RETRY = { phase: "waiting", attempt: 1, maxAttempts: 2, retryAt: 12_000, reason: "rate_limit" } as const;

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status: "running",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 10_000,
    queueDepth: 0,
    lastSeq: 3,
    run: {
      id: "run-1",
      status: "running",
      startedAt: 1,
      prompt: "聞いて",
      toolCalls: [],
      retry: RETRY,
      totalRetryCount: 1,
    },
    messages: [],
    compactions: [],
    ...overrides,
  };
}

test("retryRemainingMs subtracts only the elapsed browser time", () => {
  assert.equal(retryRemainingMs(2000, 0), 2000);
  assert.equal(retryRemainingMs(2000, 1500), 500);
  assert.equal(retryRemainingMs(2000, 5000), 0, "過ぎても負にしない");
  assert.equal(retryRemainingMs(undefined, 5000), undefined);
});

test("retryActivityText switches to the start-wait wording after the deadline", () => {
  assert.equal(retryActivityText({ ...RETRY }, 2000), "レート制限中。約2秒後に再試行予定（1/2）");
  assert.equal(retryActivityText({ ...RETRY }, 1), "レート制限中。約1秒後に再試行予定（1/2）");
  assert.equal(retryActivityText({ ...RETRY }, 0), "再実行の開始待ち（1/2）");
  assert.equal(retryActivityText({ ...RETRY, phase: "retrying" }, 0), "再実行中（1/2）");
  assert.equal(
    retryActivityText({ ...RETRY, reason: "unknown" }, 2000),
    "エラー発生。約2秒後に再試行予定（1/2）",
    "rate limit 以外は原因を断定しない",
  );
  assert.equal(retryActivityText(undefined, 0), undefined);
  assert.equal(retryActivityText({ ...RETRY }, undefined), "自動再試行を待機中（1/2）");
});

test("activityDisplay: 再試行の文言で上書きしている間は run の由来を渡さない", () => {
  assert.deepEqual(activityDisplay("考え中…", "thinking", undefined, undefined), {
    text: "考え中…",
    state: "thinking",
  });
  assert.deepEqual(activityDisplay("考え中…", "thinking", { ...RETRY }, 2000), {
    text: "レート制限中。約2秒後に再試行予定（1/2）",
    state: undefined,
    // 再実行の試行中は state が thinking でも行に出ているのは「再実行中（1/2）」
  });
  assert.deepEqual(activityDisplay("考え中…", "thinking", { ...RETRY, phase: "retrying" }, 0), {
    text: "再実行中（1/2）",
    state: undefined,
  });
});

test("resync restores retry and retryAt from the payload's server clock", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: payload(), receivedAt: 500 });
  assert.deepEqual(state.retry, RETRY);
  assert.equal(state.retryRemainingMs, 2000, "retryAt - serverNow");
  assert.equal(state.retryReceivedAt, 500);
  assert.equal(state.retryCount, 1);
});

test("replaying the same waiting event does not extend the wait", () => {
  // 切断中に発行された run_retry が 1.5 秒後にリプレイされる状況 (同じ serverNow が再度届く)
  let state = chatReducer(initialChatState, {
    type: "retry",
    retry: { ...RETRY },
    totalRetryCount: 1,
    serverNow: 10_000,
    receivedAt: 500,
  });
  state = chatReducer(state, {
    type: "retry",
    retry: { ...RETRY },
    totalRetryCount: 1,
    serverNow: 10_000,
    receivedAt: 2000,
  });
  assert.equal(state.retryReceivedAt, 500, "最初に得た起点を維持する");
  assert.equal(state.retryRemainingMs, 2000);
  assert.equal(
    retryActivityText(state.retry, retryRemainingMs(state.retryRemainingMs, 1500)),
    "レート制限中。約1秒後に再試行予定（1/2）",
    "時刻 2000 では残り 0.5 秒 (約 1 秒) のまま",
  );
  assert.equal(
    retryActivityText(state.retry, retryRemainingMs(state.retryRemainingMs, 2100)),
    "再実行の開始待ち（1/2）",
    "予定時刻を過ぎたら開始待ちへ切り替わる",
  );
});

test("a fresh resync with the current serverNow shrinks the remaining wait", () => {
  const waiting = chatReducer(initialChatState, {
    type: "retry",
    retry: { ...RETRY },
    totalRetryCount: 1,
    serverNow: 10_000,
    receivedAt: 500,
  });
  // サーバーが現在の serverNow (11500) を持つ resync を配ると、残りは 500ms になる
  const resynced = chatReducer(waiting, {
    type: "resync",
    payload: payload({ serverNow: 11_500 }),
    receivedAt: 2000,
  });
  assert.equal(resynced.retryRemainingMs, 500);
  assert.equal(resynced.retryReceivedAt, 2000);
  assert.equal(
    retryActivityText(resynced.retry, retryRemainingMs(resynced.retryRemainingMs, 0)),
    "レート制限中。約1秒後に再試行予定（1/2）",
  );
  assert.equal(
    retryActivityText(resynced.retry, retryRemainingMs(resynced.retryRemainingMs, 500)),
    "再実行の開始待ち（1/2）",
  );
});

test("resync keeps the classified run error visible after a reload", () => {
  const error = "レート制限により実行に失敗しました（自動再試行2回）。時間をおいて再実行してください";
  const failed = payload({
    status: "error",
    run: {
      id: "run-1",
      status: "error",
      startedAt: 1,
      endedAt: 2,
      prompt: "聞いて",
      toolCalls: [],
      error,
      totalRetryCount: 2,
    },
  });
  const state = chatReducer(initialChatState, { type: "resync", payload: failed, receivedAt: 500 });
  assert.equal(state.activity, `エラー: ${error}`, "ライブの run_end と同じ文言");
  assert.equal(state.runError, undefined, "分類コードが無い payload ではカードを出さない");
  assert.equal(state.retry, undefined);
  assert.equal(state.retryCount, 2);

  // run.error が無い古い payload は従来の汎用文言
  const generic = chatReducer(initialChatState, {
    type: "resync",
    payload: payload({
      status: "error",
      run: { id: "run-1", status: "error", startedAt: 1, prompt: "x", toolCalls: [], totalRetryCount: 0 },
    }),
    receivedAt: 500,
  });
  assert.equal(generic.activity, "前回の実行でエラーが発生しました");
});

test("resync restores the failure code and hands the wording to the retry card", () => {
  const error = "レート制限により実行に失敗しました（自動再試行2回）。時間をおいて再実行してください";
  const state = chatReducer(initialChatState, {
    type: "resync",
    payload: payload({
      status: "error",
      run: {
        id: "run-1",
        status: "error",
        startedAt: 1,
        endedAt: 2,
        prompt: "聞いて",
        toolCalls: [],
        error,
        errorCode: "rate_limit",
        totalRetryCount: 2,
      },
    }),
    receivedAt: 500,
  });

  assert.deepEqual(state.runError, { code: "rate_limit", text: error });
  assert.equal(state.activity, "", "同じ 1 文をカードと状態行に二重に出さない");
});

test("run_retry applies waiting → retrying → cleared and keeps the cumulative count", () => {
  const receivedAt = 900;
  let state = chatReducer(initialChatState, {
    type: "retry",
    retry: { ...RETRY },
    totalRetryCount: 1,
    serverNow: 10_000,
    receivedAt,
  });
  assert.equal(state.retry?.phase, "waiting");
  assert.equal(state.retryRemainingMs, 2000);

  state = chatReducer(state, {
    type: "retry",
    retry: { phase: "retrying", attempt: 1, maxAttempts: 2, reason: "rate_limit" },
    totalRetryCount: 1,
    serverNow: 12_100,
    receivedAt,
  });
  assert.equal(state.retry?.phase, "retrying");
  assert.equal(state.retryRemainingMs, undefined, "再実行中は残り時間を持たない");

  state = chatReducer(state, { type: "retry", retry: null, totalRetryCount: 1, serverNow: 12_200, receivedAt });
  assert.equal(state.retry, undefined);
  assert.equal(state.retryCount, 1, "解除後も累計は残る");
});

test("runEnd clears the active retry but keeps the cumulative count for the result", () => {
  let state = chatReducer(initialChatState, { type: "resync", payload: payload(), receivedAt: 500 });
  state = chatReducer(state, {
    type: "runEnd",
    status: "error",
    queueDepth: 0,
    error: "レート制限により実行に失敗しました（自動再試行2回）。時間をおいて再実行してください",
    totalRetryCount: 2,
  });
  assert.equal(state.retry, undefined);
  assert.equal(state.retryRemainingMs, undefined);
  assert.equal(state.retryCount, 2);
  assert.match(state.activity, /レート制限により実行に失敗しました/);
});

test("runStart and newChat reset the retry state", () => {
  let waiting = chatReducer(initialChatState, { type: "resync", payload: payload(), receivedAt: 500 });
  // 最終失敗の分類コードも次のラン / 新規チャットへ引き継がない
  waiting = chatReducer(waiting, {
    type: "runEnd",
    status: "error",
    queueDepth: 0,
    error: "レート制限により実行に失敗しました",
    errorCode: "rate_limit",
  });
  assert.equal(waiting.runError?.code, "rate_limit");
  assert.equal(waiting.activity, "", "文言はカードへ移す");

  const started = chatReducer(waiting, { type: "runStart", prompt: "次", at: 1, startedAt: 1 });
  assert.equal(started.retry, undefined);
  assert.equal(started.retryCount, 0);
  assert.equal(started.runError, undefined);
  assert.equal(chatReducer(waiting, { type: "newChat" }).retry, undefined);
  assert.equal(chatReducer(waiting, { type: "newChat" }).runError, undefined);
});

test("routes run_retry SSE events to the reducer with the browser receipt time", () => {
  const actions: unknown[] = [];
  const deps: SessionStreamDeps = {
    lastSeqRef: { current: 0 },
    dispatch: (value) => {
      actions.push(value);
    },
    applySnapshot: () => {},
    refreshSessions: async () => [],
    setRuntimeStatus: () => {},
  };
  applySessionEvent(
    {
      seq: 4,
      type: "run_retry",
      data: { retry: { ...RETRY }, totalRetryCount: 1, serverNow: 10_000 },
      at: 1,
    },
    deps,
  );
  const action = actions[0] as { type: string; serverNow: number; receivedAt: number };
  assert.equal(action.type, "retry");
  assert.equal(action.serverNow, 10_000);
  assert.equal(typeof action.receivedAt, "number");
});
