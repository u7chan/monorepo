// 設定 → スキル（/settings/skills）の一覧面の描画契約。追加行を出してよい条件、固定フッターの操作、
// 詳細との切り替えがページ内の view state であること (dialog を被せない) を固定する。
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
  SKILL_EXPORT_LABEL,
  SKILL_IMPORT_LABEL,
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

test("選択が無いときの案内は一覧を取得できていない間は作成を案内しない", () => {
  assert.equal(fileSkillPaneNote({ status: "ready", skills: [] }), FILE_SKILL_PANE_NOTE);
  assert.equal(fileSkillPaneNote({ status: "loading" }), FILE_SKILL_PANE_LOADING_NOTE);
  assert.equal(fileSkillPaneNote({ status: "error", message: "取得に失敗" }), FILE_SKILL_PANE_ERROR_NOTE);
  // 追加行が出ない状態で「新しいスキル」からの作成を案内すると、押せない操作を促すことになる
  assert.ok(FILE_SKILL_PANE_NOTE.includes("作成できます"));
  assert.ok(!FILE_SKILL_PANE_LOADING_NOTE.includes("作成できます"));
  assert.ok(!FILE_SKILL_PANE_ERROR_NOTE.includes("作成できます"));
});

test("ページは取得中の一覧に追加行を出さず、理由と固定フッターの操作を出す", () => {
  // renderToStaticMarkup では effect が走らないため、一覧は初期状態 (loading) のまま描画される
  const html = renderToStaticMarkup(
    createElement(ConfirmProvider, null, createElement(SkillSettingsPage, { onBack: () => {}, onOpenNav: () => {} })),
  );
  assert.ok(!hasAddRow(html), "取得中でも追加行が出ている");
  assert.ok(html.includes(FILE_SKILL_LOADING_NOTE), "取得中の注記が無い");
  // 追加 / インポート / エクスポートは行の外の固定フッターに置く
  assert.ok(html.includes(SKILL_IMPORT_LABEL));
  assert.ok(html.includes(SKILL_EXPORT_LABEL));
  // 一覧 ⇄ 詳細はページ内の view state で、全画面シート (modal dialog) は使わない
  assert.ok(!html.includes("aria-modal"), "設定の詳細シートが残っている");
  assert.ok(html.includes("スキルの種類"), "スコープタブが無い");
});

test("DefinitionList は見出しを省いてもタブ・検索・固定フッターを出す", () => {
  const html = renderToStaticMarkup(
    createElement(DefinitionList, {
      tabs: createElement("span", null, "scope-tabs"),
      search: createElement("span", null, "search-field"),
      footer: createElement("button", { type: "button" }, FILE_SKILL_ADD_LABEL),
      children: null,
    }),
  );
  assert.ok(html.includes("scope-tabs"));
  assert.ok(html.includes("search-field"));
  assert.ok(hasAddRow(html));
  assert.equal(html.includes("スキル一覧"), false, "見出しを省いたのに見出しが出ている");
});
