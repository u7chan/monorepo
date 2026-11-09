import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Fold } from "../src/components/Fold";

// Fold は開閉の状態を props で受け、高さの遷移 (.tree-fold) と中身の寿命だけを持つ。
// 開閉の演出は CSS が担うため、ここでは mount した時点の DOM を検査する。

const body = createElement("p", null, "中身");

test("閉じている間は入れ物だけを置き、中身は描画しない", () => {
  const html = renderToStaticMarkup(createElement(Fold, { open: false, children: body }));
  assert.ok(html.includes('class="tree-fold" data-open="false" inert=""'), "閉じた入れ物を置く");
  assert.equal(html.includes("中身"), false, "閉じた中身は描画しない");
});

test("開くと中身を出し、inert を外す", () => {
  const html = renderToStaticMarkup(createElement(Fold, { open: true, children: body }));
  assert.ok(html.includes('class="tree-fold" data-open="true"'), "開いた入れ物を置く");
  assert.equal(html.includes("inert"), false, "開いた中身はフォーカスと読み上げの対象に残す");
  assert.ok(html.includes("中身"));
});

test("keepMounted は閉じている間も中身を残す", () => {
  const html = renderToStaticMarkup(
    createElement(Fold, { open: false, keepMounted: true, children: createElement("p", null, "下書き") }),
  );
  assert.ok(html.includes("下書き"), "開閉で入力中の下書きを捨てない");
  assert.ok(html.includes('data-open="false" inert=""'), "残した中身は inert で外す");
});
