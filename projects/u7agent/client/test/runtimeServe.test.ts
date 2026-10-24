import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeServeController,
  INITIAL_RUNTIME_SERVE_STATE,
  type RuntimeServeState,
} from "../src/lib/runtimeServe";
import type { RuntimeServeStatus } from "../src/types";

const running: RuntimeServeStatus = {
  reachable: true,
  owner: { sessionId: "session-a", title: "会話A" },
  generation: "gen-a",
  command: { cwd: "app", command: "pnpm dev" },
};
const stopped: RuntimeServeStatus = { reachable: false, owner: null, generation: null, command: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<Parameters<typeof createRuntimeServeController>[0]> = {}) {
  let state: RuntimeServeState = INITIAL_RUNTIME_SERVE_STATE;
  const changes: RuntimeServeState[] = [];
  const calls: Array<{ generation: string }> = [];
  const starts: Array<{ sessionId: string; generation: string | null }> = [];
  const controller = createRuntimeServeController({
    getStatus: async () => running,
    start: async (input) => {
      starts.push(input);
      return { ...running, owner: { sessionId: input.sessionId, title: "起動した会話" }, generation: "gen-b" };
    },
    stop: async (input) => {
      calls.push(input);
      return stopped;
    },
    confirm: async () => true,
    onChange: (next) => {
      state = next;
      changes.push(next);
    },
    ...overrides,
  });
  return { controller, calls, starts, changes, state: () => state };
}

test("遅いポーリングは重ねず、応答を捨てずに反映する", async () => {
  const pending = deferred<RuntimeServeStatus>();
  let reads = 0;
  const view = setup({
    getStatus: () => {
      reads += 1;
      return pending.promise;
    },
  });
  const first = view.controller.refresh();
  await view.controller.refresh();
  assert.equal(reads, 1);
  pending.resolve(running);
  await first;
  assert.equal(view.state().status, running);
  assert.equal(view.state().loading, false);
});

test("取得失敗は停止中とは区別し、前回のリンク・操作を無効にする。次の取得で復帰する", async () => {
  let fail = false;
  const view = setup({
    getStatus: async () => {
      if (fail) throw new Error("offline");
      return running;
    },
  });
  await view.controller.refresh();
  fail = true;
  await view.controller.refresh();
  assert.equal(view.state().status, null);
  assert.equal(view.state().failed, true);
  fail = false;
  await view.controller.refresh();
  assert.equal(view.state().status, running);
  assert.equal(view.state().failed, false);
});

test("停止確認の取消は API を呼ばず、二重クリックも停止を重ねない", async () => {
  const answer = deferred<boolean>();
  const view = setup({ confirm: () => answer.promise });
  await view.controller.refresh();
  const action = view.controller.stop();
  assert.equal(view.state().stopping, true);
  await view.controller.stop();
  answer.resolve(false);
  await action;
  assert.deepEqual(view.calls, []);
  assert.equal(view.state().stopping, false);
});

test("停止は確認した世代を送り、先に発行したポーリングで停止後の状態を上書きしない", async () => {
  const old = deferred<RuntimeServeStatus>();
  let reads = 0;
  const view = setup({
    getStatus: () => {
      reads += 1;
      return reads === 1 ? Promise.resolve(running) : old.promise;
    },
  });
  await view.controller.refresh();
  const poll = view.controller.refresh();
  await view.controller.stop();
  assert.deepEqual(view.calls, [{ generation: "gen-a" }]);
  assert.deepEqual(view.state().status, stopped);
  old.resolve(running);
  await poll;
  assert.deepEqual(view.state().status, stopped);
});

test("409 は自動で停止し直さず、理由を残して最新状態を取得する", async () => {
  let attempts = 0;
  const replacement = { ...running, generation: "gen-b" };
  const view = setup({
    getStatus: async () => (attempts ? replacement : running),
    stop: async () => {
      attempts += 1;
      throw new Error("サービスの状態が変わりました");
    },
  });
  await view.controller.refresh();
  await view.controller.stop();
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.equal(view.state().status, replacement);
  assert.match(view.state().error!, /状態が変わりました/);
});

