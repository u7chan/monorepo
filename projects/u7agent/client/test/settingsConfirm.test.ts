// 設定 → エージェント / スキルの編集で出す確認。見出し・対象・ボタン名を純関数で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDeleteConfirmRequest,
  FILE_SKILL_DELETE_FILES_MAX,
  fileSkillDeleteConfirmRequest,
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

test("共通スキル削除の確認はフォルダと件数・付随ファイルを示す", () => {
  const request = fileSkillDeleteConfirmRequest({
    name: "alpha",
    dir: ".agents/skills/alpha",
    files: ["SKILL.md", "refs/note.txt"],
    entries: 2,
  });
  assert.equal(request.kind, "confirm");
  assert.equal(request.title, "スキルを削除");
  assert.deepEqual(request.subject, { label: "削除するスキル", value: "alpha" });
  if (request.kind !== "confirm") throw new Error("confirm のはず");
  assert.deepEqual(request.code, { label: "削除するフォルダ", value: ".agents/skills/alpha" });
  assert.equal(request.body?.[0], "フォルダと 2 件のファイルを削除します。元に戻せません。");
  assert.equal(request.body?.[1], "含まれるもの: SKILL.md, refs/note.txt");
  assert.equal(request.confirmLabel, "削除する");
  assert.ok(request.danger, "削除は danger にする");
});

test("件数が多いときは列挙を打ち切り、残りを件数で示す", () => {
  const files = Array.from({ length: FILE_SKILL_DELETE_FILES_MAX + 3 }, (_, index) => `f${index}.txt`);
  const request = fileSkillDeleteConfirmRequest({
    name: "big",
    dir: ".agents/skills/big",
    files,
    entries: files.length,
  });
  if (request.kind !== "confirm") throw new Error("confirm のはず");
  assert.equal(request.body?.[0], `フォルダと ${files.length} 件のファイルを削除します。元に戻せません。`);
  assert.ok(request.body?.[1]?.endsWith("ほか 3 件"), `残り件数が出ていない: ${request.body?.[1]}`);
});
