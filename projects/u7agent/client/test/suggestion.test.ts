// 定型プロンプトのチップの純関数。送信本文の組み立て、チップを持つ範囲 (捨てる契機)、
// backspace で外すかの判定を固定する (どれも実 DOM を要さない規則で、Composer / App から呼ぶ正はこの module に置く)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldClearSuggestionOnBackspace,
  suggestionScopeChange,
  suggestionSendText,
  suggestionTitleSource,
  type SuggestionKeyState,
  type SuggestionScope,
} from "../src/lib/suggestion";

const backspace = (overrides: Partial<SuggestionKeyState> = {}): SuggestionKeyState => ({
  key: "Backspace",
  isComposing: false,
  keyCode: 8,
  selectionStart: 0,
  selectionEnd: 0,
  ...overrides,
});

const scope = (overrides: Partial<SuggestionScope> = {}): SuggestionScope => ({
  agentId: "agent-general",
  selectionSeq: 0,
  sessionId: "",
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

test("タイトル用の本文: チップを結合する前の入力を trim して返す", () => {
  // 送信本文 (suggestionSendText) とは別に渡し、タイトルが定型プロンプトの先頭で埋まらないようにする
  assert.equal(suggestionTitleSource("  ログイン画面の改善  "), "ログイン画面の改善");
  // 本文が無ければ渡さず、サーバーに従来の判定 (定型プロンプト / スキル名) をさせる
  assert.equal(suggestionTitleSource("   \n "), undefined);
});

test("本文の組み立て: prompt が空なら本文だけを送る (行頭に空行を作らない)", () => {
  assert.equal(suggestionSendText("", "本文"), "本文");
  assert.equal(suggestionSendText("", "  "), "");
});

test("範囲: 未作成チャットの添付が会話を暗黙に作っただけではチップを残す", () => {
  // 添付は ensureSession で会話を作り、会話 id だけが "" から新しい id へ変わる。利用者は会話を選んでおらず、
  // 添付とチップは同じ下書きのものなので、別の行のまま共存させる
  assert.equal(suggestionScopeChange(scope({ sessionId: "" }), scope({ sessionId: "s1" })), "keep");
});

test("範囲: 利用者が別の会話を開いたらチップを捨てる", () => {
  assert.equal(
    suggestionScopeChange(scope({ sessionId: "s1", selectionSeq: 0 }), scope({ sessionId: "s2", selectionSeq: 1 })),
    "drop",
  );
});

test("範囲: 新規チャット (会話 id が変わらない選び直し) でも捨てる", () => {
  assert.equal(
    suggestionScopeChange(scope({ sessionId: "s1", selectionSeq: 0 }), scope({ sessionId: "s1", selectionSeq: 1 })),
    "drop",
  );
});

test("範囲: エージェントを切り替えたらチップを捨てる", () => {
  assert.equal(
    suggestionScopeChange(scope({ agentId: "agent-general" }), scope({ agentId: "agent-zundamon" })),
    "drop",
  );
});

test("範囲: 同じ範囲では捨てない", () => {
  assert.equal(suggestionScopeChange(scope(), scope()), "keep");
});

test("範囲: 利用操作なしに会話 id が別の値へ移ったら持ち越さない", () => {
  // 世代が同じでも "" 起点でない移りは想定外。下書きを持ち越さない側に倒す
  assert.equal(suggestionScopeChange(scope({ sessionId: "s1" }), scope({ sessionId: "s2" })), "drop");
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
  // key を見ない判定を通す。Enter 用の helper が key で絞られても、この 2 つは backspace 側で固定する
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ isComposing: true })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ keyCode: 229 })), false);
});

test("backspace: Backspace 以外のキーでは外さない", () => {
  // 本文の全選択 → Delete はテキストだけを消す (チップは本文の左にあるので選択の外)
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ key: "Delete", keyCode: 46 })), false);
  assert.equal(shouldClearSuggestionOnBackspace(backspace({ key: "a", keyCode: 65 })), false);
});
