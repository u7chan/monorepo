// コピー結果の適用可否 (本番の controller)。会話の切替 (所有部品の remount / 所有者の変更) と
// unmount (invalidate) をまたいで、deferred なクリップボード Promise の古い成否が表示へ適用されない
// ことを固定する。useMessageCopy はこの controller をそのまま使い、React へは snapshot を写すだけ。
import assert from "node:assert/strict";

import test from "node:test";
import { createCopyResultController, type CopyResultSnapshot, type CopyResultTimers } from "../src/lib/copyResult";

/** クリップボードの書き込みを保留する。テストは resolve / reject の順序を決める */
function createDeferredClipboard() {
  const calls: { text: string; resolve: () => void; reject: (error: unknown) => void }[] = [];
  return {
    calls,
    copy: (text: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ text, resolve, reject });
      }),
  };
}

/** 時計を手で進める。`advance` は期限の来たタイマーだけを発火し、解除済みのものは発火しない */
function createManualTimers() {
  const pending = new Map<number, { at: number; handler: () => void; ms: number }>();
  let now = 0;
  let next = 1;
  const timers: CopyResultTimers = {
    set(handler, ms) {
      const handle = next++;
      pending.set(handle, { at: now + ms, handler, ms });
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    pendingMs: () => [...pending.values()].map((entry) => entry.ms),
    advance(ms: number) {
      now += ms;
      for (const [handle, entry] of pending) {
        if (entry.at > now) continue;
        pending.delete(handle);
        entry.handler();
      }
    },
  };
}

function createHarness() {
  const clipboard = createDeferredClipboard();
  const changes: CopyResultSnapshot[] = [];
  const timers = createManualTimers();
  const controller = createCopyResultController({
    copy: clipboard.copy,
    onChange: (snapshot) => changes.push(snapshot),
    timers: timers.timers,
    // 失敗の記録はテストの出力を汚さないように捨てる (表示の検証には使わない)
    reportError: () => {},
  });
  return { clipboard, changes, timers, controller };
}

const EMPTY = { copiedId: "", failure: null };

test("コピー結果: 所有者が A → B に変わったら、A の未完了の成功を B へ適用しない", async () => {
  const { clipboard, changes, controller } = createHarness();
  controller.setOwner("A");
  const copying = controller.copy("0123456789", "copy-session-id");
  // 会話の切替 (所有部品の remount / 所有者の変更) は、開始済みのコピーを失効させる
  controller.setOwner("B");
  clipboard.calls[0].resolve();
  await copying;
  assert.deepEqual(controller.snapshot(), EMPTY);
  assert.ok(
    !changes.some((snapshot) => snapshot.copiedId === "copy-session-id"),
    "切替後に A のコピー成功を表示している",
  );
});

test("コピー結果: 所有者が A → B に変わったら、A の未完了の失敗を B へ適用しない", async () => {
  const { clipboard, changes, controller } = createHarness();
  controller.setOwner("A");
  const copying = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  controller.setOwner("B");
  clipboard.calls[0].reject(new Error("ClipboardFailure_" + "x".repeat(130)));
  await copying;
  assert.deepEqual(controller.snapshot(), EMPTY);
  assert.ok(!changes.some((snapshot) => snapshot.failure !== null), "切替後に A のコピー失敗を表示している");
});

test("コピー結果: A → B → A と戻っても、古い A の結果は戻ってきた A の表示へ適用しない", async () => {
  const { clipboard, controller } = createHarness();
  controller.setOwner("A");
  const oldCopy = controller.copy("old-id", "copy-session-id");
  controller.setOwner("B");
  controller.setOwner("A");
  clipboard.calls[0].resolve();
  await oldCopy;
  assert.deepEqual(controller.snapshot(), EMPTY, "戻ってきた A に古いコピー結果が出ている");

  // 戻った後の新しいコピーは普通に適用される (失効が controller を使えなくしていない)
  const fresh = controller.copy("new-id", "copy-session-id");
  clipboard.calls[1].resolve();
  await fresh;
  assert.deepEqual(controller.snapshot(), { copiedId: "copy-session-id", failure: null });
});

test("コピー結果: unmount の invalidate は未完了の結果を捨て、その後のコピーは動く (StrictMode の再 mount)", async () => {
  const { clipboard, controller } = createHarness();
  controller.setOwner("A");
  const copying = controller.copy("0123456789", "copy-session-id");
  controller.invalidate();
  clipboard.calls[0].resolve();
  await copying;
  assert.deepEqual(controller.snapshot(), EMPTY, "unmount 後に結果を適用している");

  const afterRemount = controller.copy("0123456789", "copy-session-id");
  clipboard.calls[1].resolve();
  await afterRemount;
  assert.equal(controller.snapshot().copiedId, "copy-session-id", "再 mount 後のコピーが適用されない");
});

test("コピー結果: 成功は 2 秒、失敗は 8 秒で消え、所有者の切替はタイマーも捨てる", async () => {
  const { clipboard, timers, controller } = createHarness();
  controller.setOwner("A");

  const success = controller.copy("0123456789", "copy-session-id");
  clipboard.calls[0].resolve();
  await success;
  assert.deepEqual(controller.snapshot(), { copiedId: "copy-session-id", failure: null });
  assert.deepEqual(timers.pendingMs(), [2000]);
  timers.advance(1999);
  assert.equal(controller.snapshot().copiedId, "copy-session-id", "成功の表示が 2 秒より早く消えている");
  timers.advance(1);
  assert.deepEqual(controller.snapshot(), EMPTY, "成功の表示が 2 秒で消えていない");

  const failure = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[1].reject(new Error("suppressed"));
  await failure;
  assert.deepEqual(controller.snapshot().failure?.id, "copy-absolute-path");
  assert.deepEqual(timers.pendingMs(), [8000]);
  timers.advance(7999);
  assert.equal(controller.snapshot().failure?.id, "copy-absolute-path", "失敗の表示が 8 秒より早く消えている");
  timers.advance(1);
  assert.deepEqual(controller.snapshot(), EMPTY, "失敗の表示が 8 秒で消えていない");

  // 表示中のタイマーは所有者の切替で捨てる (切替後の表示を古いタイマーで消さない)
  const pending = controller.copy("0123456789", "copy-session-id");
  clipboard.calls[2].resolve();
  await pending;
  assert.deepEqual(timers.pendingMs(), [2000]);
  controller.setOwner("B");
  assert.deepEqual(timers.pendingMs(), []);
  assert.deepEqual(controller.snapshot(), EMPTY);
});

test("コピー結果: 失敗 → 再失敗 では 2 回目の detail が 8 秒残る (旧タイマーが早期に消さない)", async () => {
  const { clipboard, timers, controller } = createHarness();
  controller.setOwner("A");

  const first = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[0].reject(new Error("first failure"));
  await first;
  assert.equal(controller.snapshot().failure?.detail, "first failure");

  // 1 回目の解除 (8 秒) が来る前に 2 回目が失敗する。旧タイマーは解除され、新しい detail は 8 秒残る
  timers.advance(7000);
  const second = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[1].reject(new Error("second failure"));
  await second;
  assert.equal(controller.snapshot().failure?.detail, "second failure");
  assert.deepEqual(timers.pendingMs(), [8000], "旧タイマーが残っている (新しい表示を早期に消す)");
  timers.advance(1000);
  assert.equal(controller.snapshot().failure?.detail, "second failure", "旧タイマーが 2 回目の detail を消した");
  timers.advance(6999);
  assert.equal(controller.snapshot().failure?.detail, "second failure", "2 回目の detail が 8 秒より早く消えた");
  timers.advance(1);
  assert.deepEqual(controller.snapshot(), EMPTY, "2 回目の detail が 8 秒で消えていない");
});

test("コピー結果: 成功 → 再成功 では 2 回目のチェックが 2 秒残る (旧タイマーが早期に消さない)", async () => {
  const { clipboard, timers, controller } = createHarness();
  controller.setOwner("A");

  const first = controller.copy("old-id", "copy-session-id");
  clipboard.calls[0].resolve();
  await first;
  assert.equal(controller.snapshot().copiedId, "copy-session-id");

  timers.advance(1500);
  const second = controller.copy("new-id", "copy-absolute-path");
  clipboard.calls[1].resolve();
  await second;
  assert.equal(controller.snapshot().copiedId, "copy-absolute-path");
  assert.deepEqual(timers.pendingMs(), [2000], "旧タイマーが残っている (新しいチェックを早期に消す)");
  timers.advance(500);
  assert.equal(controller.snapshot().copiedId, "copy-absolute-path", "旧タイマーが 2 回目のチェックを消した");
  timers.advance(1499);
  assert.equal(controller.snapshot().copiedId, "copy-absolute-path", "2 回目のチェックが 2 秒より早く消えた");
  timers.advance(1);
  assert.deepEqual(controller.snapshot(), EMPTY, "2 回目のチェックが 2 秒で消えていない");
});

test("コピー結果: 失敗 → 所有者切替 / invalidate で旧タイマーが残らず、後の失敗を早期に消さない", async () => {
  const { clipboard, timers, controller } = createHarness();
  controller.setOwner("A");
  const first = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[0].reject(new Error("first failure"));
  await first;
  timers.advance(7000);
  const second = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[1].reject(new Error("second failure"));
  await second;
  controller.setOwner("B");
  assert.deepEqual(timers.pendingMs(), [], "所有者の切替で旧タイマーが残っている");

  // 切替後の失敗は自分の 8 秒だけを持ち、切替前のタイマーに消されない
  const third = controller.copy("/workspace/projects/foo", "copy-absolute-path");
  clipboard.calls[2].reject(new Error("third failure"));
  await third;
  assert.deepEqual(timers.pendingMs(), [8000]);
  timers.advance(1000);
  assert.equal(controller.snapshot().failure?.detail, "third failure", "切替前のタイマーが新しい detail を消した");

  // invalidate (unmount) も同じく未完了タイマーを残さない
  controller.invalidate();
  assert.deepEqual(timers.pendingMs(), [], "invalidate で旧タイマーが残っている");
  assert.deepEqual(controller.snapshot().failure?.detail, "third failure", "invalidate が表示を勝手に消した");
});
