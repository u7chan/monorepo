// 履歴ページの取得（最新 / 過去 / 隙間）と、履歴クリアの検知を扱う制御。
// どの応答をどの世代で捨てるか、二重取得をどう防ぐか、クリアをどう見分けるかを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch } from "react";
import { chatReducer, initialChatState, type ChatAction, type ChatState } from "../src/hooks/chatReducer";
import { createSessionHistory } from "../src/hooks/sessionHistory";
import type { HistoryPage, SessionPayload } from "../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** api.ts の ApiError と同じ形（location を参照する class はテストから読み込まない） */
function apiFailure(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function page(id: string, overrides: Partial<HistoryPage> = {}): HistoryPage {
  return {
    sessionId: "s-1",
    items: [{ kind: "message", id, context: "active", role: "user", text: id }],
    nextCursor: null,
    prevCursor: null,
    hasMore: false,
    activeContextStartId: id,
    messageCount: 1,
    summarizedMessageCount: 0,
    ...overrides,
  };
}

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status: "idle",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: 1,
    queueDepth: 0,
    pinned: false,
    lastSeq: 1,
    run: null,
    messages: [{ role: "user", text: "payload 側" }],
    compactions: [],
    ...overrides,
  };
}

function historyState(overrides: Partial<ChatState["history"]> = {}): ChatState["history"] {
  return { ...initialChatState.history, ...overrides };
}

function createHarness(
  requestPage: (sessionId: string, before?: string) => Promise<HistoryPage>,
  options: { sessionId?: string; history?: ChatState["history"] } = {},
) {
  const sessionIdRef = { current: options.sessionId ?? "s-1" };
  const historyStateRef = { current: options.history ?? historyState({ hasMore: true, nextCursor: "m2" }) };
  const actions: ChatAction[] = [];
  const requests: { sessionId: string; before?: string }[] = [];
  const dispatch: Dispatch<ChatAction> = (action) => {
    actions.push(action as ChatAction);
  };
  const history = createSessionHistory({
    sessionIdRef,
    historyStateRef,
    requestPage: (sessionId, before) => {
      requests.push({ sessionId, ...(before === undefined ? {} : { before }) });
      return requestPage(sessionId, before);
    },
    dispatch,
  });
  return { history, actions, requests, sessionIdRef, historyStateRef };
}

test("最新ページは表示中の会話の応答だけを適用する", async () => {
  const applied = deferred<HistoryPage>();
  const { history, actions, sessionIdRef } = createHarness(() => applied.promise);

  // 要求の後に会話が切り替わる（世代が失効する）
  sessionIdRef.current = "s-2";
  const running = history.refresh("s-1");
  applied.resolve(page("m1"));
  await running;
  assert.equal(actions.length, 0, "別の会話の応答で新しい表示を戻さない");

  // 同じ会話なら適用する
  sessionIdRef.current = "s-1";
  const next = history.refresh("s-1");
  await next;
  assert.deepEqual(
    actions.map((action) => action.type),
    ["resyncHistory"],
  );
});

test("呼び出し元の lifecycle が終わっていたら最新ページを適用しない", async () => {
  const { history, actions } = createHarness(async () => page("m1"));
  let current = false;
  await history.refresh("s-1", () => current);
  assert.equal(actions.length, 0);
  current = true;
  await history.refresh("s-1", () => current);
  assert.equal(actions.length, 1);
});

test("discard より前に始めた最新ページは、応答が届いても適用しない", async () => {
  const applied = deferred<HistoryPage>();
  const { history, actions } = createHarness(() => applied.promise);

  const running = history.refresh("s-1");
  // 会話の切替 / 新規チャット / 引き継ぎ後の開き直し
  history.discard();
  applied.resolve(page("m1"));
  await running;

  assert.deepEqual(actions, [], "失効した世代のページを適用しない");
});

test("履歴 API を持たない 404 は、同じ会話の直近 payload があればそれで組み直す", async () => {
  const failing = createHarness(async () => {
    throw apiFailure("履歴 API がありません", 404);
  });
  await failing.history.refresh("s-1");
  assert.deepEqual(failing.actions, [{ type: "historyUnsupported" }]);

  // 直近 payload を受理した後なら payload を渡して組み直す
  const withPayload = createHarness(async () => {
    throw apiFailure("履歴 API がありません", 404);
  });
  withPayload.history.acceptPayload(payload());
  await withPayload.history.refresh("s-1");
  assert.deepEqual(
    withPayload.actions.map((action) => action.type),
    ["historyUnsupported"],
  );
  const [unsupported] = withPayload.actions;
  assert.equal(
    unsupported.type === "historyUnsupported" && unsupported.payload?.sessionId,
    "s-1",
    "同じ会話の payload を渡す",
  );

  // 別の会話の payload は渡さない（前の会話の本文で組み直さない）
  const other = createHarness(async () => {
    throw apiFailure("履歴 API がありません", 404);
  });
  other.history.acceptPayload(payload({ sessionId: "s-2" }));
  await other.history.refresh("s-1");
  assert.deepEqual(other.actions, [{ type: "historyUnsupported" }]);
});

