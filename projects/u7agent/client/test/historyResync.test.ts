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

function userMsg(id: string, text: string, runId?: string): HistoryPage["items"][number] {
  return { kind: "message", id, context: "active", role: "user", text, ...(runId ? { runId } : {}) };
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

  // run id を持つ別 run の entry は、本文が同じでも消費しない (別タブの同一文面)
  const withForeign = historyPage([msg("h2", "active", "x"), userMsg("n1", "同じ質問", "run-other")], {
    prevCursor: "h1",
    hasMore: true,
    nextCursor: "h2",
    messageCount: 3,
  });
  const stillPending = chatReducer(echoed, { type: "resyncHistory", page: withForeign });
  assert.deepEqual(stillPending.pendingEchoIds, [echoId], "別 run の entry では消費しない");

  // run 対応を失った item (runId 無し) は文書化済みの縮退で本文の正規形 + since から吸収する
  const withEntry = historyPage([msg("h2", "active", "x"), userMsg("n1", "同じ質問")], {
    prevCursor: "h1",
    hasMore: true,
    nextCursor: "h2",
    messageCount: 3,
  });
  const restored = chatReducer(echoed, { type: "resyncHistory", page: withEntry });
  assert.deepEqual(restored.pendingEchoIds, [], "run 対応を失った履歴は本文で吸収する");
  assert.equal(
    restored.bubbles.some((bubble) => bubble.entryId === undefined),
    false,
    "エコーは履歴 item へ置き換わる",
  );
  const settled = chatReducer(started, { type: "resyncHistory", page: withEntry });
  assert.deepEqual(settled.pendingEchoIds, []);
  assert.equal(settled.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 2, "過去分 + 新しい entry");
});

test("別タブの同一文面 entry では自分の送信中エコーを消費しない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1")], { hasMore: true, nextCursor: "h1", messageCount: 2 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  // 別タブが同じ文面を送り、その entry が最新ページに載る (自分の entry はまだ)
  const merged = chatReducer(echoed, {
    type: "resyncHistory",
    page: historyPage([userMsg("other", "同じ質問", "run-other")], {
      prevCursor: "h1",
      hasMore: true,
      nextCursor: "h1",
      messageCount: 3,
    }),
  });
  assert.deepEqual(merged.pendingEchoIds, [echoId], "pending は他クライアントの entry では消費しない");
  assert.equal(
    merged.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "自分のエコーが消えない",
  );
  assert.equal(
    merged.bubbles.filter((bubble) => bubble.text === "同じ質問").length,
    2,
    "他タブの entry + 自分のエコー",
  );
});

test("preflight compaction で自分の entry が先に載っていたら run_start でエコーを吸収する", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1")], { hasMore: true, nextCursor: "h1", messageCount: 2 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  const assigned = chatReducer(echoed, { type: "echoRunId", runId: "run-mine" });
  // run_start が先に届いても、entry がまだページに載っていなければエコーは残す
  const started = chatReducer(assigned, {
    type: "runStart",
    runId: "run-mine",
    prompt: "同じ質問",
    at: 2,
    startedAt: 2,
  });
  assert.equal(
    started.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "entry が無い間は保持する",
  );
  // 送信分の entry がページに載ったら、runId の一致でエコーを履歴 item へ吸収する
  const withEntry = chatReducer(started, {
    type: "resyncHistory",
    page: historyPage([userMsg("mine", "同じ質問", "run-mine")], {
      prevCursor: "h1",
      hasMore: true,
      nextCursor: "h1",
      messageCount: 3,
    }),
  });
  assert.deepEqual(withEntry.pendingEchoIds, []);
  assert.equal(
    withEntry.bubbles.some((bubble) => bubble.id === echoId),
    false,
    "エコーは残らない",
  );
  assert.equal(withEntry.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 1, "履歴 item のみ");
  assert.equal(withEntry.bubbles.filter((bubble) => bubble.entryId === "mine").length, 1);
});

