// 送信経路の回帰テスト。
//
// 送信先は ensureSession の戻り値で受ける。ensureSession は一覧取得を await するため、
// その間にユーザーが別のチャットへ切り替えられる。切替後も入力とセッションを捨てず、
// 表示 (バブル / 実行状態) は触らないことを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch } from "react";
import type { ChatAction } from "../src/hooks/chatReducer";
import { sendChatMessage, stopRun, type SendChatMessageDeps } from "../src/hooks/sessionActions";
import type { RuntimeStatus } from "../src/hooks/runtimeStatus";
import type { Health, MessageImage, PostMessageResult, StopResult } from "../src/types";

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

function createHarness(overrides: Partial<SendChatMessageDeps> = {}) {
  const record = {
    actions: [] as ChatAction[],
    statuses: [] as RuntimeStatus[],
    posted: [] as Array<{ sessionId: string; text: string; images?: MessageImage[] }>,
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
    ensureSession: async () => "s-1",
    refreshSessions: async () => {
      record.refreshed += 1;
      return [];
    },
    post: async (sessionId, text, images = []) => {
      record.posted.push({ sessionId, text, ...(images.length > 0 ? { images } : {}) });
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

  assert.deepEqual(record.posted, [{ sessionId: "s-1", text: "hello" }]);
  assert.deepEqual(record.sending, [true, false], "送信中フラグは必ず戻す");
  const [user] = actionsOfType(record.actions, "localUser");
  assert.equal(user.text, "hello");
  assert.deepEqual(actionsOfType(record.actions, "setRun"), [
    { type: "setRun", runStatus: "running", queueDepth: 0, activity: "実行を開始しました" },
  ]);
  assert.equal(record.refreshed, 1);
});

test("sends an image-only message and echoes its attachment count", async () => {
  const { record, deps } = createHarness();
  const image: MessageImage = { data: "aGVsbG8=", mimeType: "image/png" };

  await sendChatMessage("", deps, [image]);

  assert.deepEqual(record.posted, [{ sessionId: "s-1", text: "", images: [image] }]);
  const [user] = actionsOfType(record.actions, "localUser");
  assert.equal(user.text, "");
  assert.equal(user.imageCount, 1);
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

  assert.deepEqual(record.posted, [{ sessionId: "s-1", text: "hello" }], "切替後も入力は捨てない");
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

test("stops the displayed session", async () => {
  const record = { actions: [] as ChatAction[] };
  const dispatch: Dispatch<ChatAction> = (value) => {
    record.actions.push(value as ChatAction);
  };
  const stops: string[] = [];

  await stopRun({
    sessionIdRef: { current: "s-1" },
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

test("does nothing when no session is displayed", async () => {
  const record = { actions: [] as ChatAction[] };
  const dispatch: Dispatch<ChatAction> = (value) => {
    record.actions.push(value as ChatAction);
  };
  let called = false;

  await stopRun({
    sessionIdRef: { current: "" },
    stop: async (): Promise<StopResult> => {
      called = true;
      return { ok: true, status: "idle" };
    },
    dispatch,
  });

  assert.equal(called, false);
  assert.deepEqual(record.actions, []);
});
