// 全履歴ページと SSE resync の整合 (reducer 統合)。
// 初回 (旧 payload) → resyncHistory → 以降の resync は取得済みの古いページを消さない、を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import type { HistoryPage, SessionPayload } from "../src/types";

function payload(messages: { role: "user" | "assistant"; text: string }[]): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
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
    messages,
    compactions: [],
  };
}

function historyPage(
  items: HistoryPage["items"],
  overrides: Partial<
    Pick<
      HistoryPage,
      "prevCursor" | "hasMore" | "nextCursor" | "messageCount" | "summarizedMessageCount" | "activeContextStartId"
    >
  > = {},
): HistoryPage {
  const messages = items.filter((item) => item.kind === "message");
  return {
    sessionId: "session-a",
    items,
    prevCursor: overrides.prevCursor ?? null,
    hasMore: overrides.hasMore ?? false,
    nextCursor: overrides.nextCursor ?? null,
    activeContextStartId:
      overrides.activeContextStartId ?? messages.find((item) => item.context === "active")?.id ?? null,
    messageCount: overrides.messageCount ?? messages.length,
    summarizedMessageCount:
      overrides.summarizedMessageCount ?? messages.filter((item) => item.context === "summarized").length,
  };
}

function msg(id: string, context: "active" | "summarized" | "excluded", text: string): HistoryPage["items"][number] {
  return { kind: "message", id, context, role: "assistant", text };
}

function userMsg(id: string, text: string): HistoryPage["items"][number] {
  return { kind: "message", id, context: "active", role: "user", text };
}

function entryIds(state: ReturnType<typeof chatReducer>): (string | undefined)[] {
  return state.bubbles.map((bubble) => bubble.entryId);
}

test("resyncHistory で履歴表示へ移行し、以降の resync は古いページとエコーを残す", () => {
  // 旧 payload での初期表示 (messages ベース)
  const legacy = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "assistant", text: "m2" }]),
  });
  assert.equal(legacy.history.supported, false);
  assert.deepEqual(
    legacy.bubbles.map((bubble) => bubble.text),
    ["m2"],
  );

  // 全履歴 API の最新ページ
  const withHistory = chatReducer(legacy, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "summarized", "m1"), msg("m2", "active", "m2")], {
      hasMore: true,
      nextCursor: "m1",
      messageCount: 3,
      summarizedMessageCount: 1,
    }),
  });
  assert.equal(withHistory.history.supported, true);
  assert.deepEqual(
    withHistory.bubbles.map((bubble) => [bubble.entryId, bubble.context, bubble.text]),
    [
      ["m1", "summarized", "m1"],
      ["m2", "active", "m2"],
    ],
  );

  // 送信直後 (ローカルエコー + ストリーミング中の assistant) に resync が届く
  const echoed = chatReducer(withHistory, { type: "localUser", text: "次の質問", at: 2 });
  const streaming = chatReducer(echoed, { type: "text", delta: "生成中", at: 3 });
  const resynced = chatReducer(streaming, { type: "resync", payload: payload([{ role: "assistant", text: "m2" }]) });
  assert.deepEqual(
    resynced.bubbles.map((bubble) => [bubble.entryId, bubble.text]),
    [
      ["m1", "m1"],
      ["m2", "m2"],
      [undefined, "次の質問"],
    ],
    "履歴は残り、ストリーミング中の assistant は捨て、ユーザーエコーは残る",
  );
  assert.equal(resynced.history.supported, true);
});

test("確定した応答は resync を跨いで残り、履歴ページで entryId 付きに置き換わって二重表示しない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1"), msg("m2", "active", "m2")], {
      hasMore: true,
      nextCursor: "m1",
      messageCount: 2,
    }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "次の質問", at: 2 });
  const started = chatReducer(echoed, { type: "runStart", prompt: "次の質問", at: 2, startedAt: 2 });
  const streaming = chatReducer(started, { type: "text", delta: "生成中", at: 3 });
  const ended = chatReducer(streaming, { type: "runEnd", status: "completed", queueDepth: 0 });
  // 完了後の resync でも確定した応答を残す
  const resynced = chatReducer(ended, {
    type: "resync",
    payload: payload([
      { role: "user", text: "次の質問" },
      { role: "assistant", text: "生成中" },
    ]),
  });
  assert.deepEqual(
    resynced.bubbles.map((bubble) => `${bubble.entryId ?? "live"}:${bubble.text}`),
    ["m1:m1", "m2:m2", "live:次の質問", "live:生成中"],
  );

  // 最新ページが追いついたらライブバブルを entryId 付きへ置き換える
  const merged = chatReducer(resynced, {
    type: "resyncHistory",
    page: historyPage(
      [
        { kind: "message", id: "m3", context: "active", role: "user", text: "次の質問" },
        { kind: "message", id: "m4", context: "active", role: "assistant", text: "生成中" },
      ],
      { prevCursor: "m2", hasMore: true, nextCursor: "m1", messageCount: 4 },
    ),
  });
  assert.deepEqual(
    merged.bubbles.map((bubble) => `${bubble.entryId ?? "live"}:${bubble.text}`),
    ["m1:m1", "m2:m2", "m3:次の質問", "m4:生成中"],
  );
});