test("自分の entry がまだ無ければ run_start では吸収せず、entry が現れたら置き換わる", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1")], { hasMore: true, nextCursor: "h1", messageCount: 2 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  const started = chatReducer(echoed, { type: "runStart", prompt: "同じ質問", at: 2, startedAt: 2 });
  assert.deepEqual(started.pendingEchoIds, []);
  assert.equal(
    started.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "吸収せずエコーを残す",
  );
  const merged = chatReducer(started, {
    type: "resyncHistory",
    page: historyPage([userMsg("mine", "同じ質問")], {
      prevCursor: "h1",
      hasMore: true,
      nextCursor: "h1",
      messageCount: 3,
    }),
  });
  assert.equal(
    merged.bubbles.some((bubble) => bubble.entryId === undefined),
    false,
    "settled のエコーは entry に置き換わる",
  );
  assert.equal(merged.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 1);
});

test("取得中にブランチが切り替わった古い追加取得は捨てる", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old-a", "old-a"), userMsg("old-b", "old-b")], {
      prevCursor: "x",
      hasMore: true,
      nextCursor: "old-a",
      messageCount: 4,
    }),
  });
  const cursor = base.history.nextCursor as string;
  // 別タブで分岐が切り替わり、最新ページ (prevCursor=null) で旧ページが破棄される
  const switched = chatReducer(base, {
    type: "resyncHistory",
    page: historyPage([userMsg("new-a", "new-a"), userMsg("new-b", "new-b")], {
      prevCursor: null,
      hasMore: true,
      nextCursor: "new-a",
      messageCount: 4,
    }),
  });
  assert.deepEqual(entryIds(switched), ["new-a", "new-b"]);
  // 先に取得済みだった旧ブランチのページが遅れて到着する
  const stale = chatReducer(switched, {
    type: "prependHistory",
    cursor,
    page: historyPage([userMsg("old-older", "old-older")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 4,
    }),
  });
  assert.equal(stale, switched, "古い応答は状態を変えない");
  assert.deepEqual(entryIds(stale), ["new-a", "new-b"]);
  assert.equal(stale.history.nextCursor, "new-a", "現行ブランチの遡りを止めない");
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

test("上方向の追加取得を 2 回行っても API の item 数に一致する (legacy 初期表示の重複回帰)", () => {
  const items = Array.from({ length: 110 }, (_, index) => userMsg(`m${index}`, `message ${index}`));
  const legacyMessages = items.map((item) =>
    item.kind === "message" ? { role: item.role, text: item.text } : { role: "user" as const, text: "" },
  );
  const legacy = chatReducer(initialChatState, { type: "resync", payload: payload(legacyMessages) });
  assert.equal(legacy.bubbles.length, 110, "legacy 初期表示は API の item 数と一致する");

  // 最新ページ m60..m109
  const withLatest = chatReducer(legacy, {
    type: "resyncHistory",
    page: historyPage(items.slice(60), { prevCursor: "outside", hasMore: true, nextCursor: "m60", messageCount: 110 }),
  });
  assert.equal(withLatest.bubbles.length, 110, "最新ページ適用でも行数が増えない");
  assert.equal(withLatest.bubbles.filter((bubble) => bubble.entryId !== undefined).length, 50);

  // 上方向 1 回目 m10..m59
  const first = chatReducer(withLatest, {
    type: "prependHistory",
    cursor: withLatest.history.nextCursor as string,
    page: historyPage(items.slice(10, 60), { prevCursor: "m9", hasMore: true, nextCursor: "m10", messageCount: 110 }),
  });
  assert.equal(first.bubbles.length, 110, "1 回目の追加取得で重複しない");
  assert.equal(first.bubbles.filter((bubble) => bubble.entryId !== undefined).length, 100);
  assert.equal(first.bubbles.filter((bubble) => bubble.entryId === undefined).length, 10);

  // 上方向 2 回目 m0..m9
  const second = chatReducer(first, {
    type: "prependHistory",
    cursor: first.history.nextCursor as string,
    page: historyPage(items.slice(0, 10), { prevCursor: null, hasMore: false, nextCursor: null, messageCount: 110 }),
  });
  assert.equal(second.bubbles.length, 110, "2 回目の追加取得で重複しない");
  assert.equal(
    second.bubbles.every((bubble) => bubble.entryId !== undefined),
    true,
  );
  assert.equal(new Set(second.bubbles.map((bubble) => bubble.entryId)).size, 110);
  assert.deepEqual(
    second.bubbles.map((bubble) => bubble.text),
    items.map((item) => (item.kind === "message" ? item.text : "")),
  );
});

