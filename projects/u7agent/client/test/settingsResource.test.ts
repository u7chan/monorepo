// 設定資源 hook の文言（client/src/lib/settingsResource.ts）。DOM を使わず純関数だけを固定する。
// ここが崩れると、何も保存されていない失敗を保存済みと読ませる / 応答から作る成功注記を空にする。
import assert from "node:assert/strict";
import test from "node:test";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ApiError } = await import("../src/api");
const { messageFor, mutationErrorNote, successNoteText } = await import("../src/lib/settingsResource");

test("messageFor は Error の message を返し、Error 以外も文字列化する", () => {
  assert.equal(messageFor(new Error("変更に失敗しました")), "変更に失敗しました");
  assert.equal(messageFor(new TypeError("型が違います")), "型が違います");
  // throw された値が Error とは限らない
  assert.equal(messageFor("キーが不正です"), "キーが不正です");
  assert.equal(messageFor(null), "null");
});

test("mutationErrorNote は not_stored のときだけ「保存されていない」を前置きする", () => {
  const notStored = new ApiError("設定を保存できませんでした", 503, "not_stored");
  assert.equal(mutationErrorNote(notStored), "変更は保存されていません。設定を保存できませんでした");
  // 400 と、state を持たない 503 はサーバーの理由だけを出す
  assert.equal(mutationErrorNote(new ApiError("APIキーが不正です", 400)), "APIキーが不正です");
  assert.equal(mutationErrorNote(new ApiError("DB に接続できません", 503)), "DB に接続できません");
  assert.equal(mutationErrorNote(new Error("ネットワークエラー")), "ネットワークエラー");
  // 同じ state を持つ Error でも、ApiError 以外は前置きしない
  assert.equal(mutationErrorNote(Object.assign(new Error("別の失敗"), { state: "not_stored" })), "別の失敗");
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
