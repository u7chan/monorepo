// 未送信メッセージ (202 で受理したがサーバー再起動で entry にならなかった送信) の回帰テスト。
// Issue #1614 の 2 ケース (別タブの同一文面への誤吸収 / 同一文面2件の二重表示) を reducer で再現し、
// 再起動・リロード・旧保存データ・再送 / 破棄の扱いを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import type { HistoryPage, PendingSend, SessionPayload } from "../src/types";

function payload(pendingSends?: PendingSend[], sessionId = "session-a"): SessionPayload {
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
    ...(pendingSends ? { pendingSends } : {}),
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
    payload: payload([{ runId: "run-a", text: "同じ本文", at: 2, state: "unsent" }]),
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
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
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

test("旧サーバー (pendingSends 無し) の resync は pending エコーを変えない", () => {
  const mine = echoWithRunId(withHistory(), "同じ本文", "run-a", 2);
  const echoId = mine.pendingEchoIds[0];
  const resynced = chatReducer(mine, { type: "resync", payload: payload() });
  assert.deepEqual(resynced.pendingEchoIds, [echoId], "未対応の payload では現状維持");
  assert.equal(resynced.bubbles.find((bubble) => bubble.id === echoId)?.unsent, undefined);
});

test("未送信は本文の縮退で旧保存データの同一文面 item へ吸収されない", () => {
  const fresh = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 5, state: "unsent" }]),
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
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
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
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
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
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
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
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
  });
  const switched = chatReducer(fresh, { type: "resync", payload: payload([], "session-b") });
  assert.deepEqual(switched.bubbles, []);
  assert.deepEqual(switched.pendingEchoIds, []);
});

test("停止の queue_cleared が送信応答より先に届いても、run id が付いた時点で未送信になる", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "待機の本文", at: 2 });
  const echoId = sent.pendingEchoIds[0];
  // 停止が応答より先に届く (破棄された run id は分かるが、エコーにまだ run id が無い)
  const cleared = chatReducer(sent, { type: "queueCleared", runIds: ["run-cleared"] });
  assert.deepEqual(cleared.pendingEchoIds, [echoId], "特定できないうちは pending のまま");
  assert.deepEqual(cleared.clearedRunIds, ["run-cleared"]);

  const assigned = chatReducer(cleared, { type: "echoRunId", runId: "run-cleared" });
  const echo = assigned.bubbles.find((bubble) => bubble.id === echoId);
  assert.equal(echo?.runId, "run-cleared");
  assert.equal(echo?.unsent, true, "対応付いた時点で未送信へ切り替える");
  assert.deepEqual(assigned.pendingEchoIds, []);
  assert.deepEqual(assigned.clearedRunIds, [], "使い切った控えは消える");
});

test("payload の未送信が送信応答より先に届いても、run id の対応付けでバブルを重複させない", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "同じ本文", at: 2 });
  const echoId = sent.pendingEchoIds[0];
  const resynced = chatReducer(sent, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 5, state: "unsent" }]),
  });
  assert.equal(resynced.bubbles.filter((bubble) => bubble.runId === "run-x").length, 1, "payload が先に足す");

  const assigned = chatReducer(resynced, { type: "echoRunId", runId: "run-x" });
  assert.deepEqual(
    assigned.bubbles.filter((bubble) => bubble.runId === "run-x").map((bubble) => [bubble.id, bubble.unsent === true]),
    [[echoId, true]],
    "ローカルのエコーへ寄せて 1 件にする",
  );
  assert.deepEqual(assigned.pendingEchoIds, []);
});

test("別タブの再送 (run_start) で、接続中のタブの未送信バブルが送信中へ戻る", () => {
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
  });
  const started = chatReducer(fresh, {
    type: "runStart",
    runId: "run-x",
    prompt: "未送信の本文",
    at: 6,
    startedAt: 6,
  });
  assert.deepEqual(
    started.bubbles
      .filter((bubble) => bubble.role === "user" && bubble.text === "未送信の本文")
      .map((bubble) => [bubble.runId, bubble.unsent === true]),
    [["run-x", false]],
    "未送信の表示を戻し、二重に足さない",
  );
  assert.deepEqual(started.pendingEchoIds, [], "実行開始後は pending に残さない");
});

