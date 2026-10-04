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
  const controller = createRuntimeServeController({
    getStatus: async () => running,
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
  return { controller, calls, changes, state: () => state };
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
