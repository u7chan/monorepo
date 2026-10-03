import assert from "node:assert/strict";
import test from "node:test";
import { finishOnAnimationEnd } from "../src/lib/animationEnd";

test("対象のアニメーション終了で完了し、タイムアウトと重なっても一度だけ呼ぶ", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = new EventTarget();
  const close = t.mock.fn();
  finishOnAnimationEnd(panel, "0.3s", close);
  panel.dispatchEvent(new Event("animationend"));
  panel.dispatchEvent(new Event("animationend"));
  t.mock.timers.tick(10_000);
  assert.equal(close.mock.callCount(), 1);
});

test("子のアニメーション終了では閉じず、対象自身の終了を待つ", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = new EventTarget();
  const close = t.mock.fn();
  finishOnAnimationEnd(panel, "0.3s", close);
  const childEvent = new Event("animationend");
  Object.defineProperty(childEvent, "target", { value: new EventTarget() });
  panel.dispatchEvent(childEvent);
  assert.equal(close.mock.callCount(), 0);
  panel.dispatchEvent(new Event("animationend"));
  assert.equal(close.mock.callCount(), 1);
});

test("終了イベントが来なくても、リスト内の最長アニメーションを待ってから完了する", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const close = t.mock.fn();
  finishOnAnimationEnd(new EventTarget(), "0s, 0.3s, 180ms", close);
  t.mock.timers.tick(300);
  assert.equal(close.mock.callCount(), 0);
  t.mock.timers.tick(10_000);
  assert.equal(close.mock.callCount(), 1);
});

test("アニメーションなしでも完了し、後から届くイベントで二重に呼ばない", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = new EventTarget();
  const close = t.mock.fn();
  finishOnAnimationEnd(panel, "none", close);
  t.mock.timers.tick(1_000);
  assert.equal(close.mock.callCount(), 1);
  panel.dispatchEvent(new Event("animationend"));
  assert.equal(close.mock.callCount(), 1);
});

test("cleanup 後はイベントでもタイムアウトでも完了処理を呼ばない", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = new EventTarget();
  const close = t.mock.fn();
  const cleanup = finishOnAnimationEnd(panel, "0.3s", close);
  cleanup();
  panel.dispatchEvent(new Event("animationend"));
  t.mock.timers.tick(10_000);
  assert.equal(close.mock.callCount(), 0);
});