test("404 以外の失敗では表示も履歴の対応可否も変えない", async () => {
  const { history, actions } = createHarness(async () => {
    throw new Error("Failed to fetch");
  });
  await history.refresh("s-1");
  assert.equal(actions.length, 0);
});

test("sessionId が空のときは最新ページを取りに行かない", async () => {
  const { history, requests } = createHarness(async () => page("m1"));
  await history.refresh("");
  assert.deepEqual(requests, []);
});

test("追加取得は取得中の重複と、カーソルの無い / これ以上無いときを止める", async () => {
  const pending = deferred<HistoryPage>();
  const { history, requests, historyStateRef } = createHarness(() => pending.promise);

  const first = history.loadOlder();
  // 取得中に押し直しても 2 本目を出さない
  await history.loadOlder();
  assert.equal(requests.length, 1, "二重取得しない");

  // 取得中に保持分の先頭が変わる（別タブの resync など）
  historyStateRef.current = historyState({ hasMore: true, nextCursor: "m9" });
  pending.resolve(page("m1"));
  await first;

  const older = createHarness(async () => page("m3"), { history: historyState({ hasMore: false }) });
  await older.history.loadOlder();
  assert.deepEqual(older.requests, [], "hasMore が false なら取りに行かない");

  const noCursor = createHarness(async () => page("m3"), { history: historyState({ hasMore: true }) });
  await noCursor.history.loadOlder();
  assert.deepEqual(noCursor.requests, [], "カーソルが無ければ取りに行かない");

  const noSession = createHarness(async () => page("m3"), { sessionId: "" });
  await noSession.history.loadOlder();
  assert.deepEqual(noSession.requests, []);
});

test("追加取得の応答は、取得中にカーソルが変わっていたら混ぜない", async () => {
  const pending = deferred<HistoryPage>();
  const { history, actions, historyStateRef } = createHarness(() => pending.promise);

  const running = history.loadOlder();
  assert.deepEqual(
    actions.map((action) => action.type),
    ["historyLoading"],
    "取得中の表示をする",
  );
  historyStateRef.current = historyState({ hasMore: true, nextCursor: "m9" });
  pending.resolve(page("m1"));
  await running;

  assert.deepEqual(
    actions.filter((action) => action.type === "prependHistory"),
    [],
    "古いカーソルのページを前置きしない",
  );
  assert.deepEqual(
    actions.filter((action) => action.type === "historyLoading").map((action) => action.loading),
    [true, false],
    "破棄された要求の完了でも取得中の表示は戻す",
  );
});

test("追加取得の 400 は最新ページの取り直しへ倒し、それ以外は状態行に理由を出す", async () => {
  const unknownCursor = createHarness(async (_sessionId, before) => {
    if (before === undefined) return page("latest");
    throw apiFailure("不明なカーソルです", 400);
  });
  await unknownCursor.history.loadOlder();
  assert.deepEqual(
    unknownCursor.actions.map((action) => action.type),
    ["historyLoading", "historyLoading", "resyncHistory"],
    "カーソルが無い証拠なので最新ページを取り直す",
  );

  const offline = createHarness(async () => {
    throw new Error("Failed to fetch");
  });
  await offline.history.loadOlder();
  assert.deepEqual(
    offline.actions.filter((action) => action.type === "setActivity").map((action) => action.type),
    ["setActivity"],
  );
  const [activity] = offline.actions.filter((action) => action.type === "setActivity");
  assert.equal(activity.type === "setActivity" && activity.text.includes("Failed to fetch"), true);
});

test("別の会話へ切り替わった後の追加取得の失敗では、状態行も最新ページも触らない", async () => {
  const pending = deferred<HistoryPage>();
  const { history, actions, sessionIdRef } = createHarness(() => pending.promise);

  const running = history.loadOlder();
  sessionIdRef.current = "s-2";
  pending.reject(apiFailure("不明なカーソルです", 400));
  await running;

  assert.deepEqual(
    actions.filter((action) => action.type === "setActivity"),
    [],
    "切替後の会話の状態行を古い失敗で乱さない",
  );
  assert.deepEqual(
    actions.filter((action) => action.type === "resyncHistory"),
    [],
  );
});

test("欠落区間の取得は成功で reducer へ渡し、400 では最新ページを取り直す", async () => {
  const { history, actions, requests } = createHarness(async (_sessionId, before) => page(before ?? "latest"));

  await history.fillGap("gap-1");
  assert.deepEqual(requests, [{ sessionId: "s-1", before: "gap-1" }]);
  assert.deepEqual(
    actions.map((action) => action.type),
    ["historyGap"],
  );

  const stale = createHarness(async (_sessionId, before) => {
    if (before === undefined) return page("latest");
    throw apiFailure("不明なカーソルです", 400);
  });
  await stale.history.fillGap("gap-1");
  assert.deepEqual(
    stale.actions.map((action) => action.type),
    ["resyncHistory"],
    "分岐が変わったら最新ページから取り直す",
  );
});

