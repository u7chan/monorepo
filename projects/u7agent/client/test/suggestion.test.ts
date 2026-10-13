// 定型プロンプトのチップの純関数。送信本文の組み立てと、backspace で外すかの判定を固定する
// (どちらも実 DOM を要さない規則で、Composer から呼ぶ正はこの module に置く)。
import assert from "node:assert/strict";
import test from "node:test";
import { shouldClearSuggestionOnBackspace, suggestionSendText, type SuggestionKeyState } from "../src/lib/suggestion";

const backspace = (overrides: Partial<SuggestionKeyState> = {}): SuggestionKeyState => ({
  key: "Backspace",
  isComposing: false,
  keyCode: 8,
  selectionStart: 0,
  selectionEnd: 0,
  ...overrides,
});

test("本文の組み立て: 本文が空なら prompt だけを送る", () => {
  assert.equal(suggestionSendText("壁打ちを手伝って。", ""), "壁打ちを手伝って。");
  assert.equal(suggestionSendText("壁打ちを手伝って。", "   \n "), "壁打ちを手伝って。");
});

test("本文の組み立て: 本文があれば prompt の後ろに空行を挟んで足す", () => {
  assert.equal(
    suggestionSendText("壁打ちを手伝って。", "テーマは猫のゲーム"),
    "壁打ちを手伝って。\n\nテーマは猫のゲーム",
  );
});

test("本文の組み立て: 本文の前後の空白は落とし、途中の改行は残す", () => {
  assert.equal(suggestionSendText("prompt", "  1 行目\n2 行目  "), "prompt\n\n1 行目\n2 行目");
});

test("本文の組み立て: prompt が空なら本文だけを送る (行頭に空行を作らない)", () => {
  assert.equal(suggestionSendText("", "本文"), "本文");
  assert.equal(suggestionSendText("", "  "), "");
});

test("backspace: 本文の先頭 (位置 0・選択なし) で外す", () => {
  assert.equal(shouldClearSuggestionOnBackspace(backspace()), true);
});

test("backspace: 位置 0 以外と、テキストを選択しているときは外さない", () => {
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ selectionStart: 1, selectionEnd: 1 })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ selectionStart: 0, selectionEnd: 3 })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ selectionStart: null, selectionEnd: null })), false);
});

test("backspace: IME の変換中は外さない (isComposing / keyCode 229)", () => {
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ isComposing: true })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ keyCode: 229 })), false);
});

test("backspace: Backspace 以外のキーでは外さない", () => {
  // 本文の全選択 → Delete はテキストだけを消す (チップは本文の左にあるので選択の外)
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ key: "Delete", keyCode: 46 })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ key: "a", keyCode: 65 })), false);
});
