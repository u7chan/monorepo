// 未送信メッセージ (202 で受理したがサーバー再起動で entry にならなかった送信) の回帰テスト。
// Issue #1614 の 2 ケース (別タブの同一文面への誤吸収 / 同一文面2件の二重表示) を reducer で再現し、
// 再起動・リロード・旧保存データ・再送 / 破棄の扱いを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import type { HistoryPage, SessionPayload, UnsentMessage } from "../src/types";

function payload(unsentMessages?: UnsentMessage[], sessionId = "session-a"): SessionPayload {
  return {
    sessionId,
    piSessionId: `pi-${sessionId}`,
    cwd: "",
    eventGeneration: "gen-1",
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    lastSeq: 1,
    run: null,
    messages: [],
    compactions: [],
    ...(unsentMessages ? { unsentMessages } : {}),
  };
}

function historyPage(items: HistoryPage["items"]): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "session-a",
    items,
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: messages.length,
    summarizedMessageCount: 0,
  };
}

function userMsg(id: string, text: string, runId?: string): HistoryPage["items"][number] {
  return { kind: "message", id, context: "active", role: "user", text, ...(runId ? { runId } : {}) };
}

/** 履歴 API が使える状態にする (保持分 old だけを持つ) */
function withHistory() {
  return chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old", "run-old")]),
  });
}

/** 送信のローカルエコーに run id を結び付けた状態を作る */
function echoWithRunId(state: ReturnType<typeof chatReducer>, text: string, runId: string, at: number) {
  const echoed = chatReducer(state, { type: "localUser", text, at });
  return chatReducer(echoed, { type: "echoRunId", runId });
}

test("再起動後、別タブの同一文面 entry に自分の pending エコーを吸収しない (未送信として残す)", () => {
  // タブ A: SSE 未受信のまま送信し、自分の run id だけを結び付けている
  const mine = echoWithRunId(withHistory(), "同じ本文", "run-a", 2);
  const echoId = mine.pendingEchoIds[0];
  assert.equal(mine.bubbles.find((bubble) => bubble.id === echoId)?.runId, "run-a");

  // BFF 再起動: タブ B の保存済み entry は run-b、自分の送信は未送信として配られる
  const restarted = chatReducer(mine, {
    type: "resync",
    payload: payload([{ runId: "run-a", text: "同じ本文", at: 2 }]),
  });
  const foreign = chatReducer(restarted, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old", "run-old"), userMsg("entry-b", "同じ本文", "run-b")]),
  });

  assert.deepEqual(foreign.pendingEchoIds, [], "未送信は pending から外れる");
  const unsent = foreign.bubbles.find((bubble) => bubble.unsent === true);
  assert.ok(unsent, "自分の送信は未送信として残る");
  assert.equal(unsent.runId, "run-a", "別タブの run id へは吸収しない");
  assert.deepEqual(
    foreign.bubbles.map((bubble) => [bubble.entryId, bubble.runId, bubble.unsent === true]),
    [
      ["old", "run-old", false],
      ["entry-b", "run-b", false],
      [undefined, "run-a", true],
    ],
    "別タブの entry と自分の未送信が別々に残る",
  );
});

test("再起動後、保存済みの同一文面2件は2件の pending エコーを順に吸収する (二重表示しない)", () => {
  const first = echoWithRunId(withHistory(), "同じ本文", "run-1", 2);
  const second = echoWithRunId(first, "同じ本文", "run-2", 3);
  assert.equal(second.pendingEchoIds.length, 2);

  // 再起動: 2 件の送信はどちらも entry として保存されている (未送信は空)
  const restarted = chatReducer(second, { type: "resync", payload: payload([]) });
  const merged = chatReducer(restarted, {
    type: "resyncHistory",
    page: historyPage([
      userMsg("old", "old", "run-old"),
      userMsg("entry-1", "同じ本文", "run-1"),
      userMsg("entry-2", "同じ本文", "run-2"),
    ]),
  });

  assert.deepEqual(merged.pendingEchoIds, []);
  assert.deepEqual(
    merged.bubbles.filter((bubble) => bubble.text === "同じ本文").map((bubble) => bubble.entryId),
    ["entry-1", "entry-2"],
    "履歴 2 件のままになる (エコーが残らない)",
  );
  assert.equal(
    merged.bubbles.some((bubble) => bubble.unsent === true),
    false,
  );
});

test("リロード後も未送信メッセージはバブルとして見え、履歴の後ろに残る", () => {
  const fresh = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5 }]),
  });
  assert.deepEqual(
    fresh.bubbles.map((bubble) => [bubble.text, bubble.runId, bubble.unsent === true, bubble.at]),
    [["未送信の本文", "run-x", true, 5]],
  );
  assert.deepEqual(fresh.pendingEchoIds, [], "pending エコーにはしない");

  const merged = chatReducer(fresh, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old", "run-old")]),
  });
  assert.deepEqual(
    merged.bubbles.map((bubble) => bubble.text),
    ["old", "未送信の本文"],
    "履歴ページを適用しても未送信は末尾に残る",
  );
});