test("欠落区間の取得の失敗は保留を解いて次の resync で取り直せる", async () => {
  const { history, actions } = createHarness(async () => {
    throw new Error("Failed to fetch");
  });
  await history.fillGap("gap-1");

  assert.deepEqual(
    actions.map((action) => action.type),
    ["historyGapFailed", "setActivity"],
    "保留を解いてから理由を出す",
  );
});

test("同じ会話で履歴世代が変わったら旧カーソル・旧バブル・取得中の旧ページを捨てる", async () => {
  const inFlight = deferred<HistoryPage>();
  let latestRequests = 0;
  const { history, actions } = createHarness((_sessionId, before) => {
    if (before !== undefined) return Promise.resolve(page("older"));
    latestRequests += 1;
    return latestRequests === 1 ? inFlight.promise : Promise.resolve(page("cleared"));
  });

  history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  const running = history.refresh("s-1");
  // クリア後の resync（同じ会話で世代だけが変わる）
  const applied = history.acceptPayload(payload({ historyGeneration: "gen-2" }));
  inFlight.resolve(page("old"));

  assert.equal(applied.messages.length, 0, "旧メッセージは適用しない");
  assert.equal(applied.status, "idle");
  assert.deepEqual(applied.pendingSends, []);
  assert.deepEqual(actions.filter((action) => action.type === "resetHistory").length, 1, "1 回だけ捨てる");
  await running;
  assert.deepEqual(
    actions.filter((action) => action.type === "resyncHistory"),
    [],
    "クリア前の世代のページを適用しない",
  );
});

test("会話の切替・同じ世代・履歴世代を持たない payload では捨てない", async () => {
  const switched = createHarness(async () => page("m1"));
  switched.history.acceptPayload(payload({ sessionId: "s-1", historyGeneration: "gen-1" }));
  // 別の会話の payload は比較しない
  const next = switched.history.acceptPayload(payload({ sessionId: "s-2", historyGeneration: "gen-9" }));
  assert.deepEqual(
    switched.actions.filter((action) => action.type === "resetHistory"),
    [],
  );
  assert.equal(next.messages.length, 1, "別の会話の messages はそのまま適用する");

  const same = createHarness(async () => page("m1"));
  same.history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  same.history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  assert.deepEqual(
    same.actions.filter((action) => action.type === "resetHistory"),
    [],
  );

  // 履歴世代を持たない旧サーバーの payload どうしでは、世代が変わらないので捨てない
  const legacy = createHarness(async () => page("m1"));
  legacy.history.acceptPayload(payload());
  legacy.history.acceptPayload(payload());
  assert.deepEqual(
    legacy.actions.filter((action) => action.type === "resetHistory"),
    [],
  );
});

test("新規チャットは履歴の世代と直近 payload を持ち越さない", async () => {
  const { history, actions } = createHarness(async () => {
    throw apiFailure("履歴 API がありません", 404);
  });
  history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  history.forgetChat();

  // 同じ id の会話でも、新規チャットを挟んだ後は前の世代と比較しない
  const applied = history.acceptPayload(payload({ historyGeneration: "gen-2" }));
  assert.equal(applied.messages.length, 1, "旧メッセージとして捨てない");
  assert.deepEqual(
    actions.filter((action) => action.type === "resetHistory"),
    [],
  );
});

test("新規チャットで捨てた直近 payload は、履歴 API の 404 で組み直しに使わない", async () => {
  const { history, actions } = createHarness(async () => {
    throw apiFailure("履歴 API がありません", 404);
  });
  history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  history.forgetChat();
  await history.refresh("s-1");

  assert.deepEqual(actions, [{ type: "historyUnsupported" }], "前の会話の本文を渡さない");
});

test("片付け待ちのクリアは、開き直さずに手元の履歴だけを捨てる", async () => {
  const { history, actions } = createHarness(async () => page("m1"));
  history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  history.resetForCleanup("s-1", "gen-2");

  assert.deepEqual(
    actions.map((action) => action.type),
    ["resetHistory"],
  );
  // 片付け後の resync は同じ世代なので、二重に捨てない
  history.acceptPayload(payload({ historyGeneration: "gen-2" }));
  assert.deepEqual(
    actions.map((action) => action.type),
    ["resetHistory"],
  );
});

test("クリアの検知は reducer へ流すと旧バブルを残さない", () => {
  // What: acceptPayload の判定（resetHistory + 旧メッセージの除去）を、実際の reducer で確かめる
  let state: ChatState = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: page("m1", { messageCount: 1 }),
  });
  const actions: ChatAction[] = [];
  const history = createSessionHistory({
    sessionIdRef: { current: "s-1" },
    historyStateRef: { current: initialChatState.history },
    requestPage: async () => page("m1"),
    dispatch: (action) => {
      actions.push(action as ChatAction);
    },
  });

  history.acceptPayload(payload({ historyGeneration: "gen-1" }));
  const cleared = history.acceptPayload(payload({ historyGeneration: "gen-2", sessionId: "s-1" }));
  for (const action of actions) state = chatReducer(state, action);
  state = chatReducer(state, { type: "resync", payload: cleared, receivedAt: 1 });

  assert.deepEqual(state.bubbles, [], "旧バブルを残さない");
  assert.equal(state.history.messageCount, 0);
});
