// 確認・入力ダイアログの待ち行列。モーダルを 1 つに保ち、応答を要求へ取り違えないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createDialogQueue } from "../src/lib/dialogQueue";

const entry = (id: number) => ({ id, request: `要求 ${id}` });

test("開いている要求は 1 つだけ出し、応答の順に次を出す", () => {
  const queue = createDialogQueue<{ id: number; request: string }>();
  queue.push(entry(1));
  queue.push(entry(2));

  assert.equal(queue.head()?.id, 1, "最初の要求だけを出す");
  assert.equal(queue.settle(1), true);
  assert.equal(queue.head()?.id, 2, "応答したら次の要求を出す");
  assert.equal(queue.settle(2), true);
  assert.equal(queue.head(), undefined);
});

test("先の要求を待っている間に来た要求も、順番待ちにして必ず解決できる", () => {
  // ZIP の check 待ちの間に別の行の削除確認が開く、のような競合。先の Promise を捨てると
  // 呼び出し側の finally が走らず、二重送信ガード (実行中のパスを持つ ref) が残る
  const queue = createDialogQueue<{ id: number; request: string }>();
  const resolved: number[] = [];
  queue.push(entry(1));
  queue.push(entry(2));
  for (const id of [2, 1]) {
    if (queue.settle(id)) resolved.push(id);
  }
  assert.deepEqual(resolved, [1], "先頭への応答だけを受け付け、待っている要求は残る");
  assert.equal(queue.head()?.id, 2, "古い応答で取り違えない");
  if (queue.settle(2)) resolved.push(2);
  assert.deepEqual(resolved, [1, 2], "待っていた要求も取り消しで解決できる");
});

test("取り消した後は同じ操作をやり直せる", () => {
  const queue = createDialogQueue<{ id: number; request: string }>();
  queue.push(entry(1));
  assert.equal(queue.settle(1), true);
  assert.equal(queue.settle(1), false, "解決済みの応答は二度受け付けない");

  queue.push(entry(2));
  assert.equal(queue.head()?.id, 2);
  assert.equal(queue.settle(2), true);
});

test("何も出していないときの応答は無視する", () => {
  const queue = createDialogQueue<{ id: number; request: string }>();
  assert.equal(queue.settle(1), false);
  assert.equal(queue.head(), undefined);
});
