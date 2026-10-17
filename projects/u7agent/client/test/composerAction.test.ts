import assert from "node:assert/strict";

import test from "node:test";
import { composerAction } from "../src/lib/composerAction";

/** 保留なしの既定入力 (各テストは見たい軸だけを差し替える) */
const base = { stopVisible: true, sendable: false, sendBlocked: false, stopPrimaryHeld: false };

test("実行中でなければ送信だけを出す", () => {
  // 停止できる状態でないときに ■ を出すと、押しても何も起きないボタンになる
  assert.equal(composerAction({ ...base, stopVisible: false, sendable: true }), "send");
  assert.equal(composerAction({ ...base, stopVisible: false, sendBlocked: true }), "send");
});

test("実行中で送るものが無ければ停止を主スロットへ入れる", () => {
  // 押せる操作が停止だけなので、送信と入れ替えて主スロットに出す (ChatGPT と同じ形)
  assert.equal(composerAction(base), "stop");
});

test("実行中でも送るものがあれば送信を主に残し、停止を控えに並べる", () => {
  // 送信は中断ではなく待機キューへ積む。停止は待機も破棄するので、下書きを書いている間も押せる位置に残す
  assert.equal(composerAction({ ...base, sendable: true }), "sendAndStop");
});

test("送信が実行中以外の理由で止まっているときは停止を主スロットへ上げない", () => {
  // 回答待ち / モデル未設定 / 添付のアップロード中は、主スロットの下に出る理由や進行中の操作が
  // 次の一手を示している。破壊操作を主スロットへ昇格させると誘導が逆になる
  assert.equal(composerAction({ ...base, sendBlocked: true }), "sendAndStop");
});

test("送信直後の保留中は停止を主スロットへ上げない", () => {
  // 送信で本文が消えた描画で ↑ が ■ へ入れ替わると、同じクリックの続き (二度押し) が停止に届き、
  // 実行の中断と待機キューの破棄が起きる。保留中も控えの ■ は押せるので、止めたいときの逃げ道は残る
  assert.equal(composerAction({ ...base, stopPrimaryHeld: true }), "sendAndStop");
  assert.equal(composerAction({ ...base, stopVisible: false, stopPrimaryHeld: true }), "send");
});
