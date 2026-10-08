import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedToggleRunner } from "../src/hooks/pinnedToggle";

function pendingRequests() {
  const sent: [string, boolean][] = [];
  const gates: { resolve: (pinned?: boolean) => void; reject: (error: unknown) => void }[] = [];
  return {
    sent,
    gates,
    request: (sessionId: string, pinned: boolean) =>
      new Promise<{ sessionId: string; pinned: boolean }>((resolve, reject) => {
        sent.push([sessionId, pinned]);
        gates.push({
          resolve: (value = pinned) => resolve({ sessionId, pinned: value }),
          reject,
        });
      }),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

test("同じ会話のピン変更は直列化され、後発操作の結果で確定する", async () => {
  const pending = pendingRequests();
  const applied: [string, boolean, string][] = [];
  const runner = createPinnedToggleRunner({
    request: pending.request,
    apply: (id, pinned, spaceId) => applied.push([id, pinned, spaceId]),
    isCurrentSpace: () => true,
    onError: () => assert.fail("成功時に onError を呼んだ"),
  });

  runner.toggle("s-1", false, "space-a");
  runner.toggle("s-1", true, "space-a");
  assert.deepEqual(applied, [
    ["s-1", true, "space-a"],
    ["s-1", false, "space-a"],
  ]);
  await pending.flush();
  assert.deepEqual(pending.sent, [["s-1", true]], "同じ会話へ並行 PATCH を送った");

  pending.gates[0]!.resolve();
  await pending.flush();
  assert.deepEqual(pending.sent, [
    ["s-1", true],
    ["s-1", false],
  ]);
  assert.deepEqual(applied.at(-1), ["s-1", false, "space-a"]);

  pending.gates[1]!.resolve();
  await pending.flush();
  assert.deepEqual(applied.at(-1), ["s-1", false, "space-a"]);
});

test("保存失敗は理由を出し、確定済みの状態へ戻す", async () => {
  const pending = pendingRequests();
  const applied: boolean[] = [];
  const errors: unknown[] = [];
  const runner = createPinnedToggleRunner({
    request: pending.request,
    apply: (_id, pinned) => applied.push(pinned),
    isCurrentSpace: () => true,
    onError: (error) => errors.push(error),
  });

  runner.toggle("s-1", false, "space-a");
  await pending.flush();
  pending.gates[0]!.reject(new Error("保存に失敗しました"));
  await pending.flush();
  assert.deepEqual(applied, [true, false]);
  assert.equal((errors[0] as Error).message, "保存に失敗しました");
});

test("保留中の要求が無いときは一覧で取得した他ブラウザの値を失敗時に復元する", async () => {
  const pending = pendingRequests();
  const applied: boolean[] = [];
  const runner = createPinnedToggleRunner({
    request: pending.request,
    apply: (_id, pinned) => applied.push(pinned),
    isCurrentSpace: () => true,
    onError: () => {},
  });

  runner.toggle("s-1", false, "space-a");
  await pending.flush();
  pending.gates[0]!.resolve(true);
  await pending.flush();

  // 一覧取得で別ブラウザの解除 (false) が反映されてから再度固定し、保存を失敗させる。
  runner.toggle("s-1", false, "space-a");
  await pending.flush();
  pending.gates[1]!.reject(new Error("保存に失敗しました"));
  await pending.flush();

  assert.deepEqual(applied, [true, true, true, false]);
});

test("別スペースへ切り替えた後に届く応答は一覧へ適用しない", async () => {
  const pending = pendingRequests();
  const applied: [string, boolean, string][] = [];
  let currentSpace = "space-a";
  const runner = createPinnedToggleRunner({
    request: pending.request,
    apply: (id, pinned, spaceId) => applied.push([id, pinned, spaceId]),
    isCurrentSpace: (spaceId) => currentSpace === spaceId,
    onError: () => assert.fail("破棄される応答で onError を呼んだ"),
  });

  runner.toggle("same-id", false, "space-a");
  await pending.flush();
  currentSpace = "space-b";
  pending.gates[0]!.resolve();
  await pending.flush();
  assert.deepEqual(applied, [["same-id", true, "space-a"]]);

  runner.toggle("same-id", false, "space-a");
  await pending.flush();
  assert.deepEqual(pending.sent, [["same-id", true]], "古いスペースの保留操作を送った");
});

test("後続の要求が失敗したとき、先行成功の値を復元する", async () => {
  const pending = pendingRequests();
  const applied: boolean[] = [];
  const runner = createPinnedToggleRunner({
    request: pending.request,
    apply: (_id, pinned) => applied.push(pinned),
    isCurrentSpace: () => true,
    onError: () => {},
  });

  runner.toggle("s-1", false, "space-a");
  runner.toggle("s-1", true, "space-a");
  await pending.flush();
  pending.gates[0]!.resolve(true);
  await pending.flush();
  pending.gates[1]!.reject(new Error("失敗"));
  await pending.flush();
  assert.equal(applied.at(-1), true);
});
