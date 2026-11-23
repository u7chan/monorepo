// 音声入力の所有領域（client/src/lib/voiceInput/draft.ts）。録音の途中と確定・取消で本文のどこを
// 差し替えるか、手入力が入ったときにどこで止めるかを純関数で固定する。DOM は扱わない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVoiceInputPartial,
  beginVoiceInputDraft,
  finishVoiceInputDraft,
  revertVoiceInputDraft,
  type VoiceInputDraft,
} from "../src/lib/voiceInput/draft";

/** カーソル位置へ始めた draft に、途中の文字起こしを 1 つ入れる */
const withPartial = (value: string, caret: number, partial: string): { draft: VoiceInputDraft; value: string } => {
  const started = beginVoiceInputDraft(value, caret, caret);
  const update = applyVoiceInputPartial(started, value, partial, caret);
  return { draft: update.draft, value: update.value };
};

test("開始位置に途中の文字起こしを入れ、次の部分で差し替える", () => {
  // What: 部分テキストは積み増さず、所有領域だけを差し替える（同じ発話が伸びるたびに重ならない）
  const first = withPartial("abc", 3, "こんにちは");
  assert.equal(first.value, "abcこんにちは");

  const second = applyVoiceInputPartial(first.draft, first.value, "こんにちは、世界", 3 + 5);
  assert.equal(second.value, "abcこんにちは、世界");
  assert.equal(second.applied, true);
});

test("領域の外の手入力は消さず、部分テキストの位置だけをずらす", () => {
  // What: 録音中に前の方へ書いた文字を、次の部分テキストが巻き戻さない
  const first = withPartial("abc", 3, "hello");
  const typed = `!${first.value}`;
  const next = applyVoiceInputPartial(first.draft, typed, "hello world", 3);
  assert.equal(next.value, "!abchello world");
  assert.equal(next.applied, true);
});

test("領域より前の挿入では領域が右へずれ、中身は変わらない", () => {
  // What: 領域の前へ書いた分だけ位置をずらす（ずらさないと部分テキストが手入力の上を置き換える）
  const first = withPartial("abcdef", 2, "hello");
  assert.equal(first.value, "abhellocdef");
  const typed = `XY${first.value}`;
  const next = applyVoiceInputPartial(first.draft, typed, "hello world", 9);
  assert.equal(next.value, "XYabhello worldcdef");
});

test("領域より後ろの挿入では領域が動かず、部分テキストが利用者の文字を消さない", () => {
  // What: 末尾へ書いた 1 文字を次の部分テキストが置き換えない（領域の後ろの編集で位置をずらさない）
  const first = withPartial("abcdef", 2, "hello");
  const typed = `${first.value}X`;
  const next = applyVoiceInputPartial(first.draft, typed, "hello world", 7);
  assert.equal(next.value, "abhello worldcdefX");
  assert.equal(next.applied, true);
});

test("領域より後ろの挿入では、確定も利用者の文字を消さない", () => {
  const first = withPartial("abcdef", 2, "hello");
  const finished = finishVoiceInputDraft(first.draft, `${first.value}X`, "hello world", 7);
  assert.equal(finished.value, "abhello worldcdefX");
});

test("領域より後ろの挿入では、取消で開始時の本文へ戻り手入力が残る", () => {
  const first = withPartial("abcdef", 2, "hello");
  const reverted = revertVoiceInputDraft(first.draft, `${first.value}X`);
  assert.equal(reverted.value, "abcdefX");
});

test("領域より後ろの削除でも領域がずれない", () => {
  // What: 末尾の 1 文字を消しても、次の部分テキストは領域だけを置き換える
  const first = withPartial("abcdef", 2, "hello");
  const deleted = first.value.slice(0, -1);
  const next = applyVoiceInputPartial(first.draft, deleted, "hello world", 7);
  assert.equal(next.value, "abhello worldcde");
});

test("取消で開始時の選択文字が戻り、後ろの手入力が残る", () => {
  const started = beginVoiceInputDraft("abcdef", 2, 4);
  const partial = applyVoiceInputPartial(started, "abcdef", "hello", 4);
  assert.equal(partial.value, "abhelloef");
  const reverted = revertVoiceInputDraft(partial.draft, `${partial.value}X`);
  assert.equal(reverted.value, "abcdefX");
});