test("別タブの再送がキュー待ちの間は未送信バブルを消さず、停止で未送信へ戻る", () => {
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
  });
  const bubble = fresh.bubbles.find((item) => item.unsent === true);
  assert.ok(bubble);

  // 別タブが再送してキューへ積まれた (payload は queued として配る)
  const queued = chatReducer(fresh, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "queued" }]),
  });
  const kept = queued.bubbles.find((item) => item.runId === "run-x");
  assert.equal(kept?.unsent, false, "未送信の表示を戻す");
  assert.deepEqual(queued.pendingEchoIds, [bubble.id], "entry の吸収に載せる");

  // 停止でキューが破棄されたら未送信へ戻る (消えていたら戻せない)
  const stopped = chatReducer(queued, { type: "queueCleared", runIds: ["run-x"] });
  assert.equal(stopped.bubbles.find((item) => item.runId === "run-x")?.unsent, true);
  assert.deepEqual(stopped.pendingEchoIds, []);
});

test("実行中の状態が配られたら未送信の表示を戻し、二重表示しない", () => {
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
  });
  const running = chatReducer(fresh, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "running" }]),
  });
  assert.deepEqual(
    running.bubbles.filter((item) => item.runId === "run-x").map((item) => item.unsent === true),
    [false],
  );
});

test("停止の控えが残っていても、保存済み entry があれば未送信へ戻さない", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "同じ本文", at: 2 });
  const echoId = sent.pendingEchoIds[0];
  // 停止が応答より先に届き、run id の控えだけが残る
  const cleared = chatReducer(sent, { type: "queueCleared", runIds: ["run-x"] });
  assert.deepEqual(cleared.clearedRunIds, ["run-x"]);

  // 別タブが同じ run を再送して完了し、entry が保存されている
  const saved = chatReducer(cleared, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old", "run-old"), userMsg("saved", "同じ本文", "run-x")]),
  });
  const assigned = chatReducer(saved, { type: "echoRunId", runId: "run-x" });
  assert.deepEqual(
    assigned.bubbles.map((bubble) => [bubble.entryId, bubble.runId, bubble.unsent === true]),
    [
      ["old", "run-old", false],
      ["saved", "run-x", false],
    ],
    "保存済み entry へ吸収し、未送信へ戻さない",
  );
  assert.equal(
    assigned.bubbles.some((bubble) => bubble.id === echoId),
    false,
  );
  assert.deepEqual(assigned.clearedRunIds, []);
});

test("run_start が届いたら停止の控えを消し、遅れて届いた run id で未送信にしない", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "同じ本文", at: 2 });
  const cleared = chatReducer(sent, { type: "queueCleared", runIds: ["run-x"] });
  const started = chatReducer(cleared, {
    type: "runStart",
    runId: "run-x",
    prompt: "同じ本文",
    at: 3,
    startedAt: 3,
  });
  assert.deepEqual(started.clearedRunIds, [], "実行が始まった run は控えから外す");
  const late = chatReducer(started, { type: "echoRunId", runId: "run-x" });
  assert.equal(
    late.bubbles.some((bubble) => bubble.unsent === true),
    false,
  );
});

test("履歴の初回応答前でも、別タブの再送 (queued) を未送信として失わない", () => {
  // history 未対応の初期表示 (payload.messages から組む) の状態
  const cold = chatReducer(initialChatState, { type: "resync", payload: payload([], "session-a") });
  assert.equal(cold.history.supported, false);

  const queued = chatReducer(cold, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "queued" }]),
  });
  const bubble = queued.bubbles.find((item) => item.runId === "run-x");
  assert.ok(bubble, "受理済みのバブルを足す");
  assert.equal(bubble.accepted, true);
  assert.equal(bubble.unsent, undefined);
  assert.deepEqual(queued.pendingEchoIds, [bubble.id]);

  // 停止でキューが破棄されたら未送信へ戻る (消えていたら戻せない)
  const stopped = chatReducer(queued, { type: "queueCleared", runIds: ["run-x"] });
  assert.equal(stopped.bubbles.find((item) => item.runId === "run-x")?.unsent, true);
  assert.deepEqual(stopped.pendingEchoIds, []);
});