test("画面を閉じた後は取得・確認・停止の遅い応答を適用しない", async () => {
  const pending = deferred<RuntimeServeStatus>();
  const loading = setup({ getStatus: () => pending.promise });
  const read = loading.controller.refresh();
  loading.controller.dispose();
  pending.resolve(running);
  await read;
  assert.equal(loading.changes.length, 0);

  const answer = deferred<boolean>();
  const confirming = setup({ confirm: () => answer.promise });
  await confirming.controller.refresh();
  const action = confirming.controller.stop();
  confirming.controller.dispose();
  const count = confirming.changes.length;
  answer.resolve(true);
  await action;
  assert.deepEqual(confirming.calls, []);
  assert.equal(confirming.changes.length, count);

  const stopResponse = deferred<RuntimeServeStatus>();
  const stopping = setup({ stop: () => stopResponse.promise });
  await stopping.controller.refresh();
  const stop = stopping.controller.stop();
  await Promise.resolve();
  stopping.controller.dispose();
  const updates = stopping.changes.length;
  stopResponse.resolve(stopped);
  await stop;
  assert.equal(stopping.changes.length, updates);
});

const startRequest = {
  sessionId: "session-b",
  confirm: { kind: "confirm" as const, title: "サービスを起動", confirmLabel: "起動する" },
};

test("起動は確認した世代を送り、成功で状態を適用する", async () => {
  const view = setup();
  await view.controller.refresh();
  assert.deepEqual(await view.controller.start(startRequest), { kind: "started" });
  assert.deepEqual(view.starts, [{ sessionId: "session-b", generation: "gen-a" }]);
  assert.equal(view.state().status?.owner?.sessionId, "session-b", "適用するのは応答の状態");
  assert.equal(view.state().starting, null);
});

test("起動の取消は API を呼ばず、二重クリックでも起動を重ねない", async () => {
  const answer = deferred<boolean>();
  const view = setup({ confirm: () => answer.promise });
  await view.controller.refresh();
  const action = view.controller.start(startRequest);
  assert.equal(view.state().starting, "session-b", "確認待ちの対象を持つ");
  assert.deepEqual(await view.controller.start(startRequest), { kind: "cancelled" });
  answer.resolve(false);
  assert.deepEqual(await action, { kind: "cancelled" });
  assert.deepEqual(view.starts, []);
  assert.equal(view.state().starting, null);
});

test("起動の 409 は自動で再試行せず、理由を持ち帰って最新状態を取り直す", async () => {
  let attempts = 0;
  const replacement = { ...running, generation: "gen-b", owner: { sessionId: "session-c", title: "他会話" } };
  const view = setup({
    getStatus: async () => (attempts ? replacement : running),
    start: async () => {
      attempts += 1;
      throw new Error("サービスの状態が変わりました。最新の状態で確認し直してください");
    },
  });
  await view.controller.refresh();
  const result = await view.controller.start(startRequest);
  await Promise.resolve();
  assert.equal(attempts, 1, "確認済みの世代で再試行しない");
  assert.deepEqual(result, {
    kind: "failed",
    error: "サービスの状態が変わりました。最新の状態で確認し直してください",
  });
  assert.equal(view.state().status, replacement, "状態を取り直す");
  // 失敗はどの会話の起動かを知っている呼び出し側 (行) が出す。サービス行の error へは載せない
  assert.equal(view.state().error, undefined);
});

test("画面を閉じた後は起動の確認と応答を適用しない", async () => {
  const answer = deferred<boolean>();
  const confirming = setup({ confirm: () => answer.promise });
  await confirming.controller.refresh();
  const action = confirming.controller.start(startRequest);
  confirming.controller.dispose();
  const count = confirming.changes.length;
  answer.resolve(true);
  assert.deepEqual(await action, { kind: "cancelled" });
  assert.deepEqual(confirming.starts, []);
  assert.equal(confirming.changes.length, count);
});