test("領域の中を編集したら自動の差し替えを止め、確定でも本文を変えない", () => {
  // What: 残った途中文と確定テキストを並べない（同じ発話が二重に入るより、確定文を捨てて注記する）
  const first = withPartial("abc", 3, "hello");
  const edited = `${first.value.slice(0, 5)}X${first.value.slice(5)}`;
  const partial = applyVoiceInputPartial(first.draft, edited, "hello world", 6);
  assert.equal(partial.value, edited, "部分テキストで上書きしない");
  assert.equal(partial.draft.status, "detached");

  const finished = finishVoiceInputDraft(partial.draft, partial.value, "hello world", 6);
  assert.equal(finished.value, edited, "確定テキストも入れない");
  assert.equal(finished.applied, false);
});

test("領域の境界への挿入でも所有を切る", () => {
  // What: 部分テキストの直前・直後へ書いた時点で、どちらが先か決められない（重複を作らない側へ倒す）
  const first = withPartial("abc", 3, "hello");
  const atEnd = `${first.value}!`;
  assert.equal(applyVoiceInputPartial(first.draft, atEnd, "hello world", 8).value, atEnd);

  const second = withPartial("abc", 3, "hello");
  const atStart = `abc!${second.value.slice(3)}`;
  assert.equal(applyVoiceInputPartial(second.draft, atStart, "hello world", 4).value, atStart);
});

test("確定は所有領域だけを置き換え、カーソルを確定テキストの直後へ返す", () => {
  const first = withPartial("abc", 3, "hello");
  const finished = finishVoiceInputDraft(first.draft, first.value, "こんにちは", 8);
  assert.equal(finished.value, "abcこんにちは");
  assert.equal(finished.caret, 3 + "こんにちは".length);
  assert.equal(finished.draft.status, "settled");
});

test("確定を二度呼んでも本文へ二重に入れない", () => {
  // What: 遅れて届いた確定や二度押しで、同じ確定テキストが並ばない
  const first = withPartial("abc", 3, "hello");
  const finished = finishVoiceInputDraft(first.draft, first.value, "hello", 8);
  const again = finishVoiceInputDraft(finished.draft, finished.value, "hello", 8);
  assert.equal(again.value, "abchello");
  assert.equal(again.applied, false);
  assert.equal(again.caret, null);
});

test("取消で戻すのは所有領域だけで、開始後の手入力を消さない", () => {
  const first = withPartial("abc", 3, "hello");
  const typed = `!${first.value}`;
  const reverted = revertVoiceInputDraft(first.draft, typed);
  assert.equal(reverted.value, "!abc");
  assert.equal(reverted.caret, 4);
});

test("開始時に選択していた文字は、取消でそのまま戻る", () => {
  const value = "hello world";
  const started = beginVoiceInputDraft(value, 6, 11);
  const partial = applyVoiceInputPartial(started, value, "world", 11);
  assert.equal(partial.value, "hello world");

  const reverted = revertVoiceInputDraft(partial.draft, partial.value);
  assert.equal(reverted.value, "hello world", "置き換えた選択文字を戻す");
  assert.equal(reverted.caret, 11);
});

test("選択範囲の確定は選択を確定テキストで置き換え、カーソルをその直後へ置く", () => {
  const value = "hello world";
  const started = beginVoiceInputDraft(value, 6, 11);
  const partial = applyVoiceInputPartial(started, value, "there", 11);
  assert.equal(partial.value, "hello there");

  const finished = finishVoiceInputDraft(partial.draft, partial.value, "world", 11);
  assert.equal(finished.value, "hello world");
  assert.equal(finished.caret, 11);
});

test("取消は手入力を巻き戻さず、確定は領域の外の手入力を残す", () => {
  // What: 録音の間に書いた文が、確定・取消のどちらでも消えない
  const value = "a";
  const started = beginVoiceInputDraft(value, 1, 1);
  const partial = applyVoiceInputPartial(started, value, "b", 1);
  const typed = `c${partial.value}`;
  const finished = finishVoiceInputDraft(partial.draft, typed, "b", 3);
  assert.equal(finished.value, "cab");
});
