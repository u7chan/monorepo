import assert from "node:assert/strict";

import test from "node:test";
import { composerAction, composerPrimaryStop, composerSecondaryStop } from "../src/lib/composerAction";

/** 保留なしの既定入力 (各テストは見たい軸だけを差し替える) */
const base = {
  stopVisible: true,
  sendable: false,
  sendBlocked: false,
  stopPrimaryHeld: false,
  voicePhase: "idle" as const,
};

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

test("録音の終了直後の保留中も停止を主スロットへ上げない", () => {
  // What: `stopPrimaryHeld` は送信直後 (sendHold) と録音の終了直後 (voiceHold) の両方で立つ。
  // 実行中で送るものが無くても主スロットを押せる ■ にしない（取消 / 確定の二度押しが run を落とす）
  assert.equal(composerAction({ ...base, stopVisible: true, sendable: false, stopPrimaryHeld: true }), "sendAndStop");
  assert.equal(composerAction({ ...base, stopVisible: true, sendable: false, stopPrimaryHeld: false }), "stop");
});

test("音声が待機の間は従来の 3 値から何も変えない", () => {
  // What: 録音のために run / 圧縮 / 待機キューの停止導線を落とさない
  assert.equal(composerAction({ ...base, voicePhase: "idle" }), "stop");
  assert.equal(composerAction({ ...base, sendable: true, voicePhase: "idle" }), "sendAndStop");
  assert.equal(composerAction({ ...base, stopVisible: false, voicePhase: "idle" }), "send");
});

test("接続中・録音中・確定待ちは主スロットを音声の操作へ譲る", () => {
  // What: 音声の操作中は ↑ も ■ も主スロットへ出さない（送るものがあるかどうかで出し分けない）
  for (const sendable of [false, true]) {
    for (const sendBlocked of [false, true]) {
      assert.equal(composerAction({ ...base, sendable, sendBlocked, voicePhase: "connecting" }), "voiceCancel");
      assert.equal(composerAction({ ...base, sendable, sendBlocked, voicePhase: "recording" }), "voiceStop");
      assert.equal(composerAction({ ...base, sendable, sendBlocked, voicePhase: "finalizing" }), "voiceFinalizing");
    }
  }
});

test("音声の操作中も既存の停止は副スロットに残し、run が終われば消える", () => {
  // What: run 単独 / 圧縮 / 待機キューのどれで止まっても、音声の操作中は ■ を押せる位置に残す
  for (const voicePhase of ["voiceCancel", "voiceStop", "voiceFinalizing"] as const) {
    assert.equal(composerSecondaryStop(voicePhase), true, voicePhase);
    assert.equal(composerPrimaryStop(voicePhase), false, "録音停止 ● を ■ と取り違えない");
  }
  // stopVisible が false になれば副スロットの ■ は描かない（押しても止めるものが無い）
  const action = composerAction({ ...base, stopVisible: false, voicePhase: "recording" });
  assert.equal(action, "voiceStop");
  assert.equal(composerSecondaryStop(action), true, "判定は phase だけを見る (描画側が stopVisible で絞る)");
});

test("音声が待機へ戻れば従来の 3 値へ戻る", () => {
  assert.equal(composerAction({ ...base, voicePhase: "idle" }), "stop");
  assert.equal(composerPrimaryStop("stop"), true);
  assert.equal(composerSecondaryStop("stop"), false);
});
