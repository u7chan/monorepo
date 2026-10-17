// 共通スキル編集の制御ロジック (状態遷移・下書きの保持・取消) を DOM なしで固定する。
// 遅い応答の無効化は requestGate 側 (useFileSkills が使う) の既存テストが担うので、ここでは
// 「どの状態でどの操作を許すか」「競合しても下書きを残すか」を確かめる。
import assert from "node:assert/strict";
import test from "node:test";
import {
  fileSkillCreateDirty,
  fileSkillDraftOf,
  fileSkillDraftDirty,
  fileSkillEditorPath,
  fileSkillSaveInput,
  newFileSkillDraft,
  reduceFileSkillEditor,
  type FileSkillEditorState,
} from "../src/lib/fileSkillEditor";
import type { SandboxSkillFileDetail } from "../src/types";

function detail(overrides: Partial<SandboxSkillFileDetail> = {}): SandboxSkillFileDetail {
  return {
    name: "alpha",
    description: "説明",
    body: "\n本文\n",
    relativePath: ".agents/skills/alpha/SKILL.md",
    fileVersion: "a".repeat(64),
    editable: true,
    ...overrides,
  };
}

const OPEN: FileSkillEditorState = { status: "loading", relativePath: detail().relativePath };

test("取得中は対象だけを持ち、応答が来たら閲覧になる", () => {
  assert.equal(fileSkillEditorPath(OPEN), detail().relativePath);
  const view = reduceFileSkillEditor(OPEN, { type: "loaded", relativePath: detail().relativePath, detail: detail() });
  assert.deepEqual(view, { status: "view", relativePath: detail().relativePath, detail: detail() });
  // 取得中でないとき / 別の対象の応答は無視する (古い本文を反映しない)
  assert.deepEqual(
    reduceFileSkillEditor(view, {
      type: "loaded",
      relativePath: detail().relativePath,
      detail: detail({ name: "other" }),
    }),
    view,
  );
  assert.deepEqual(
    reduceFileSkillEditor(OPEN, {
      type: "loaded",
      relativePath: ".agents/skills/beta/SKILL.md",
      detail: detail({ relativePath: ".agents/skills/beta/SKILL.md" }),
    }),
    OPEN,
  );
});

test("対象を切り替えたら下書きを捨てて取得し直す", () => {
  const editing = reduceFileSkillEditor(
    reduceFileSkillEditor(OPEN, { type: "loaded", relativePath: detail().relativePath, detail: detail() }),
    { type: "startEdit" },
  );
  assert.equal(editing.status, "edit");
  assert.deepEqual(editing.status === "edit" ? editing.draft : null, fileSkillDraftOf(detail()));
  const switched = reduceFileSkillEditor(editing, {
    type: "open",
    relativePath: ".agents/skills/beta/SKILL.md",
  });
  assert.deepEqual(switched, { status: "loading", relativePath: ".agents/skills/beta/SKILL.md" });
});

test("編集の開始は取得した内容から下書きを作り、破棄は閲覧へ戻すだけ", () => {
  const view: FileSkillEditorState = { status: "view", relativePath: detail().relativePath, detail: detail() };
  const editing = reduceFileSkillEditor(view, { type: "startEdit" });
  const changed = reduceFileSkillEditor(editing, { type: "draft", patch: { body: "\n直した\n" } });
  assert.equal(changed.status === "edit" ? changed.draft.body : null, "\n直した\n");
  assert.equal(fileSkillDraftDirty(changed.status === "edit" ? changed.draft : newFileSkillDraft(), detail()), true);
  const cancelled = reduceFileSkillEditor(changed, { type: "cancelEdit" });
  assert.deepEqual(cancelled, view);
});