test("再構築後に上方向取得しても carried live が item と重複しない", () => {
  const legacy = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([
      { role: "user", text: "l0" },
      { role: "user", text: "l1" },
      { role: "user", text: "l2" },
      { role: "user", text: "l3" },
    ]),
  });
  // 本文が違う最新ページでは carried に残る
  const withPage = chatReducer(legacy, {
    type: "resyncHistory",
    page: historyPage([userMsg("p0", "p0"), userMsg("p1", "p1")], {
      prevCursor: "x",
      hasMore: true,
      nextCursor: "p0",
      messageCount: 6,
    }),
  });
  assert.equal(withPage.bubbles.filter((bubble) => bubble.entryId === undefined).length, 4);

  // 欠落区間が 1 ページに収まらず、最新ページで再構築
  const pending = chatReducer(withPage, {
    type: "resyncHistory",
    page: historyPage([userMsg("q0", "q0"), userMsg("q1", "q1")], {
      prevCursor: "y",
      hasMore: true,
      nextCursor: "q0",
      messageCount: 8,
    }),
  });
  assert.equal(pending.history.gapCursor, "q0");
  const rebuilt = chatReducer(pending, {
    type: "historyGap",
    cursor: "q0",
    page: historyPage([userMsg("z0", "z0")], { prevCursor: "z", messageCount: 8 }),
  });
  assert.equal(rebuilt.bubbles.length, 6, "再構築は carried live を残す");

  // 上方向 1 回目: l0,l1 を消費し、残りは追加分の手前へ
  const first = chatReducer(rebuilt, {
    type: "prependHistory",
    cursor: rebuilt.history.nextCursor as string,
    page: historyPage([userMsg("r0", "l0"), userMsg("r1", "l1")], {
      prevCursor: null,
      hasMore: true,
      nextCursor: "r0",
      messageCount: 8,
    }),
  });
  assert.deepEqual(
    first.bubbles.map((bubble) => bubble.text),
    ["l2", "l3", "l0", "l1", "q0", "q1"],
  );
  assert.equal(first.bubbles.filter((bubble) => bubble.entryId === undefined).length, 2);

  // 上方向 2 回目: 残りも消費して重複なし
  const second = chatReducer(first, {
    type: "prependHistory",
    cursor: first.history.nextCursor as string,
    page: historyPage([userMsg("s0", "l2"), userMsg("s1", "l3")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 8,
    }),
  });
  assert.equal(second.bubbles.length, 6);
  assert.equal(
    second.bubbles.some((bubble) => bubble.entryId === undefined),
    false,
  );
  assert.equal(new Set(second.bubbles.map((bubble) => bubble.entryId)).size, 6);
});

test("保持分が最新ページと同一の再同期では gap 取得を要求しない", () => {
  const items = Array.from({ length: 5 }, (_, index) => userMsg(`m${index}`, `m${index}`));
  const latest = historyPage(items, { prevCursor: "outside", hasMore: true, nextCursor: "m0", messageCount: 10 });
  const first = chatReducer(initialChatState, { type: "resyncHistory", page: latest });
  const again = chatReducer(first, { type: "resyncHistory", page: latest });
  assert.equal(again.history.gapCursor, null, "同一ページの再同期で gap にしない");
  assert.equal(again.history.pendingPage, null);
  assert.deepEqual(
    entryIds(again),
    items.map((item) => item.id),
  );
});

test("compaction marker 付きの legacy 初期状態でも gap 取得を要求しない", () => {
  const legacyPayload = payload([
    { role: "user", text: "m1" },
    { role: "user", text: "m2" },
  ]);
  legacyPayload.compactions = [
    {
      id: "c1",
      parentId: null,
      timestamp: "",
      summary: "要約",
      firstKeptEntryId: "",
      tokensBefore: 1,
      beforeMessageIndex: 1,
    },
  ];
  const legacy = chatReducer(initialChatState, { type: "resync", payload: legacyPayload });
  assert.equal(legacy.dividers.length, 1, "legacy の区切りができている (再現条件)");
  const applied = chatReducer(legacy, {
    type: "resyncHistory",
    page: historyPage([userMsg("m1", "m1"), userMsg("m2", "m2")], {
      prevCursor: "outside",
      hasMore: true,
      nextCursor: "m1",
      messageCount: 4,
    }),
  });
  assert.equal(applied.history.gapCursor, null, "初回表示で gap にしない");
  assert.equal(applied.history.pendingPage, null);
  assert.deepEqual(entryIds(applied), ["m1", "m2"]);
  assert.deepEqual(applied.dividers, [], "legacy の区切りは履歴ページの区切りへ置き換わる");
});

