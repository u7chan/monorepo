// 待機キューの表示導出 (チップの順位 / 分母と、状態行の件数サマリ) の pure logic テスト。
// 順位はサーバーが配った position を根拠にし、`pendingSends` の並びは順位として数えない。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble } from "../src/lib/chatTypes";
import { queueWaitSummary, queueWaitsOf } from "../src/lib/queueWait";

function bubble(id: number, queued = true, position?: number): Bubble {
  return {
    id,
    role: "user",
    text: `m${id}`,
    tools: [],
    skillLoads: [],
    ...(queued ? { queued: true } : {}),
    ...(position === undefined ? {} : { queuePosition: position }),
  };
}

test("待機中のバブルは受けた順位で並べ直し、1 始まりの順位と件数を返す", () => {
  // 配列の並び (受理順) ではなく、サーバーが配った順位で並べる。待機していないバブルは載らない
  const waits = queueWaitsOf([bubble(1, true, 2), bubble(2, false), bubble(3, true, 1), bubble(4, true, 3)]);

  assert.deepEqual(
    [...waits.entries()],
    [
      [3, { index: 1, total: 3 }],
      [1, { index: 2, total: 3 }],
      [4, { index: 3, total: 3 }],
    ],
  );
  assert.equal(waits.has(2), false);
});

test("先頭が抜けると残りの順位が繰り上がる", () => {
  const waits = queueWaitsOf([bubble(1, true, 2), bubble(2, true, 3)]);

  assert.deepEqual(
    [...waits.values()],
    [
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ],
  );
});

test("1 件だけのときは順位を出さない (1/1 は雑音)", () => {
  assert.deepEqual([...queueWaitsOf([bubble(1, true, 1)]).values()], [{ total: 1 }]);
  assert.deepEqual([...queueWaitsOf([bubble(1)]).values()], [{ total: 1 }]);
});

test("順位が無い (旧サーバー) ときは番号を出さず、不明な分は後ろへ回す", () => {
  // 一部だけ番号を出すと、不明な分の中で何番目かが読めないため、1 件でも不明なら番号は出さない
  const waits = queueWaitsOf([bubble(1, true, 4), bubble(2, true), bubble(3, true, 1)]);

  assert.deepEqual(
    [...waits.entries()],
    [
      [3, { total: 3 }],
      [1, { total: 3 }],
      [2, { total: 3 }],
    ],
    "順位が分かる分は昇順、分からない分は元の並びのまま後ろ",
  );
});

test("待機が無ければ空を返す", () => {
  assert.equal(queueWaitsOf([bubble(1, false), bubble(2, false)]).size, 0);
  assert.equal(queueWaitsOf([]).size, 0);
});

test("状態行のサマリは件数だけを出し、待機の理由は接頭辞で示す", () => {
  assert.equal(queueWaitSummary("実行中…", 2), "実行中… · 待機 2 件");
  assert.equal(queueWaitSummary("圧縮中…", 1), "圧縮中… · 待機 1 件");
  assert.equal(queueWaitSummary("完了", 3), "完了 · 待機 3 件");
  // run が無くキューだけの短い過渡 (resync の queued) は件数だけ
  assert.equal(queueWaitSummary("", 2), "待機 2 件");
});
