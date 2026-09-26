// 送信経路の回帰テスト。
//
// 送信先は ensureSession の戻り値で受ける。ensureSession は一覧取得を await するため、
// その間にユーザーが別のチャットへ切り替えられる。切替後も入力とセッションを捨てず、
// 表示 (バブル / 実行状態) は触らないことを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch } from "react";
import type { ChatAction } from "../src/hooks/chatReducer";
import {
  compactChat,
  sendChatMessage,
  stopRun,
  type CompactChatDeps,
  type SendChatMessageDeps,
} from "../src/hooks/sessionActions";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import type { Health, PostMessageResult, SessionCompactionResult, StopResult } from "../src/types";

const health = (overrides: Partial<Health> = {}): Health => ({ ready: true, ...overrides });

function actionsOfType<T extends ChatAction["type"]>(
  actions: ChatAction[],
  type: T,
): Extract<ChatAction, { type: T }>[] {
  return actions.filter((action): action is Extract<ChatAction, { type: T }> => action.type === type);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function actionRecorder(): { actions: ChatAction[]; dispatch: Dispatch<ChatAction> } {
  const actions: ChatAction[] = [];
  const dispatch: Dispatch<ChatAction> = (value) => {
    actions.push(value as ChatAction);
  };
  return { actions, dispatch };
}

function createHarness(overrides: Partial<SendChatMessageDeps> = {}) {
  const record = {
    actions: [] as ChatAction[],
    statuses: [] as RuntimeStatus[],
    posted: [] as Array<{ sessionId: string; text: string; attachments: string[] }>,
    refreshed: 0,
    sending: [] as boolean[],
  };
  const dispatch: Dispatch<ChatAction> = (value) => {
    record.actions.push(value as ChatAction);
  };
  const deps: SendChatMessageDeps = {
    health: health(),
    busy: false,
    sessionIdRef: { current: "s-1" },
    runStatusRef: { current: "idle" },
    ensureSession: async () => "s-1",
    refreshSessions: async () => {
      record.refreshed += 1;
      return [];
    },
    post: async (sessionId, text, attachments) => {
      record.posted.push({ sessionId, text, attachments });
      return { queued: false, queueDepth: 0 } satisfies PostMessageResult;
    },
    dispatch,
    setSending: (value) => {
      record.sending.push(value);
    },
    setRuntimeStatus: (status) => {
      record.statuses.push(status);
    },
    ...overrides,
  };
  return { record, deps };
}

test("sends to the session returned by ensureSession and starts the run locally", async () => {
  const { record, deps } = createHarness();

  await sendChatMessage("hello", deps);

  assert.deepEqual(record.posted, [{ sessionId: "s-1", text: "hello", attachments: [] }]);
  assert.deepEqual(record.sending, [true, false], "送信中フラグは必ず戻す");
  const [user] = actionsOfType(record.actions, "localUser");
  assert.equal(user.text, "hello");
  assert.deepEqual(actionsOfType(record.actions, "setRun"), [
    { type: "setRun", runStatus: "running", queueDepth: 0, activity: "実行を開始しました" },
  ]);
  assert.equal(record.refreshed, 1);
});

test("keeps the send target but not the display when the chat switches while creating the session", async () => {
  const created = deferred<string>();
  const { record, deps } = createHarness({
    sessionIdRef: { current: "" },
    ensureSession: () => created.promise,
  });

  const running = sendChatMessage("hello", deps);
  // セッション作成の待機中に、サイドバーで別のチャットへ切り替える
  deps.sessionIdRef.current = "s-2";
  created.resolve("s-1");
  await running;

  assert.deepEqual(record.posted, [{ sessionId: "s-1", text: "hello", attachments: [] }], "切替後も入力は捨てない");
  assert.deepEqual(record.actions, [], "切替後の表示 (バブル / 実行状態) は触らない");
  assert.deepEqual(record.sending, [true, false]);
});

test("marks the message as queued when the session is already running", async () => {
  const { record, deps } = createHarness({
    post: async () => ({ queued: true, queueDepth: 3 }),
  });

  await sendChatMessage("hello", deps);

  const [run] = actionsOfType(record.actions, "setRun");
  assert.equal(run.queueDepth, 3);
  assert.equal(run.activity, "実行中のため待機キューに追加しました（3件目）");
});

test("圧縮中の送信は compacting のままキューへ積む", async () => {
  const { record, deps } = createHarness({
    runStatusRef: { current: "compacting" },
    post: async () => ({ queued: true, queueDepth: 2, runId: undefined }),
  });

  await sendChatMessage("hello", deps);

  assert.deepEqual(actionsOfType(record.actions, "setRun"), [
    {
      type: "setRun",
      runStatus: "compacting",
      queueDepth: 2,
      activity: "圧縮中のため待機キューに追加しました（2件目）",
    },
  ]);
});

test("does not send while the runtime is not ready", async () => {
  const { record, deps } = createHarness({
    health: health({ ready: false, error: "APIキーが未設定です" }),
  });

  await sendChatMessage("hello", deps);

  assert.deepEqual(record.posted, []);
  assert.equal(record.statuses.length, 1);
  assert.equal(record.statuses[0].error, true);
  const [activity] = actionsOfType(record.actions, "setActivity");
  assert.equal(activity.text, "APIキーが未設定です");
  assert.equal(record.sending.at(-1), false);
});

test("reports a failed post as a runtime error", async () => {
  const { record, deps } = createHarness({
    post: async () => {
      throw new Error("セッションが見つかりません");
    },
  });

  await sendChatMessage("hello", deps);

  assert.equal(record.statuses.length, 1);
  assert.equal(record.statuses[0].detail, "セッションが見つかりません");
  assert.equal(record.refreshed, 0, "失敗時は一覧を取り直さない");
});

test("ignores empty text and a busy state", async () => {
  const empty = createHarness();
  await sendChatMessage("", empty.deps);
  assert.deepEqual(empty.record.sending, []);
  assert.deepEqual(empty.record.posted, []);

  const busy = createHarness({ busy: true });
  await sendChatMessage("hello", busy.deps);
  assert.deepEqual(busy.record.sending, []);
  assert.deepEqual(busy.record.posted, []);
});

test("passes attachments to the post and clears the chips only after it succeeds", async () => {
  const cleared: number[] = [];
  const { record, deps } = createHarness({
    attachments: ["uploads/a.png", "uploads/b.pdf"],
    onSent: () => {
      cleared.push(1);
    },
  });

  await sendChatMessage("これを見て", deps);

  assert.deepEqual(record.posted, [
    { sessionId: "s-1", text: "これを見て", attachments: ["uploads/a.png", "uploads/b.pdf"] },
  ]);
  assert.equal(cleared.length, 1);
  // ローカルエコーは素の本文のまま (注記込みへ差し替えるのは run_start の責務)
  const [user] = actionsOfType(record.actions, "localUser");
  assert.equal(user.text, "これを見て");
});

test("does not clear the chips when the post fails", async () => {
  const cleared: number[] = [];
  const { record, deps } = createHarness({
    attachments: ["uploads/a.png"],
    onSent: () => {
      cleared.push(1);
    },
    post: async () => {
      throw new Error("セッションが見つかりません");
    },
  });

  await sendChatMessage("これを見て", deps);

  assert.deepEqual(cleared, []);
  assert.equal(record.statuses.length, 1);
  // 失敗したエコーは戻す (次に同じ本文を送っても run_start が取り違えない)
  assert.deepEqual(
    actionsOfType(record.actions, "dropLocalUser"),
    [{ type: "dropLocalUser" }],
    "localUser の後にだけ戻す",
  );
  assert.deepEqual(
    record.actions.map((action) => action.type),
    ["localUser", "dropLocalUser", "setActivity"],
  );
});

test("keeps the local echo when only the runtime check fails before sending", async () => {
  const { record, deps } = createHarness({ health: health({ ready: false, error: "APIキーが未設定です" }) });

  await sendChatMessage("hello", deps);

  assert.deepEqual(actionsOfType(record.actions, "localUser"), []);
  assert.deepEqual(actionsOfType(record.actions, "dropLocalUser"), []);
});

test("does not drop the local echo when the chat switched while creating the session", async () => {
  const created = deferred<string>();
  const { record, deps } = createHarness({
    sessionIdRef: { current: "" },
    ensureSession: () => created.promise,
    post: async () => {
      throw new Error("送信に失敗しました");
    },
  });

  const running = sendChatMessage("hello", deps);
  deps.sessionIdRef.current = "s-2";
  created.resolve("s-1");
  await running;

  // 切替後の表示は触らない (エコーもその戻しも出さない)
  assert.deepEqual(actionsOfType(record.actions, "localUser"), []);
  assert.deepEqual(actionsOfType(record.actions, "dropLocalUser"), []);
  assert.deepEqual(
    record.actions.map((action) => action.type),
    ["setActivity"],
  );
});

test("sends an attachment-only message but ignores an entirely empty one", async () => {
  const withFiles = createHarness({ attachments: ["uploads/a.png"] });
  await sendChatMessage("", withFiles.deps);
  assert.equal(withFiles.record.posted.length, 1);
  const [user] = actionsOfType(withFiles.record.actions, "localUser");
  assert.equal(user.text, "");

  const empty = createHarness();
  await sendChatMessage("", empty.deps);
  assert.deepEqual(empty.record.posted, []);
});

test("stops the displayed session", async () => {
  const record = { actions: [] as ChatAction[] };
  const dispatch: Dispatch<ChatAction> = (value) => {
    record.actions.push(value as ChatAction);
  };
  const stops: string[] = [];

  await stopRun({
    sessionIdRef: { current: "s-1" },
    opsRef: { current: 3 },
    runStatusRef: { current: "running" },
    stop: async (sessionId): Promise<StopResult> => {
      stops.push(sessionId);
      return { ok: true, status: "stopped" };
    },
    dispatch,
  });

  assert.deepEqual(stops, ["s-1"]);
  assert.deepEqual(record.actions, [
    { type: "setRun", runStatus: "stopped", queueDepth: 0, activity: "停止要求を送信しました" },
  ]);
});

test("圧縮中の stop の応答では表示を戻さない", async () => {
  const { actions, dispatch } = actionRecorder();

  await stopRun({
    sessionIdRef: { current: "s-1" },
    opsRef: { current: 0 },
    runStatusRef: { current: "compacting" },
    stop: async () => ({ ok: true, status: "completed" }),
    dispatch,
  });

  // 応答は圧縮前の run の値。状態の正は終端 resync / status
  assert.deepEqual(actions, []);
});

test("stop の応答は、後から入った操作や別セッションには適用しない", async () => {
  const opsRef = { current: 0 };
  const sessionIdRef = { current: "s-1" };
  const { actions, dispatch } = actionRecorder();
  const stopping = stopRun({
    sessionIdRef,
    opsRef,
    runStatusRef: { current: "running" },
    stop: async () => ({ ok: true, status: "stopped" }),
    dispatch,
  });
  // 終端 resync (操作世代が進む) や別会話への切替が先に起きた
  opsRef.current += 1;
  await stopping;
  assert.deepEqual(actions, []);

  const switched = stopRun({
    sessionIdRef,
    opsRef,
    runStatusRef: { current: "running" },
    stop: async () => ({ ok: true, status: "stopped" }),
    dispatch,
  });
  sessionIdRef.current = "s-3";
  await switched;
  assert.deepEqual(actions, []);
});

test("does nothing when no session is displayed", async () => {
  const { actions, dispatch } = actionRecorder();
  let called = false;

  await stopRun({
    sessionIdRef: { current: "" },
    opsRef: { current: 0 },
    runStatusRef: { current: "idle" },
    stop: async (): Promise<StopResult> => {
      called = true;
      return { ok: true, status: "idle" };
    },
    dispatch,
  });

  assert.equal(called, false);
  assert.deepEqual(actions, []);
});

/** api.ts の ApiError と同じ形 (location を参照するため class は読み込まない) */
function apiFailure(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function compactDeps(overrides: Partial<CompactChatDeps> = {}) {
  const { actions, dispatch } = actionRecorder();
  const statuses: RuntimeStatus[] = [];
  const compacted: string[] = [];
  const deps: CompactChatDeps = {
    sessionIdRef: { current: "s-1" },
    opsRef: { current: 0 },
    compact: async (sessionId): Promise<SessionCompactionResult> => {
      compacted.push(sessionId);
      return { sessionId, status: "idle" };
    },
    dispatch,
    setRuntimeStatus: (status) => {
      statuses.push(status);
    },
    ...overrides,
  };
  return { actions, statuses, compacted, deps };
}

test("compactChat は要求とともに操作世代を進め、成功では表示を触らない", async () => {
  const { actions, compacted, deps } = compactDeps();

  await compactChat(deps);

  assert.deepEqual(compacted, ["s-1"]);
  assert.equal(deps.opsRef.current, 1, "同じ表示のまま押し直しても前の応答を捨てられる");
  assert.deepEqual(actions, [], "状態の正は SSE (開始 / 終端 resync と status)");
});

test("compactChat の失敗は状態行に理由を出し、接続状態は通信の失敗だけ変える", async () => {
  const api = compactDeps({
    compact: async () => {
      throw apiFailure("まだ要約できる古い会話がありません", 400);
    },
  });
  await compactChat(api.deps);
  assert.deepEqual(api.actions, [{ type: "setActivity", text: "まだ要約できる古い会話がありません" }]);
  assert.deepEqual(api.statuses, [], "400 は操作の結果で、接続の異常ではない");

  const network = compactDeps({
    compact: async () => {
      throw new Error("Failed to fetch");
    },
  });
  await compactChat(network.deps);
  assert.equal(network.statuses.length, 1);
  assert.equal(network.actions.length, 1);
});

test("compactChat の応答は、後から入った操作や終端 resync の後では適用しない", async () => {
  const { actions, statuses, deps } = compactDeps({
    compact: async () => {
      throw apiFailure("セッションの保存に失敗しました", 500);
    },
  });

  const running = compactChat(deps);
  // 要求の後に終端 resync が届く / 別の操作が始まると世代が進む
  deps.opsRef.current += 1;
  await running;

  assert.deepEqual(actions, [], "SSE が配った新しい状態を古い失敗で上書きしない");
  assert.deepEqual(statuses, []);
});

test("compactChat は表示中のセッションが無ければ何もしない", async () => {
  const { compacted, deps } = compactDeps({ sessionIdRef: { current: "" } });

  await compactChat(deps);

  assert.deepEqual(compacted, []);
  assert.equal(deps.opsRef.current, 0);
});
