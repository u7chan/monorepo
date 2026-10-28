// 共通スキルの編集フォームが外へ出している契約 (入力欄・公開属性・操作) を静的な描画で固定する。
// 見た目ではなく、操作名・必須・入力規則・出してはいけない操作を見る。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  FILE_SKILL_CANCEL_LABEL,
  FILE_SKILL_CONFLICT_NOTE,
  FILE_SKILL_DELETE_LABEL,
  FILE_SKILL_NAME_LABEL,
  FILE_SKILL_NAME_READONLY_NOTE,
  FILE_SKILL_RELOAD_LABEL,
  FILE_SKILL_SAVE_LIMIT_NOTE,
} from "../src/lib/fileSkills";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { FileSkillEditorForm } = await import("../src/components/skill-settings/FileSkillEditorForm");

function render(props: Partial<Parameters<typeof FileSkillEditorForm>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(FileSkillEditorForm, {
      mode: "edit",
      draft: { name: "alpha", description: "説明", body: "\n本文\n" },
      setDraft: () => {},
      conflict: false,
      notice: null,
      onSave: () => {},
      onCancel: () => {},
      onReload: () => {},
      ...props,
    }),
  );
}

test("描画: 既存の編集は名前を表示だけにし、変更できないことを示す", () => {
  const html = render();
  assert.ok(html.includes(FILE_SKILL_NAME_LABEL));
  assert.ok(html.includes("alpha"));
  assert.ok(!html.includes('name="name"'), "既存の編集に名前の入力欄がある");
  assert.ok(html.includes(FILE_SKILL_NAME_READONLY_NOTE));
  // 説明と本文だけが入力欄になる
  assert.match(html, /<input[^>]*value="説明"/);
  assert.match(html, /<textarea[^>]*>[^<]*本文/);
  assert.ok(html.includes(FILE_SKILL_CANCEL_LABEL));
  assert.ok(html.includes(FILE_SKILL_SAVE_LIMIT_NOTE), "保存の上限の案内が無い");
  // 自動起動の切替と YAML 全文の編集は出さない
  assert.ok(!html.includes("disable-model-invocation"), "非表示キーが UI に出ている");
  assert.ok(!html.includes("---"), "YAML 全文の編集面が出ている");
});

test("描画: 新規作成は名前を入力でき、削除の導線を出さない", () => {
  const html = render({
    mode: "create",
    draft: { name: "", description: "", body: "" },
    onDelete: undefined,
  });
  assert.match(html, /<input[^>]*required/);
  assert.match(html, /pattern="\[a-z0-9-\]\+"/);
  assert.match(html, /maxLength="64"/);
  assert.ok(!html.includes(FILE_SKILL_DELETE_LABEL));
  assert.ok(!html.includes(FILE_SKILL_NAME_READONLY_NOTE));
});

test("描画: 削除は既存の編集にだけ出し、呼び出し側の確認に委ねる", () => {
  assert.ok(render({ mode: "edit", onDelete: () => {} }).includes(FILE_SKILL_DELETE_LABEL));
  assert.ok(!render({ mode: "edit", onDelete: undefined }).includes(FILE_SKILL_DELETE_LABEL));
});

test("描画: 競合時は下書きを保ったまま再読み込みの導線を出す", () => {
  const html = render({ mode: "edit", conflict: true, onReload: () => {} });
  assert.ok(html.includes(FILE_SKILL_CONFLICT_NOTE));
  assert.ok(html.includes(FILE_SKILL_RELOAD_LABEL));
  // 下書き (入力値) はそのまま残る
  assert.match(html, /value="説明"/);
  assert.match(html, /<textarea[^>]*>[^<]*本文/);
  // 競合していないときは再読み込みを出さない
  assert.ok(!render({ mode: "edit", conflict: false }).includes(FILE_SKILL_RELOAD_LABEL));
});

test("描画: 保存 / 作成の失敗理由はフォームの上に出す", () => {
  const html = render({ mode: "create", notice: "同名の共通スキルが既にあります: alpha" });
  assert.ok(html.includes("同名の共通スキルが既にあります: alpha"));
});
