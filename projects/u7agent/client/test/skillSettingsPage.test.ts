// 設定 → スキル（/settings/skills）の一覧面の描画契約。追加行を出してよい条件と、
// 追加行を渡さなかったときに一覧が壊れないことを固定する。
// 追加行が取得状態から切り離されると、一覧が 503 / 502 のときも押せて、入力のあとに保存だけが失敗する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { DefinitionList } from "../src/components/DefinitionList";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import {
  FILE_SKILL_ADD_LABEL,
  FILE_SKILL_LOADING_NOTE,
  FILE_SKILL_PANE_ERROR_NOTE,
  FILE_SKILL_PANE_LOADING_NOTE,
  FILE_SKILL_PANE_NOTE,
} from "../src/lib/fileSkills";

// api.ts (location.origin を読む) と useLayoutMode (viewport を読む) を辿るため、node では最小の shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
(globalThis as unknown as { window: unknown }).window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
};
const { SkillSettingsPage, fileSkillAddRow, fileSkillPaneNote } = await import("../src/components/SkillSettingsPage");

/** 追加行の有無は button の描画で見る (文言だけの一致では見出しや注記と区別できない) */
function hasAddRow(html: string): boolean {
  return new RegExp(`<button[^>]*>[\\s\\S]*?${FILE_SKILL_ADD_LABEL}[\\s\\S]*?</button>`).test(html);
}

test("追加行は一覧を取得できたときだけ出す", () => {
  const start = () => {};
  assert.deepEqual(fileSkillAddRow({ status: "ready", skills: [] }, start), {
    label: FILE_SKILL_ADD_LABEL,
    onAdd: start,
  });
  assert.equal(fileSkillAddRow({ status: "loading" }, start), undefined);
  assert.equal(fileSkillAddRow({ status: "error", message: "取得に失敗" }, start), undefined);
});

test("右ペインの案内は一覧を取得できていない間は作成を案内しない", () => {
  assert.equal(fileSkillPaneNote({ status: "ready", skills: [] }), FILE_SKILL_PANE_NOTE);
  assert.equal(fileSkillPaneNote({ status: "loading" }), FILE_SKILL_PANE_LOADING_NOTE);
  assert.equal(fileSkillPaneNote({ status: "error", message: "取得に失敗" }), FILE_SKILL_PANE_ERROR_NOTE);
  // 追加行が出ない状態で「新しいスキル」からの作成を案内すると、押せない操作を促すことになる
  assert.ok(FILE_SKILL_PANE_NOTE.includes("作成できます"));
  assert.ok(!FILE_SKILL_PANE_LOADING_NOTE.includes("作成できます"));
  assert.ok(!FILE_SKILL_PANE_ERROR_NOTE.includes("作成できます"));
});

test("ページは取得中の一覧に追加行を出さず、理由と再読み込みを出す", () => {
  // renderToStaticMarkup では effect が走らないため、一覧は初期状態 (loading) のまま描画される
  const html = renderToStaticMarkup(
    createElement(ConfirmProvider, null, createElement(SkillSettingsPage, { onBack: () => {}, onOpenNav: () => {} })),
  );
  assert.ok(!hasAddRow(html), "取得中でも追加行が出ている");
  assert.ok(html.includes(FILE_SKILL_LOADING_NOTE), "取得中の注記が無い");
});

test("DefinitionList は追加行を渡さなくても見出しと行を出す", () => {
  const withAdd = renderToStaticMarkup(
    createElement(DefinitionList, {
      title: "スキル一覧",
      count: 0,
      add: { label: FILE_SKILL_ADD_LABEL, onAdd: () => {} },
      children: null,
    }),
  );
  assert.ok(hasAddRow(withAdd), "追加行が無い");
  const withoutAdd = renderToStaticMarkup(
    createElement(DefinitionList, { title: "スキル一覧", count: 0, children: null }),
  );
  assert.ok(!hasAddRow(withoutAdd), "追加行が出ている");
  assert.ok(withoutAdd.includes("スキル一覧"), "見出しが無い");
});
