// 設定 → エージェント / スキルの編集で出す確認。見出し・対象・ボタン名を純関数で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDeleteConfirmRequest,
  skillDeleteConfirmRequest,
  skillDiscardConfirmRequest,
} from "../src/lib/settingsConfirm";

test("エージェント削除の確認は対象の名前を独立した行へ出す", () => {
  const request = agentDeleteConfirmRequest("レビュアー");
  assert.equal(request.kind, "confirm");
  assert.equal(request.title, "エージェントを削除");
  assert.deepEqual(request.subject, { label: "削除するエージェント", value: "レビュアー" });
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "削除は danger にする");
  // 名前が未入力でも確認は出す (対象の行を省くだけ)
  assert.equal(agentDeleteConfirmRequest("").subject, undefined);
});

test("スキル削除の確認は割り当てから外れることを先に伝える", () => {
  const request = skillDeleteConfirmRequest("重要度順レビュー");
  assert.equal(request.title, "スキルを削除");
  assert.deepEqual(request.subject, { label: "削除するスキル", value: "重要度順レビュー" });
  assert.deepEqual(request.body, ["割り当て中のエージェントからも外れます。"]);
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "削除は danger にする");
});

test("編集の破棄の確認は未保存の変更が戻せないことを示す", () => {
  const request = skillDiscardConfirmRequest();
  assert.equal(request.title, "編集を破棄");
  assert.deepEqual(request.body, ["保存していない変更は元に戻せません。"]);
  assert.equal(request.confirmLabel, "破棄する");
  assert.ok(request.danger, "破棄は danger にする");
});