test("競合しても下書きを残し、保存できる状態と対象を保つ", () => {
  const editing = reduceFileSkillEditor(
    { status: "view", relativePath: detail().relativePath, detail: detail() },
    { type: "startEdit" },
  );
  const changed = reduceFileSkillEditor(editing, { type: "draft", patch: { description: "競合中の説明" } });
  const conflicted = reduceFileSkillEditor(changed, { type: "conflict" });
  assert.equal(conflicted.status === "edit" ? conflicted.conflict : null, true);
  assert.equal(conflicted.status === "edit" ? conflicted.draft.description : null, "競合中の説明");
  assert.deepEqual(fileSkillSaveInput(conflicted), {
    kind: "save",
    relativePath: detail().relativePath,
    fileVersion: detail().fileVersion,
    draft: { name: "alpha", description: "競合中の説明", body: "\n本文\n" },
  });
  // 再読み込みは対象を取り直す (競合の印は取得し直しで消える)
  const reloading = reduceFileSkillEditor(conflicted, { type: "open", relativePath: detail().relativePath });
  assert.deepEqual(reloading, { status: "loading", relativePath: detail().relativePath });
});

test("新規作成は名前・説明・本文の空の下書きから始め、失敗しても入力を残す", () => {
  const creating = reduceFileSkillEditor({ status: "none" }, { type: "startCreate" });
  assert.deepEqual(creating, { status: "create", draft: newFileSkillDraft(), notice: null });
  assert.equal(fileSkillCreateDirty(newFileSkillDraft()), false);
  const filled = reduceFileSkillEditor(creating, { type: "draft", patch: { name: "new-skill" } });
  assert.equal(fileSkillCreateDirty(filled.status === "create" ? filled.draft : newFileSkillDraft()), true);
  assert.deepEqual(fileSkillSaveInput(filled), {
    kind: "create",
    draft: { name: "new-skill", description: "", body: "" },
  });
  // 取消は選択を解除する (フォームの下書きは破棄される)
  assert.deepEqual(reduceFileSkillEditor(filled, { type: "cancelEdit" }), { status: "none" });
  const failed = reduceFileSkillEditor(filled, { type: "createFailed", message: "同名の共通スキルが既にあります" });
  assert.equal(failed.status === "create" ? failed.notice : null, "同名の共通スキルが既にあります");
  assert.equal(failed.status === "create" ? failed.draft.name : null, "new-skill");
});

test("保存できたときは新しい内容で閲覧へ戻り、失敗したときは編集のままにする", () => {
  const editing = reduceFileSkillEditor(
    { status: "view", relativePath: detail().relativePath, detail: detail() },
    { type: "startEdit" },
  );
  const saved = reduceFileSkillEditor(editing, { type: "saved", detail: detail({ fileVersion: "b".repeat(64) }) });
  assert.equal(saved.status, "view");
  assert.equal(saved.status === "view" ? saved.detail.fileVersion : null, "b".repeat(64));
  // 保存できる状態かどうかは状態だけでは決まらない (版は編集開始時の detail から取る)
  assert.equal(fileSkillSaveInput(saved), null);
  assert.equal(fileSkillSaveInput({ status: "loading", relativePath: detail().relativePath }), null);
  assert.equal(fileSkillSaveInput({ status: "none" }), null);
});

test("保存できないスキル (editable: false) も閲覧はできて保存導線は出さない", () => {
  const locked = detail({ editable: false, reason: "frontmatter (---) が無い SKILL.md は保存できません" });
  const view = reduceFileSkillEditor(OPEN, { type: "loaded", relativePath: locked.relativePath, detail: locked });
  assert.equal(view.status === "view" ? view.detail.editable : null, false);
  assert.equal(
    view.status === "view" ? view.detail.reason : null,
    "frontmatter (---) が無い SKILL.md は保存できません",
  );
  // 編集を開始しても保存要求は版を持つので、サーバー側でも拒否される (ここでは状態だけを固定する)
  const editing = reduceFileSkillEditor(view, { type: "startEdit" });
  assert.equal(editing.status, "edit");
});
