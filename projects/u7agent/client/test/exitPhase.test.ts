import assert from "node:assert/strict";
import test from "node:test";
import { exitPhaseAfterAnimation, nextExitPhase } from "../src/lib/exitPhase";

test("閉じた状態から始めた要素は phase が動かない (起動時に退場アニメを再生しない)", () => {
  assert.equal(nextExitPhase("closed", false), "closed");
});

test("開いた状態で生まれた要素はそのままで、閉じたときに退場へ入る", () => {
  assert.equal(nextExitPhase("closed", true), "open");
  assert.equal(nextExitPhase("open", false), "closing");
});

test("退場中は閉じきるまで closing を保つ (再描画のたびに退場をやり直さない)", () => {
  assert.equal(nextExitPhase("closing", false), "closing");
  assert.equal(nextExitPhase("closing", false), "closing");
  assert.equal(exitPhaseAfterAnimation("closing"), "closed");
});

test("退場中に開き直すと open へ戻り、mount を切らない", () => {
  assert.equal(nextExitPhase("closing", true), "open");
});

test("再生していない phase の終了では進めない (遅れて届いた終了で閉じ切らない)", () => {
  assert.equal(exitPhaseAfterAnimation("open"), "open");
  assert.equal(exitPhaseAfterAnimation("closed"), "closed");
});