test("欠落区間が埋まらないときは gap ページを捨てずに組み込み、同じ before を再取得しない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1"), userMsg("h2", "h2")], { hasMore: false, messageCount: 2 }),
  });
  // 最新ページは保持分と繋がらず、直前の item は gap ページの末尾 (q2)
  const pending = historyPage([userMsg("p1", "p1"), userMsg("p2", "p2")], {
    prevCursor: "q2",
    hasMore: true,
    nextCursor: "p1",
    messageCount: 6,
  });
  const detected = chatReducer(base, { type: "resyncHistory", page: pending });
  assert.equal(detected.history.gapCursor, "p1");
  // gap ページも保持分とは繋がらない (1 ページに収まらない欠落) が、最新ページとは連続している
  const gapPage = historyPage([userMsg("q1", "q1"), userMsg("q2", "q2")], {
    prevCursor: "x8",
    hasMore: true,
    nextCursor: "q1",
    messageCount: 6,
  });
  const rebuilt = chatReducer(detected, { type: "historyGap", cursor: "p1", page: gapPage });
  assert.deepEqual(entryIds(rebuilt), ["q1", "q2", "p1", "p2"], "gap ページを破棄しない");
  assert.equal(rebuilt.history.nextCursor, "q1", "次は gap ページより古い範囲を取る");
  assert.notEqual(rebuilt.history.nextCursor, detected.history.gapCursor, "同じ before を再取得しない");
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
    cursor: base.history.nextCursor as string,
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

/** レビューの再現: old -> 自分の pending エコー -> 別タブの同一文面 entry -> run_start */
test("別タブの同一文面 entry では run_start が自分の送信中エコーを消さない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old")], { hasMore: true, nextCursor: "old", messageCount: 1 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  // 自分の送信応答で run id を結び付ける
  const assigned = chatReducer(echoed, { type: "echoRunId", runId: "run-mine" });
  assert.equal(assigned.bubbles.find((bubble) => bubble.id === echoId)?.runId, "run-mine");

  // 別タブの同一文面 entry が resync で載る
  const foreign = chatReducer(assigned, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old"), userMsg("foreign", "同じ質問", "run-foreign")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 2,
    }),
  });
  assert.equal(
    foreign.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "別タブの entry ではページ適用時にエコーを消さない",
  );

  // 別タブの run_start (同一文面・別 run)
  const foreignRun = chatReducer(foreign, {
    type: "runStart",
    runId: "run-foreign",
    prompt: "同じ質問",
    at: 3,
    startedAt: 3,
  });
  assert.equal(
    foreignRun.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "別 run の run_start ではエコーを消さない",
  );
  assert.deepEqual(
    foreignRun.bubbles.map((bubble) => bubble.text),
    ["old", "同じ質問", "同じ質問"],
    "old + foreign + 自分のエコー",
  );

  // 自分の run_start でも、自分の entry がまだ無ければ保持する
  const mineRun = chatReducer(foreignRun, {
    type: "runStart",
    runId: "run-mine",
    prompt: "同じ質問",
    at: 4,
    startedAt: 4,
  });
  assert.equal(
    mineRun.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "entry が無い間は保持する",
  );

  // 自分の entry (run-mine) がページに載った時点で置き換わる
  const withMine = chatReducer(mineRun, {
    type: "resyncHistory",
    page: historyPage(
      [userMsg("old", "old"), userMsg("foreign", "同じ質問", "run-foreign"), userMsg("mine", "同じ質問", "run-mine")],
      { prevCursor: null, hasMore: false, nextCursor: null, messageCount: 3 },
    ),
  });
  assert.equal(
    withMine.bubbles.some((bubble) => bubble.id === echoId),
    false,
    "自分の entry へ吸収する",
  );
  assert.deepEqual(
    withMine.bubbles.filter((bubble) => bubble.text === "同じ質問").map((bubble) => bubble.entryId),
    ["foreign", "mine"],
  );
  assert.deepEqual(withMine.pendingEchoIds, []);
});

