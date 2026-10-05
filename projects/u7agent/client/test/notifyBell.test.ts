// 通知ベルの演出の状態遷移。「押して On にした世代でだけ鳴る」ことを固定する
// (値の立ち上がりで鳴らすと、会話の切替 / リロード / deep link の解決でも鳴ってしまう)。
import assert from "node:assert/strict";
import test from "node:test";
import { initialNotifyBellState, nextNotifyBellState } from "../src/lib/notifyBell";

test("On の値が上がっただけ (世代が同じ) では鳴らない", () => {
  const state = initialNotifyBellState(0);
  const next = nextNotifyBellState(state, { ring: 0, on: true, finished: false });
  assert.equal(next, state);
  assert.equal(next.ringing, false);
});

test("世代が進むと鳴り、Off のあいだは鳴らない", () => {
  const off = initialNotifyBellState(0);
  assert.equal(nextNotifyBellState(off, { ring: 1, on: false, finished: false }), off);
  assert.deepEqual(nextNotifyBellState(off, { ring: 1, on: true, finished: false }), { played: 1, ringing: true });
});

test("演出の終了で止まり、同じ世代では鳴り直さない", () => {
  const playing = nextNotifyBellState(initialNotifyBellState(0), { ring: 1, on: true, finished: false });
  const finished = nextNotifyBellState(playing, { ring: 1, on: true, finished: true });
  assert.deepEqual(finished, { played: 1, ringing: false });
  assert.equal(nextNotifyBellState(finished, { ring: 1, on: true, finished: false }), finished);
});

test("演出中に Off へ戻すと即座に止まる", () => {
  const playing = nextNotifyBellState(initialNotifyBellState(0), { ring: 1, on: true, finished: false });
  assert.deepEqual(nextNotifyBellState(playing, { ring: 1, on: false, finished: false }), {
    played: 1,
    ringing: false,
  });
});

test("Off のまま世代が進んでも鳴らない", () => {
  const off = initialNotifyBellState(0);
  assert.equal(nextNotifyBellState(off, { ring: 3, on: false, finished: false }), off);
});

test("次の世代で鳴り直す", () => {
  const playing = nextNotifyBellState(initialNotifyBellState(0), { ring: 1, on: true, finished: false });
  const finished = nextNotifyBellState(playing, { ring: 1, on: true, finished: true });
  assert.deepEqual(nextNotifyBellState(finished, { ring: 2, on: true, finished: false }), { played: 2, ringing: true });
});
