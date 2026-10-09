// 設定資源 hook の文言（client/src/lib/settingsResource.ts）。DOM も api も読み込まない純関数だけを固定する。
// ここが崩れると、何も保存されていない失敗を保存済みと読ませる / 応答から作る成功注記を空にする。
import assert from "node:assert/strict";
import test from "node:test";
import { messageFor, mutationErrorNote, successNoteText } from "../src/lib/settingsResource";

test("messageFor は Error の message を返し、Error 以外も文字列化する", () => {
  assert.equal(messageFor(new Error("変更に失敗しました")), "変更に失敗しました");
  assert.equal(messageFor(new TypeError("型が違います")), "型が違います");
  // throw された値が Error とは限らない
  assert.equal(messageFor("キーが不正です"), "キーが不正です");
  assert.equal(messageFor(null), "null");
});

test("mutationErrorNote は not_stored と分類されたときだけ「保存されていない」を前置きする", () => {
  assert.equal(
    mutationErrorNote(new Error("設定を保存できませんでした"), true),
    "変更は保存されていません。設定を保存できませんでした",
  );
  // 400 や、分類されなかった 503 はサーバーの理由だけを出す
  assert.equal(mutationErrorNote(new Error("APIキーが不正です"), false), "APIキーが不正です");
  assert.equal(mutationErrorNote("ネットワークエラー", true), "変更は保存されていません。ネットワークエラー");
});

test("successNoteText は固定文言と、適用した応答から作る文言の両方を受ける", () => {
  const settings = { enabled: true, provider: "exa" };
  assert.equal(successNoteText("設定を保存しました。", settings), "設定を保存しました。");
  assert.equal(
    successNoteText(
      (response: typeof settings) => (response.enabled ? "有効にしました。" : "無効にしました。"),
      settings,
    ),
    "有効にしました。",
  );
  // 文言を作る関数へは、適用した応答そのものを渡す
  const seen: (typeof settings)[] = [];
  successNoteText((response: typeof settings) => {
    seen.push(response);
    return "";
  }, settings);
  assert.deepEqual(seen, [settings]);
});
