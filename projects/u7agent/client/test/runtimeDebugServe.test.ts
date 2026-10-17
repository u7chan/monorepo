import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeDebugServeController,
  INITIAL_RUNTIME_DEBUG_SERVE_STATE,
  runtimeDebugServeStopConfirm,
  type RuntimeDebugServeState,
} from "../src/lib/runtimeDebugServe";
import type { RuntimeDebugServeStatus } from "../src/types";

const owner = { sessionId: "session-a", title: "会話A", spaceId: "space-1111111111111111" };
const tracked = {
  port: 18000,
  owner,
  command: "pnpm dev --port $U7AGENT_DEBUG_PORT",
  startedAt: 1_700_000_000_000,
};
const running: RuntimeDebugServeStatus = {
  servers: [tracked, { port: 18005, owner: null, command: null, startedAt: null }],
};
const empty: RuntimeDebugServeStatus = { servers: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<Parameters<typeof createRuntimeDebugServeController>[0]> = {}) {
  let state: RuntimeDebugServeState = INITIAL_RUNTIME_DEBUG_SERVE_STATE;
  const changes: RuntimeDebugServeState[] = [];
  const calls: Array<{ port: number }> = [];
  const controller = createRuntimeDebugServeController({
    getStatus: async () => running,
    stop: async (input) => {
      calls.push(input);
      return { port: input.port, released: true, alreadyStopped: false };
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

test("確認ダイアログは一覧の値だけで組み、追跡外では起動元を出さない", () => {
  const trackedRequest = runtimeDebugServeStopConfirm(tracked);
  assert.equal(trackedRequest.kind, "confirm");
  assert.equal(trackedRequest.subject?.value, "18000");
  assert.equal(trackedRequest.code?.value, tracked.command);
  assert.match(trackedRequest.notes?.join("\n") ?? "", /起動元の会話: 会話A/);
  assert.match(trackedRequest.notes?.join("\n") ?? "", /起動時刻: /);
  assert.match(trackedRequest.body?.join("\n") ?? "", /起動時と入れ替わっていれば停止しません/);
  assert.equal(trackedRequest.danger, true);

  // 追跡外は起動元も起動時刻も無い (一覧にあるポートと「所有者不明」だけを示す)
  const untrackedRequest = runtimeDebugServeStopConfirm(running.servers[1]);
  assert.equal(untrackedRequest.subject?.value, "18005");
  assert.equal(untrackedRequest.code, undefined);
  assert.equal(untrackedRequest.notes, undefined);
  assert.match(untrackedRequest.body?.join("\n") ?? "", /起動元は追跡できていません/);
});

test("遅いポーリングは重ねず、応答を捨てずに反映する", async () => {
  const pending = deferred<RuntimeDebugServeStatus>();
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

test("取得失敗はデバッグ節だけを空にし、次の取得で復帰する", async () => {
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

test("一覧にないポートの停止は何もしない", async () => {
  const view = setup();
  await view.controller.refresh();
  await view.controller.stop(18099);
  assert.deepEqual(view.calls, []);
  assert.equal(view.state().stoppingPort, null);
});

test("停止確認の取消は API を呼ばず、二重クリックも停止を重ねない", async () => {
  const answer = deferred<boolean>();
  const view = setup({ confirm: () => answer.promise });
  await view.controller.refresh();
  const action = view.controller.stop(18000);
  assert.equal(view.state().stoppingPort, 18000);
  await view.controller.stop(18005);
  answer.resolve(false);
  await action;
  assert.deepEqual(view.calls, []);
  assert.equal(view.state().stoppingPort, null);
});

test("停止は確認したポートを送り、先に発行したポーリングで停止後の一覧を上書きしない", async () => {
  const old = deferred<RuntimeDebugServeStatus>();
  let reads = 0;
  const view = setup({
    getStatus: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve(running);
      return reads === 2 ? old.promise : Promise.resolve(empty);
    },
  });
  await view.controller.refresh();
  const poll = view.controller.refresh();
  await view.controller.stop(18000);
  assert.deepEqual(view.calls, [{ port: 18000 }]);
  assert.deepEqual(view.state().status, empty, "停止後の取得で一覧が消える");
  old.resolve(running);
  await poll;
  assert.deepEqual(view.state().status, empty, "停止前のポーリングで上書きされない");
  assert.equal(view.state().stoppingPort, null);
});

test("停止後の一覧は停止応答ではなく取り直した値にする", async () => {
  const stillRunning: RuntimeDebugServeStatus = { servers: [running.servers[1]] };
  let reads = 0;
  const view = setup({
    getStatus: async () => {
      reads += 1;
      return reads === 1 ? running : stillRunning;
    },
  });
  await view.controller.refresh();
  await view.controller.stop(18000);
  assert.deepEqual(view.state().status, stillRunning, "残った追跡外のポートは一覧に残す");
});

test("停止後の取り直しが失敗したら、古い一覧ではなく取得失敗として見せる", async () => {
  let reads = 0;
  const view = setup({
    getStatus: async () => {
      reads += 1;
      if (reads === 1) return running;
      throw new Error("offline");
    },
  });
  await view.controller.refresh();
  await view.controller.stop(18000);
  assert.deepEqual(view.calls, [{ port: 18000 }]);
  assert.equal(view.state().status, null);
  assert.equal(view.state().failed, true);
  assert.equal(view.state().error, undefined, "取得の失敗を停止の失敗にしない");
});

test("停止の失敗は理由を残し、自動では停止し直さない", async () => {
  let attempts = 0;
  const replacement: RuntimeDebugServeStatus = { servers: [{ ...tracked, command: "pnpm dev --port 18000" }] };
  const view = setup({
    getStatus: async () => (attempts ? replacement : running),
    stop: async () => {
      attempts += 1;
      throw new Error("デバッグ用 serve の待受プロセスが起動時と一致しないため停止しませんでした");
    },
  });
  await view.controller.refresh();
  await view.controller.stop(18000);
  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.deepEqual(view.state().status, replacement);
  assert.match(view.state().error!, /一致しないため停止しませんでした/);
});

test("画面を閉じた後は取得・確認・停止の遅い応答を適用しない", async () => {
  const pending = deferred<RuntimeDebugServeStatus>();
  const loading = setup({ getStatus: () => pending.promise });
  const read = loading.controller.refresh();
  loading.controller.dispose();
  pending.resolve(running);
  await read;
  assert.equal(loading.changes.length, 0);

  const answer = deferred<boolean>();
  const confirming = setup({ confirm: () => answer.promise });
  await confirming.controller.refresh();
  const action = confirming.controller.stop(18000);
  confirming.controller.dispose();
  const count = confirming.changes.length;
  answer.resolve(true);
  await action;
  assert.deepEqual(confirming.calls, []);
  assert.equal(confirming.changes.length, count);

  const stopResponse = deferred<unknown>();
  const stopping = setup({ stop: () => stopResponse.promise });
  await stopping.controller.refresh();
  const stop = stopping.controller.stop(18000);
  await Promise.resolve();
  stopping.controller.dispose();
  const updates = stopping.changes.length;
  stopResponse.resolve({ port: 18000, released: true, alreadyStopped: false });
  await stop;
  assert.equal(stopping.changes.length, updates);
});
