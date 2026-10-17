import assert from "node:assert/strict";

import test from "node:test";
import { composerAction } from "../src/lib/composerAction";

test("実行中でなければ送信だけを出す", () => {
  // 停止できる状態でないときに ■ を出すと、押しても何も起きないボタンになる
  assert.equal(composerAction({ stopVisible: false, sendable: true, sendBlocked: false }), "send");
  assert.equal(composerAction({ stopVisible: false, sendable: false, sendBlocked: true }), "send");
});

test("実行中で送るものが無ければ停止を主スロットへ入れる", () => {
  // 押せる操作が停止だけなので、送信と入れ替えて主スロットに出す (ChatGPT と同じ形)
  assert.equal(composerAction({ stopVisible: true, sendable: false, sendBlocked: false }), "stop");
});

test("実行中でも送るものがあれば送信を主に残し、停止を控えに並べる", () => {
  // 送信は中断ではなく待機キューへ積む。停止は待機も破棄するので、下書きを書いている間も押せる位置に残す
  assert.equal(composerAction({ stopVisible: true, sendable: true, sendBlocked: false }), "sendAndStop");
});

test("送信が実行中以外の理由で止まっているときは停止を主スロットへ上げない", () => {
  // 回答待ち / モデル未設定では、主スロットの下に出る理由 (「上の質問に回答してください」) が
  // 次の操作を示している。破壊操作を主スロットへ昇格させると誘導が逆になる
  assert.equal(composerAction({ stopVisible: true, sendable: false, sendBlocked: true }), "sendAndStop");
});