test("preflight compaction で自分の entry が先に載ったらページ適用時に吸収する", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old")], { hasMore: true, nextCursor: "old", messageCount: 1 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  const assigned = chatReducer(echoed, { type: "echoRunId", runId: "run-mine" });

  const page = historyPage([userMsg("old", "old"), userMsg("mine", "同じ質問", "run-mine")], {
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    messageCount: 2,
  });
  const merged = chatReducer(assigned, { type: "resyncHistory", page });
  assert.equal(
    merged.bubbles.some((bubble) => bubble.id === echoId),
    false,
    "自分の entry へ吸収する",
  );
  assert.deepEqual(
    merged.bubbles.filter((bubble) => bubble.text === "同じ質問").map((bubble) => bubble.entryId),
    ["mine"],
    "二重表示しない",
  );
  assert.deepEqual(merged.pendingEchoIds, []);

  // 遅れて届いた自分の run_start も二重に足さない
  const started = chatReducer(merged, {
    type: "runStart",
    runId: "run-mine",
    prompt: "同じ質問",
    at: 3,
    startedAt: 3,
  });
  assert.equal(started.bubbles.filter((bubble) => bubble.text === "同じ質問").length, 1);
});

test("ページが送信応答より先に届いても、run id の結び付きでエコーを吸収する", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old")], { hasMore: true, nextCursor: "old", messageCount: 1 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  // 応答 (echoRunId) より先に自分の entry が載る
  const pageFirst = chatReducer(echoed, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old"), userMsg("mine", "同じ質問", "run-mine")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 2,
    }),
  });
  assert.equal(
    pageFirst.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "run id が無いうちは保持する",
  );
  const assigned = chatReducer(pageFirst, { type: "echoRunId", runId: "run-mine" });
  assert.equal(
    assigned.bubbles.some((bubble) => bubble.id === echoId),
    false,
    "応答時に吸収する",
  );
  assert.deepEqual(assigned.pendingEchoIds, []);
});

test("run_start が応答より先でも、run id の結び付きでエコー本文を展開後の形へ差し替える", () => {
  const block = '<skill name="writer" location="/skills/writer.md">\n本文\n</skill>\n\n3行で書いて';
  const echoed = chatReducer(initialChatState, {
    type: "localUser",
    text: "/skill:writer 3行で書いて",
    at: 2,
  });
  const echoId = echoed.pendingEchoIds[0];
  // 別 run の run_start では本文も待ち行列も触らない
  const foreignStart = chatReducer(echoed, {
    type: "runStart",
    runId: "run-foreign",
    prompt: "別の本文",
    at: 3,
    startedAt: 3,
  });
  assert.equal(
    foreignStart.bubbles.find((bubble) => bubble.id === echoId)?.text,
    "/skill:writer 3行で書いて",
    "別 run の本文へ差し替えない",
  );
  // 自分の run_start が先に届いても、応答 (echoRunId) までは素の本文のまま
  const mineStart = chatReducer(foreignStart, {
    type: "runStart",
    runId: "run-mine",
    prompt: block,
    at: 4,
    startedAt: 4,
  });
  assert.equal(mineStart.bubbles.find((bubble) => bubble.id === echoId)?.text, "/skill:writer 3行で書いて");
  const assigned = chatReducer(mineStart, { type: "echoRunId", runId: "run-mine" });
  assert.equal(assigned.bubbles.find((bubble) => bubble.id === echoId)?.text, block, "応答で展開後の本文へ差し替える");
  assert.equal(assigned.runPrompts["run-mine"], undefined, "使った本文は残さない");
});

test("送信応答がまだでも、別 run の run_start では pending エコーを消さない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old")], { hasMore: true, nextCursor: "old", messageCount: 1 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  // 自分の応答 (echoRunId) がまだ届いていない状態で、別タブの entry と run_start が届く
  const foreign = chatReducer(echoed, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old"), userMsg("foreign", "同じ質問", "run-foreign")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 2,
    }),
  });
  const started = chatReducer(foreign, {
    type: "runStart",
    runId: "run-foreign",
    prompt: "同じ質問",
    at: 3,
    startedAt: 3,
  });
  assert.equal(
    started.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "run id が分からないエコーは保持する",
  );
  assert.deepEqual(started.pendingEchoIds, [echoId]);
  assert.deepEqual(
    started.bubbles.map((bubble) => bubble.text),
    ["old", "同じ質問", "同じ質問"],
    "old + foreign + 自分のエコー",
  );
});