test("停止の控えは payload の queued で消え、後着の 202 が未送信へ戻さない", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "同じ本文", at: 2 });
  const echoId = sent.pendingEchoIds[0];
  const cleared = chatReducer(sent, { type: "queueCleared", runIds: ["run-x"] });
  assert.deepEqual(cleared.clearedRunIds, ["run-x"]);

  // payload が未送信として配り、次に別タブの再送で queued へ進む
  const unsent = chatReducer(cleared, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 2, state: "unsent" }]),
  });
  const queued = chatReducer(unsent, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 2, state: "queued" }]),
  });
  assert.deepEqual(queued.clearedRunIds, [], "payload の queued で控えを消す");

  const assigned = chatReducer(queued, { type: "echoRunId", runId: "run-x" });
  assert.deepEqual(
    assigned.bubbles
      .filter((item) => item.runId === "run-x")
      .map((item) => [item.id, item.unsent === true, item.accepted === true]),
    [[echoId, false, true]],
    "ローカルのエコーへ統合し、受理済みとして保つ",
  );
  assert.equal(
    assigned.bubbles.some((item) => item.unsent === true),
    false,
  );
});

test("payload の running でも受理済みバブルを 1 件に統合する", () => {
  const sent = chatReducer(withHistory(), { type: "localUser", text: "同じ本文", at: 2 });
  const echoId = sent.pendingEchoIds[0];
  const running = chatReducer(sent, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 2, state: "running" }]),
  });
  const assigned = chatReducer(running, { type: "echoRunId", runId: "run-x" });
  assert.deepEqual(
    assigned.bubbles.filter((item) => item.runId === "run-x").map((item) => [item.id, item.accepted === true]),
    [[echoId, true]],
  );
});

test("再送の失敗は、サーバーが受理を確認済みの run を未送信へ戻さない", () => {
  // 楽観的に受理済みへ切り替えた直後 (confirmed なし) は未送信へ戻す
  const fresh = chatReducer(withHistory(), {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "unsent" }]),
  });
  const optimistic = chatReducer(fresh, { type: "resendUnsent", runId: "run-x" });
  const failed = chatReducer(optimistic, { type: "resendFailed", runId: "run-x" });
  assert.equal(failed.bubbles.find((item) => item.runId === "run-x")?.unsent, true);
  assert.deepEqual(failed.pendingEchoIds, []);

  // payload の queued でサーバーが受理を確認済みなら、失敗しても実行済みの見た目を保つ
  const queued = chatReducer(fresh, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "未送信の本文", at: 5, state: "queued" }]),
  });
  const confirmed = chatReducer(queued, { type: "resendFailed", runId: "run-x" });
  assert.equal(confirmed.bubbles.find((item) => item.runId === "run-x")?.unsent, false);
  assert.equal(confirmed.bubbles.find((item) => item.runId === "run-x")?.accepted, true);
  assert.deepEqual(confirmed.pendingEchoIds, queued.pendingEchoIds);

  // run_start で確認済みのときも同じ
  const started = chatReducer(fresh, {
    type: "runStart",
    runId: "run-x",
    prompt: "未送信の本文",
    at: 6,
    startedAt: 6,
  });
  assert.equal(
    chatReducer(started, { type: "resendFailed", runId: "run-x" }).bubbles.find((item) => item.runId === "run-x")
      ?.unsent,
    false,
  );
});

test("受理済みのバブルは本文の縮退で旧 entry へ吸収されない", () => {
  // cold state (履歴の初回応答前) に、別タブの再送が queued として配られる
  const cold = chatReducer(initialChatState, { type: "resync", payload: payload([], "session-a") });
  const queued = chatReducer(cold, {
    type: "resync",
    payload: payload([{ runId: "run-x", text: "同じ本文", at: 5, state: "queued" }]),
  });
  const bubble = queued.bubbles.find((item) => item.runId === "run-x");
  assert.ok(bubble);

  // 履歴の初回応答に、runId の無い旧 entry (同じ本文) が載る
  const merged = chatReducer(queued, {
    type: "resyncHistory",
    page: historyPage([userMsg("legacy", "同じ本文")]),
  });
  assert.equal(
    merged.bubbles.some((item) => item.id === bubble.id),
    true,
    "本文の縮退で旧 entry へ吸収しない",
  );
  assert.deepEqual(merged.pendingEchoIds, [bubble.id]);

  // 停止でキューが破棄されたら未送信へ戻る (吸収されていたら戻せない)
  const stopped = chatReducer(merged, { type: "queueCleared", runIds: ["run-x"] });
  assert.equal(stopped.bubbles.find((item) => item.runId === "run-x")?.unsent, true);
});
