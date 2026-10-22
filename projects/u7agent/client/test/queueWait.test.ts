// 待機キュー (まだ実行されていない送信) の表示導出の pure logic テスト。
// 順位はサーバーが配った position を根拠にし、`pendingSends` の並びは順位として数えない。
import assert from "node:assert/strict";
import test from "node:test";
import type { Bubble } from "../src/lib/chatTypes";
import { answerWaitQueueReason, queuedSendsOf } from "../src/lib/queueWait";

function bubble(id: number, queued = true, position?: number): Bubble {
  return {
    id,
    role: "user",
    text: `m${id}`,
    tools: [],
    skillLoads: [],
    ...(queued ? { queued: true, sendId: `run-${id}` } : {}),
    ...(position === undefined ? {} : { queuePosition: position }),
  };
}

test("待機中の送信をサーバーの順位で並べ直し、1 始まりの順位を振り直す", () => {
  // 配列の並び (受理順) ではなく、サーバーが配った順位で並べる。待機していないバブルは載らない
  const sends = queuedSendsOf([bubble(1, true, 2), bubble(2, false), bubble(3, true, 1), bubble(4, true, 3)]);

  assert.deepEqual(sends, [
    { sendId: "run-3", text: "m3", state: "queued", index: 1 },
    { sendId: "run-1", text: "m1", state: "queued", index: 2 },
    { sendId: "run-4", text: "m4", state: "queued", index: 3 },
  ]);
});

test("先頭が抜けると残りの順位が繰り上がる", () => {
  const sends = queuedSendsOf([bubble(1, true, 2), bubble(2, true, 3)]);

  assert.deepEqual(
    sends.map((send) => send.index),
    [1, 2],
  );
});

test("1 件だけのときは順位を出さない (1/1 は雑音)", () => {
  assert.deepEqual(queuedSendsOf([bubble(1, true, 1)]), [{ sendId: "run-1", text: "m1", state: "queued" }]);
  assert.deepEqual(queuedSendsOf([bubble(1)]), [{ sendId: "run-1", text: "m1", state: "queued" }]);
});

test("順位が無い (旧サーバー) ときは番号を出さず、不明な分は後ろへ回す", () => {
  // 一部だけ番号を出すと、不明な分の中で何番目かが読めないため、1 件でも不明なら番号は出さない
  const sends = queuedSendsOf([bubble(1, true, 4), bubble(2, true), bubble(3, true, 1)]);

  assert.deepEqual(
    sends.map((send) => [send.sendId, send.index]),
    [
      ["run-3", undefined],
      ["run-1", undefined],
      ["run-2", undefined],
    ],
    "順位が分かる分は昇順、分からない分は元の並びのまま後ろ",
  );
});

test("待機が無ければ空を返す", () => {
  assert.deepEqual(queuedSendsOf([bubble(1, false), bubble(2, false)]), []);
  assert.deepEqual(queuedSendsOf([]), []);
});

test("回答待ちの run で待つ送信の理由は、質問と待機の両方があるときだけ返す", () => {
  // What: 回答しても実行されないことを示す 1 文。回答可否 (質問の有無) とキューの有無の両方で決まる
  assert.equal(answerWaitQueueReason(1, 2), "回答後、この応答とツールが終わった時点で待機中の送信が反映されます");
  assert.equal(answerWaitQueueReason(0, 2), undefined, "回答待ちが無ければ活動文言に任せる");
  assert.equal(answerWaitQueueReason(2, 0), undefined, "キューが空なら理由が要らない");
  assert.equal(answerWaitQueueReason(0, 0), undefined);
});

test("steering の待機は state を保ち、順位は queued と同じく並べ直す", () => {
  // What: 待機一覧は queued と steering を合わせて数え、行の操作可否は state で分ける
  const steeringBubble: Bubble = {
    id: 9,
    role: "user",
    text: "反映待ち",
    tools: [],
    skillLoads: [],
    queued: true,
    queuedState: "steering",
    sendId: "send-9",
    queuePosition: 1,
  };
  assert.deepEqual(queuedSendsOf([bubble(1, true, 2), steeringBubble]), [
    { sendId: "send-9", text: "反映待ち", state: "steering", index: 1 },
    { sendId: "run-1", text: "m1", state: "queued", index: 2 },
  ]);
});
