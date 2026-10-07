import assert from "node:assert/strict";

import test from "node:test";
import { composerFocusAfterSend, hasCoarsePointer } from "../src/lib/composerFocus";

test("タッチ入力の送信後は入力欄のフォーカスを外す", () => {
  // 残すとソフトキーボードが閉じず、送信しても画面が狭いままになる
  assert.equal(composerFocusAfterSend(true), "blur");
});

test("マウス / トラックパッドの送信後は入力欄へフォーカスを戻す", () => {
  // 送信ボタンのクリックでフォーカスがボタンへ移る。compact (狭い desktop の窓) でもここは同じ扱い
  assert.equal(composerFocusAfterSend(false), "focus");
});

test("hasCoarsePointer は一次ポインタ (pointer) の粗さだけを読む", () => {
  // `any-pointer: coarse` にすると、マウス併用のタッチ PC でも粗い扱いになり、マウス操作の連投で
  // フォーカスが落ちる
  const queries: string[] = [];
  const coarse = hasCoarsePointer((query) => {
    queries.push(query);
    return true;
  });
  assert.equal(coarse, true);
  assert.deepEqual(queries, ["(pointer: coarse)"]);
});