test("同じ文面を再送しても、過去の entry では送信中エコーを消さない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "同じ質問"), msg("h2", "active", "x")], {
      hasMore: true,
      nextCursor: "h1",
      messageCount: 2,
    }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  assert.notEqual(echoId, undefined);

  // 送信分がまだ entry になっていない最新ページ (保持分と重なるだけ)
  const overlapped = historyPage([msg("h2", "active", "x")], {
    prevCursor: "h1",
    hasMore: true,
    nextCursor: "h2",
    messageCount: 2,
  });
  const resynced = chatReducer(echoed, { type: "resyncHistory", page: overlapped });
  assert.deepEqual(resynced.pendingEchoIds, [echoId], "過去の同一文面では消費しない");
  assert.equal(
    resynced.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "送信中エコーが消えない",
  );

  // 後続の run_start でも解決できる (待ち行列とバブルが不整合にならない)
  const started = chatReducer(resynced, { type: "runStart", prompt: "同じ質問", at: 2, startedAt: 2 });
  assert.deepEqual(started.pendingEchoIds, []);
  assert.equal(started.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 2, "過去分 + 送信分");

  // 送信分の entry が現れたら、新しい領域の item と一致して消費される
  const withEntry = historyPage([msg("h2", "active", "x"), userMsg("n1", "同じ質問")], {
    prevCursor: "h1",
    hasMore: true,
    nextCursor: "h2",
    messageCount: 3,
  });
  const consumed = chatReducer(echoed, { type: "resyncHistory", page: withEntry });
  assert.deepEqual(consumed.pendingEchoIds, []);
  assert.equal(
    consumed.bubbles.some((bubble) => bubble.entryId === undefined),
    false,
    "ライブバブルは残らない",
  );
  assert.equal(consumed.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 2, "過去分 + 新しい entry");
});