test("2 通目がキュー中でも run id は送信ごとに結び付く", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("h1", "h1")], { hasMore: true, nextCursor: "h1", messageCount: 1 }),
  });
  const first = chatReducer(base, { type: "localUser", text: "1通目", at: 2 });
  const firstId = first.pendingEchoIds[0];
  const second = chatReducer(first, { type: "localUser", text: "2通目", at: 3 });
  const secondId = second.pendingEchoIds[1];
  // キュー中でも応答は自分が送った run の id を返す (running 中の run ではない)
  const withFirst = chatReducer(second, { type: "echoRunId", runId: "run-2" });
  const withSecond = chatReducer(withFirst, { type: "echoRunId", runId: "run-3" });
  assert.equal(withSecond.bubbles.find((bubble) => bubble.id === firstId)?.runId, "run-2", "先頭のエコーへ順に結ぶ");
  assert.equal(withSecond.bubbles.find((bubble) => bubble.id === secondId)?.runId, "run-3");
});

/** レビューの再現: 実行途中のサーバー再起動で履歴側の runId だけ失ったケース */
test("runId を失った履歴でも pending エコーを本文の正規形 + since で吸収する", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old")], { hasMore: true, nextCursor: "old", messageCount: 1 }),
  });
  const echoed = chatReducer(base, { type: "localUser", text: "mine", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  const assigned = chatReducer(echoed, { type: "echoRunId", runId: "mine-run" });
  // 実行途中でサーバーが再起動し、再接続の idle resync が届く (run はもう無い)
  const idle = chatReducer(assigned, { type: "resync", payload: payload([{ role: "user", text: "old" }]) });
  assert.deepEqual(idle.pendingEchoIds, [echoId], "再接続では pending を保持する");
  assert.equal(
    idle.bubbles.some((bubble) => bubble.id === echoId),
    true,
  );

  // 復元した履歴 item は runId を持たない (実行時の対応表は再起動で消える)
  const restored = chatReducer(idle, {
    type: "resyncHistory",
    page: historyPage([userMsg("old", "old"), userMsg("mine", "mine")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 2,
    }),
  });
  assert.equal(
    restored.bubbles.some((bubble) => bubble.id === echoId),
    false,
    "エコーを吸収する",
  );
  assert.deepEqual(
    restored.bubbles.map((bubble) => [bubble.entryId, bubble.text]),
    [
      ["old", "old"],
      ["mine", "mine"],
    ],
    "履歴 item の 1 件だけを残す",
  );
  assert.deepEqual(restored.pendingEchoIds, [], "pending を残さない");
});

test("runId を失った履歴でも、since より手前の同一文面へは吸収しない", () => {
  const base = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: historyPage([userMsg("same", "同じ質問"), userMsg("h2", "h2")], {
      prevCursor: "same",
      hasMore: true,
      nextCursor: "same",
      messageCount: 3,
    }),
  });
  // 「同じ質問」は送信時点で既知の h2 より手前にある過去の entry
  const echoed = chatReducer(base, { type: "localUser", text: "同じ質問", at: 2 });
  const echoId = echoed.pendingEchoIds[0];
  const assigned = chatReducer(echoed, { type: "echoRunId", runId: "mine-run" });
  const idle = chatReducer(assigned, { type: "resync", payload: payload([{ role: "user", text: "h2" }]) });
  // 保持していない過去ページが届いても、since (h2) より手前の entry は縮退の対象にしない
  const withPast = chatReducer(idle, {
    type: "resyncHistory",
    page: historyPage([userMsg("same", "同じ質問"), userMsg("h2", "h2")], {
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      messageCount: 3,
    }),
  });
  assert.equal(
    withPast.bubbles.some((bubble) => bubble.id === echoId),
    true,
    "過去の同一文面では消さない",
  );
  assert.deepEqual(withPast.pendingEchoIds, [echoId]);
  assert.deepEqual(
    withPast.bubbles.map((bubble) => bubble.text),
    ["同じ質問", "h2", "同じ質問"],
    "過去の entry + 送信中エコー",
  );
});