test("旧サーバー (unsentMessages 無し) の resync は pending エコーを変えない", () => {
  const mine = echoWithRunId(withHistory(), "同じ本文", "run-a", 2);
  const echoId = mine.pendingEchoIds[0];
  const resynced = chatReducer(mine, { type: "resync", payload: payload() });
  assert.deepEqual(resynced.pendingEchoIds, [echoId], "未対応の payload では現状維持");
  assert.equal(resynced.bubbles.find((bubble) => bubble.id === echoId)?.unsent, undefined);
});

test("未送信は本文の縮退で旧保存データの同一文面 item へ吸収されない", () => {
  const fresh = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 5 }]),
  });
  // runId を持たない旧保存データの item が同じ本文で載っても、未送信は別物として残す
  const merged = chatReducer(fresh, {
    type: "resyncHistory",
    page: historyPage([userMsg("legacy", "同じ本文")]),
  });
  assert.deepEqual(
    merged.bubbles.map((bubble) => [bubble.text, bubble.entryId, bubble.unsent === true]),
    [
      ["同じ本文", "legacy", false],
      ["同じ本文", undefined, true],
    ],
  );
});

test("未送信の再送は pending へ戻り、自分の entry が載った時点で吸収される", () => {
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5 }]),
  });
  const resent = chatReducer(fresh, { type: "resendUnsent", runId: "run-x" });
  const echo = resent.bubbles.find((bubble) => bubble.runId === "run-x");
  assert.ok(echo);
  assert.equal(echo.unsent, false);
  assert.deepEqual(resent.pendingEchoIds, [echo.id]);
  assert.equal(resent.activity, "送信中…");

  // 再送が実行中は payload の未送信に載らない (サーバーが実行中の run を外す) ので pending のまま
  const during = chatReducer(resent, { type: "resync", payload: payload([]) });
  assert.deepEqual(during.pendingEchoIds, [echo.id]);
  assert.equal(during.bubbles.find((bubble) => bubble.runId === "run-x")?.unsent, false);

  const merged = chatReducer(during, {
    type: "resyncHistory",
    page: historyPage([userMsg("mine", "未送信の本文", "run-x")]),
  });
  assert.deepEqual(merged.pendingEchoIds, []);
  assert.deepEqual(
    merged.bubbles.map((bubble) => [bubble.entryId, bubble.unsent === true]),
    [["mine", false]],
    "自分の entry へ吸収し、二重表示しない",
  );
});

test("再送に失敗したら未送信へ戻り、破棄すると表示からも消える", () => {
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5 }]),
  });
  const resent = chatReducer(fresh, { type: "resendUnsent", runId: "run-x" });
  const failed = chatReducer(resent, { type: "resendFailed", runId: "run-x" });
  assert.equal(failed.bubbles.find((bubble) => bubble.runId === "run-x")?.unsent, true);
  assert.deepEqual(failed.pendingEchoIds, []);

  const discarded = chatReducer(failed, { type: "unsentDiscarded", runId: "run-x" });
  assert.deepEqual(
    discarded.bubbles.map((bubble) => bubble.runId),
    ["run-old"],
    "未送信のバブルだけが消える",
  );

  // pending のエコー (未送信ではない) は破棄しない
  const kept = chatReducer(resent, { type: "unsentDiscarded", runId: "run-x" });
  assert.equal(
    kept.bubbles.some((bubble) => bubble.runId === "run-x"),
    true,
  );
  assert.deepEqual(kept.pendingEchoIds, resent.pendingEchoIds);
});

test("別タブの再送 / 破棄で記録が消えた未送信バブルは、payload から落ちる", () => {
  const fresh = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5 }]),
  });
  const cleared = chatReducer(fresh, { type: "resync", payload: payload([]) });
  assert.deepEqual(cleared.bubbles, []);
});

test("停止でキューを破棄した送信は、queue_cleared の run id で未送信へ切り替わる", () => {
  const running = echoWithRunId(withHistory(), "実行中の本文", "run-running", 2);
  const queued = echoWithRunId(running, "待機の本文", "run-queued", 3);
  const cleared = chatReducer(queued, { type: "queueCleared", runIds: ["run-queued"] });

  assert.equal(cleared.queueDepth, 0);
  assert.deepEqual(
    cleared.bubbles.map((bubble) => [bubble.runId, bubble.unsent === true]),
    [
      ["run-old", false],
      ["run-running", false],
      ["run-queued", true],
    ],
    "破棄された待機分だけを未送信にする",
  );
  assert.deepEqual(cleared.pendingEchoIds, [queued.pendingEchoIds[0]], "実行中のエコーは pending のまま");

  // 旧サーバー (runIds 無し) は現状維持
  const legacy = chatReducer(queued, { type: "queueCleared" });
  assert.deepEqual(legacy.pendingEchoIds, queued.pendingEchoIds);
  assert.equal(
    legacy.bubbles.some((bubble) => bubble.unsent === true),
    false,
  );
});

test("セッションを切り替えた resync では、前のセッションの未送信を持ち越さない", () => {
  const fresh = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5 }]),
  });
  const switched = chatReducer(fresh, { type: "resync", payload: payload([], "session-b") });
  assert.deepEqual(switched.bubbles, []);
  assert.deepEqual(switched.pendingEchoIds, []);
});