test("保持分と重ならない最新ページは欠落区間を取り直してから適用する (50件保持 + 60件追記)", () => {
  const heldItems = Array.from({ length: 50 }, (_, index) => userMsg(`h${index + 1}`, `h${index + 1}`));
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage(heldItems, { hasMore: false, messageCount: 50 }),
  });
  const pending = historyPage(
    Array.from({ length: 50 }, (_, index) => userMsg(`p${index + 1}`, `p${index + 1}`)),
    { prevCursor: "g10", hasMore: true, nextCursor: "p1", messageCount: 110 },
  );
  const detected = chatReducer(base, { type: "resyncHistory", page: pending });
  assert.equal(detected.history.gapCursor, "p1", "欠落区間のカーソルを保留する");
  assert.equal(detected.history.pendingPage?.items.length, 50);
  assert.deepEqual(
    entryIds(detected),
    heldItems.map((item) => item.id),
    "表示は保持分のまま",
  );

  // 欠落区間 (h11..h50 + g1..g10) を取ってから保留ページを適用する
  const gapPage = historyPage(
    [
      ...Array.from({ length: 40 }, (_, index) => userMsg(`h${index + 11}`, `h${index + 11}`)),
      ...Array.from({ length: 10 }, (_, index) => userMsg(`g${index + 1}`, `g${index + 1}`)),
    ],
    { prevCursor: "h10", hasMore: true, nextCursor: "h11", messageCount: 110 },
  );
  const applied = chatReducer(detected, { type: "historyGap", cursor: "p1", page: gapPage });
  assert.equal(applied.history.gapCursor, null);
  assert.equal(applied.history.pendingPage, null);
  assert.deepEqual(entryIds(applied), [
    ...Array.from({ length: 50 }, (_, index) => `h${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `g${index + 1}`),
    ...Array.from({ length: 50 }, (_, index) => `p${index + 1}`),
  ]);
  assert.equal(applied.bubbles.length, 110, "欠落も重複も無い");
  assert.equal(applied.history.messageCount, 110);
  assert.equal(applied.history.nextCursor, "p1");
  assert.equal(applied.history.hasMore, true);
});

test("欠落区間が埋まらない / 古い gap 応答のときは再構築か無視で整合を保つ", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1"), userMsg("h2", "h2")], { hasMore: false, messageCount: 2 }),
  });
  const pending = historyPage([userMsg("p1", "p1"), userMsg("p2", "p2")], {
    prevCursor: "x9",
    hasMore: true,
    nextCursor: "p1",
    messageCount: 4,
  });
  const detected = chatReducer(base, { type: "resyncHistory", page: pending });
  assert.equal(detected.history.gapCursor, "p1");

  // 別の cursor の応答 (古い / 別の保留) は無視する
  const ignored = chatReducer(detected, {
    type: "historyGap",
    cursor: "other",
    page: historyPage([userMsg("y1", "y1")], { prevCursor: "x8", messageCount: 4 }),
  });
  assert.equal(ignored, detected);

  // 欠落区間のページも繋がらない (1 ページに収まらない) ときは最新ページで再構築する
  const rebuilt = chatReducer(detected, {
    type: "historyGap",
    cursor: "p1",
    page: historyPage([userMsg("y1", "y1")], { prevCursor: "x8", messageCount: 4 }),
  });
  assert.deepEqual(entryIds(rebuilt), ["p1", "p2"]);
  assert.equal(rebuilt.history.gapCursor, null);
  assert.equal(rebuilt.history.pendingPage, null);
});

test("欠落区間の取得に失敗したら保留を解いて次の resync で取り直せる", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1")], { hasMore: false, messageCount: 1 }),
  });
  const detected = chatReducer(base, {
    type: "resyncHistory",
    page: historyPage([userMsg("p1", "p1")], {
      prevCursor: "x9",
      hasMore: true,
      nextCursor: "p1",
      messageCount: 2,
    }),
  });
  assert.equal(detected.history.gapCursor, "p1");
  const ignored = chatReducer(detected, { type: "historyGapFailed", cursor: "other" });
  assert.equal(ignored, detected);
  const failed = chatReducer(detected, { type: "historyGapFailed", cursor: "p1" });
  assert.equal(failed.history.gapCursor, null);
  assert.equal(failed.history.pendingPage, null);
  assert.deepEqual(entryIds(failed), ["h1"], "表示は保持分のまま");
});

test("prependHistory は古いページを先頭へ足し、bubble id を衝突させない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m2", "active", "m2")], { hasMore: true, nextCursor: "m2", messageCount: 2 }),
  });
  const prepended = chatReducer(base, {
    type: "prependHistory",
    page: historyPage([msg("m1", "summarized", "m1"), msg("m2", "active", "m2")], {
      hasMore: false,
      messageCount: 2,
      summarizedMessageCount: 1,
      activeContextStartId: "m2",
    }),
  });
  assert.deepEqual(
    prepended.bubbles.map((bubble) => [bubble.entryId, bubble.context]),
    [
      ["m1", "summarized"],
      ["m2", "active"],
    ],
  );
  assert.equal(new Set(prepended.bubbles.map((bubble) => bubble.id)).size, 2);
  assert.equal(prepended.prependSeq, 1);
  assert.equal(prepended.history.hasMore, false);
});

test("旧サーバー (404) では payload.messages ベースの表示へ戻す", () => {
  const withHistory = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1")]),
  });
  const unsupported = chatReducer(withHistory, { type: "historyUnsupported" });
  assert.equal(unsupported.history.supported, false);
  const rebuilt = chatReducer(unsupported, {
    type: "resync",
    payload: payload([{ role: "user", text: "旧サーバーの履歴" }]),
  });
  assert.deepEqual(
    rebuilt.bubbles.map((bubble) => bubble.text),
    ["旧サーバーの履歴"],
  );
});

test("newChat は全履歴の状態を初期化する", () => {
  const withHistory = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([msg("m1", "active", "m1")], { hasMore: true, nextCursor: "m1" }),
  });
  const reset = chatReducer(withHistory, { type: "newChat" });
  assert.deepEqual(reset.history, initialChatState.history);
  assert.deepEqual(reset.dividers, []);
  assert.deepEqual(reset.bubbles, []);
});
