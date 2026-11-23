// 入力欄の送信 1 回分（client/src/lib/composerSubmit.ts）。Enter / フォーム submit / 送信ボタンが通る入口で、
// 音声の操作中と終了直後の保留中に送らないこと・下書きを消さないことを、副作用を差し替えて固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { submitComposer, type ComposerSubmitInput } from "../src/lib/composerSubmit";

/** 送れる既定の入力（各テストは見たい軸だけを差し替える） */
const input = (overrides: Partial<ComposerSubmitInput> = {}): ComposerSubmitInput => ({
  value: "こんにちは",
  suggestionPrompt: "",
  hasAttachment: false,
  runtimeReady: true,
  sending: false,
  settingsChanging: false,
  attachmentsBusy: false,
  voicePhase: "idle",
  voiceHold: false,
  ...overrides,
});

/** 呼ばれた順に副作用を溜める。ガードが効けば何も記録されない */
function handlers() {
  const calls: string[] = [];
  const sent: { text: string; titleSource: string | undefined }[] = [];
  return {
    calls,
    sent,
    handlers: {
      clearDraft: () => calls.push("clearDraft"),
      holdStopPromotion: () => calls.push("holdStopPromotion"),
      clearSuggestion: () => calls.push("clearSuggestion"),
      send: (text: string, titleSource: string | undefined) => {
        calls.push("send");
        sent.push({ text, titleSource });
      },
    },
  };
}

test("音声の操作中（接続中 / 録音中 / 確定待ち）は送らず、下書きも消さない", () => {
  // What: Enter / フォーム submit / 送信ボタンのどれから来ても、この入口で止まる
  for (const voicePhase of ["connecting", "recording", "finalizing"] as const) {
    const run = handlers();
    assert.equal(submitComposer(input({ voicePhase }), run.handlers), false, voicePhase);
    assert.deepEqual(run.calls, [], `${voicePhase} では何もしない`);
  }
});

test("録音の終了直後の保留中も送らない", () => {
  // 取消 / 確定で主スロットが入れ替わった位置を続けて押しても、そのまま送信へ届かない
  const run = handlers();
  assert.equal(submitComposer(input({ voiceHold: true }), run.handlers), false);
  assert.deepEqual(run.calls, []);
});

test("音声が待機なら、本文とタイトル元を渡して下書きを消す", () => {
  const run = handlers();
  assert.equal(submitComposer(input(), run.handlers), true);
  assert.deepEqual(run.calls, ["clearDraft", "holdStopPromotion", "clearSuggestion", "send"]);
  assert.deepEqual(run.sent, [{ text: "こんにちは", titleSource: "こんにちは" }]);
});

test("定型プロンプトは本文へ結合し、タイトル元は結合前の本文にする", () => {
  // 結合後の本文だけを渡すと、タイトルが定型プロンプトの先頭で埋まる
  const run = handlers();
  assert.equal(submitComposer(input({ value: "表にして", suggestionPrompt: "次の表を作る" }), run.handlers), true);
  assert.deepEqual(run.sent, [{ text: "次の表を作る\n\n表にして", titleSource: "表にして" }]);
});

test("本文が空でも添付があれば送れる", () => {
  const run = handlers();
  assert.equal(submitComposer(input({ value: "   ", hasAttachment: true }), run.handlers), true);
  assert.deepEqual(run.sent, [{ text: "", titleSource: undefined }]);
});

test("送れない理由があるときは、下書きもチップも触らない", () => {
  // What: 音声以外の既存のガード（添付のアップロード中 / 未接続 / 送信中 / 設定の変更中 / 空）は変えない
  const blocked: Partial<ComposerSubmitInput>[] = [
    { value: "" },
    { attachmentsBusy: true },
    { runtimeReady: false },
    { sending: true },
    { settingsChanging: true },
    { sendBlockedReason: "上の質問に回答してください" },
  ];
  for (const overrides of blocked) {
    const run = handlers();
    assert.equal(submitComposer(input(overrides), run.handlers), false, JSON.stringify(overrides));
    assert.deepEqual(run.calls, [], JSON.stringify(overrides));
  }
});
