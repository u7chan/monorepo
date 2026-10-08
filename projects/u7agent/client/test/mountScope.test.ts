import assert from "node:assert/strict";
import test from "node:test";
import { createMountScope } from "../src/hooks/requestGate";

test("旧 mount の遅延応答は切替先の共有エージェント保存値を変更しない", async () => {
  const origin = createMountScope();
  const cleanup = origin.setup();
  const canApply = origin.capture();
  const storage = new Map([["u7agent-agent", "agent-a"]]);
  let resolve!: (id: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  const oldRefresh = pending.then((id) => {
    if (canApply()) storage.set("u7agent-agent", id);
  });
  cleanup();
  storage.set("u7agent-agent", "agent-b");
  resolve("agent-a");
  await oldRefresh;
  assert.equal(storage.get("u7agent-agent"), "agent-b");
});

test("cleanup 後の再 setup でも旧世代や非 active 時に開始した操作は復活しない", () => {
  const scope = createMountScope();
  const cleanup = scope.setup();
  const oldRequest = scope.capture();
  cleanup();
  assert.equal(scope.isActive(), false);
  const afterCleanup = scope.capture();
  const cleanupNext = scope.setup();
  assert.equal(scope.isActive(), true);
  assert.equal(oldRequest(), false);
  assert.equal(afterCleanup(), false);
  const nextRequest = scope.capture();
  assert.equal(nextRequest(), true);
  cleanupNext();
  assert.equal(nextRequest(), false);
});

test("active な mount の応答は共有保存値を更新できる", async () => {
  const scope = createMountScope();
  const cleanup = scope.setup();
  const canApply = scope.capture();
  const storage = new Map([["u7agent-agent", "removed-agent"]]);
  const fallback = await Promise.resolve("agent-general");
  if (canApply()) storage.set("u7agent-agent", fallback);
  assert.equal(storage.get("u7agent-agent"), "agent-general");
  cleanup();
});
