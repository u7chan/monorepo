// 版ずれの案内の描画。出す / 出さないと、押したときの再読み込みだけを固定する
// (実際の再読み込みはブラウザの GUI 受入で確認する)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { VersionMismatchBanner } from "../src/components/VersionMismatchBanner";
import { VERSION_MISMATCH_NOTICE } from "../src/lib/versionMismatch";

function render(visible: boolean): string {
  return renderToStaticMarkup(createElement(VersionMismatchBanner, { visible, onReload: () => {} }));
}

test("版ずれのときは、見出し・再読み込みで直ること・直らないときの案内を出す", () => {
  const html = render(true);
  assert.ok(html.includes(VERSION_MISMATCH_NOTICE.heading), "見出しが出ていない");
  assert.ok(html.includes("再読み込みすると"), "再読み込みで直ることが書かれていない");
  assert.ok(html.includes("サーバー側（BFF）も同じ版へ更新"), "再読み込みで直らないときの案内が無い");
  assert.match(html, /role="status"/, "読み上げの対象になっていない");
});

test("再読み込みの操作は 1 つだけで、版の識別子そのものは出さない", () => {
  const html = render(true);
  const buttons = html.match(/<button\b/g) ?? [];
  assert.equal(buttons.length, 1, "操作が 1 つでない");
  assert.match(html, /<button[^>]*type="button"[^>]*>再読み込み<\/button>/, "再読み込みのボタンが無い");
  assert.equal(html.split(VERSION_MISMATCH_NOTICE.detail).length - 1, 1, "同じ本文を 2 度出している");
  assert.equal(/0\.1\.0\+/.test(html), false, "内部の識別子を画面へ出している");
});

test("版が揃っているときは何も出さない", () => {
  assert.equal(render(false), "");
});
