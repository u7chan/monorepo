// 実行状況の入口 (サイドバー / バー)。件数は全スペースの進行中で、未取得は数字を出さず、
// 取得に失敗している間は前回の値であることを示す。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ActivityEntry, ActivityEntryButton } from "../src/components/ActivityEntry";

const renderEntry = (props: Parameters<typeof ActivityEntry>[0]) =>
  renderToStaticMarkup(createElement(ActivityEntry, props));
const renderButton = (props: Parameters<typeof ActivityEntryButton>[0]) =>
  renderToStaticMarkup(createElement(ActivityEntryButton, props));

test("サイドバーの入口は件数と「すべてのスペース」を出し、選択中は aria-current を付ける", () => {
  const markup = renderEntry({ active: false, count: 5, onOpen: () => {} });
  assert.ok(markup.includes("実行状況"));
  assert.ok(markup.includes("すべてのスペース"));
  assert.ok(markup.includes(">5<"));
  assert.ok(!markup.includes('aria-current="page"'));
  assert.ok(renderEntry({ active: true, count: 0, onOpen: () => {} }).includes('aria-current="page"'));
  // 件数が 0 でも入口は残す
  assert.ok(renderEntry({ active: false, count: 0, onOpen: () => {} }).includes(">0<"));
});

test("未取得の件数は 0 と書かず、失敗中の件数は前回の値だと分かる形にする", () => {
  const unknown = renderEntry({ active: false, onOpen: () => {} });
  assert.ok(!unknown.includes(">0<"));
  assert.ok(unknown.includes("件数は未取得"));
  const stale = renderEntry({ active: false, count: 3, stale: true, onOpen: () => {} });
  assert.ok(stale.includes("更新できていません"));
  assert.ok(stale.includes(">3<"));
});

test("バーの入口は同じ件数を出し、label を渡したときだけ「実行状況」の文字も出す", () => {
  const iconOnly = renderButton({ active: false, count: 2, onOpen: () => {} });
  assert.ok(!iconOnly.includes(">実行状況<"));
  assert.ok(iconOnly.includes(">2<"));
  assert.ok(iconOnly.includes("実行状況（全スペースの進行中 2 件）"), "読み上げ名に件数を含める");
  const withLabel = renderButton({ active: true, count: 2, onOpen: () => {}, label: true });
  assert.ok(withLabel.includes(">実行状況<"));
  assert.ok(withLabel.includes('aria-current="page"'));
});
