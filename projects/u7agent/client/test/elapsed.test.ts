// 経過時間表示。境界 (秒 → 分 → 時) と負値の丸めを固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { askUserWaitTotalMs, elapsedBeatIndex, formatElapsed, isElapsedTier, runElapsedMs } from "../src/lib/elapsed";

test("formatElapsed は秒・分・時で刻む", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(1000), "1s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(61_400), "1m 1s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_860_000), "2h 11m");
  assert.equal(formatElapsed(-50), "0s");
});

// What: 演出の拍の境界を 10 秒の刻みで固定する。桁は毎秒変わっても、演出はこの境界でしか出さない。
test("演出の拍は 10 秒ごとに変わる", () => {
  assert.equal(elapsedBeatIndex(0), 0);
  assert.equal(elapsedBeatIndex(9_999), 0, "10s の手前までは同じ拍");
  assert.equal(elapsedBeatIndex(10_000), 1, "10s で拍が変わる");
  assert.equal(elapsedBeatIndex(10_999), 1, "10s と表示されている間は同じ拍");
  assert.equal(elapsedBeatIndex(19_999), 1);
  assert.equal(elapsedBeatIndex(20_000), 2);
  assert.equal(elapsedBeatIndex(600_000), 60);
  assert.equal(elapsedBeatIndex(-50), 0, "負値でも拍を戻さない");
});

test("長いランの色は 1 分から残す", () => {
  assert.equal(isElapsedTier(59_999), false);
  assert.equal(isElapsedTier(60_000), true);
});

// --- 回答待ち (ask_user の実行区間) の控除 ---

const openAsk = (startedAt?: number) => ({ name: "ask_user", startedAt, endedAt: undefined });
const closedAsk = (startedAt: number, endedAt: number) => ({ name: "ask_user", startedAt, endedAt });

// What: 控除は名前が ask_user のカードだけを対象にし、閉じた区間と開いた区間を同じ規則で数える。
// 開いたままの質問を評価時刻で閉じるため、値は now に対して単調になる。
test("回答待ちの和は ask_user の区間だけを足す", () => {
  assert.equal(askUserWaitTotalMs([closedAsk(1_000, 4_000)], 10_000), 3_000);
  assert.equal(askUserWaitTotalMs([{ name: "read", startedAt: 1_000, endedAt: 9_000 }], 10_000), 0);
  assert.equal(askUserWaitTotalMs([openAsk(1_000)], 4_000), 3_000, "開いた区間は評価時刻まで");
  assert.equal(askUserWaitTotalMs([closedAsk(1_000, 9_000)], 5_000), 4_000, "評価時刻より後の終了は切り詰める");
  assert.equal(askUserWaitTotalMs([openAsk()], 10_000), 0, "startedAt が無いカードは区間を作らない");
});

// What: 並行した 2 枚は和集合で数え、同じ実時間を二重に引かない。
test("回答待ちの和は重なった区間を 1 回だけ数える", () => {
  assert.equal(askUserWaitTotalMs([closedAsk(1_000, 5_000), closedAsk(2_000, 6_000)], 10_000), 5_000);
  assert.equal(
    askUserWaitTotalMs([closedAsk(1_000, 3_000), openAsk(2_000)], 6_000),
    5_000,
    "片方だけ終わっていても和集合で数える",
  );
});

// What: 待機中は値が凍り、回答が届くと続きから増える (逆行しない)。
test("回答待ちの間は経過時間が凍り、回答で続きから増える", () => {
  const startedAt = 1_000;
  const waiting = openAsk(5_000);
  assert.equal(runElapsedMs({ startedAt, at: 5_000, tools: [] }), 4_000, "質問の直前まで");
  assert.equal(runElapsedMs({ startedAt, at: 60_000, tools: [waiting] }), 4_000, "待機中は凍る");

  const answered = { ...waiting, endedAt: 8_000 };
  assert.equal(runElapsedMs({ startedAt, at: 8_000, tools: [answered] }), 4_000, "回答直後は同じ値から");
  assert.equal(runElapsedMs({ startedAt, at: 10_000, tools: [answered] }), 6_000, "回答後は増える");
});

// What: startedAt が無いカード (観測されなかった開始 / 旧サーバー) は控除せず、従来どおり数える。
test("startedAt が無いカードは従来どおり待機を含めて数える", () => {
  const noStart = { name: "ask_user", startedAt: undefined, endedAt: 4_000 };
  assert.equal(runElapsedMs({ startedAt: 1_000, at: 11_000, tools: [noStart] }), 10_000);
});
