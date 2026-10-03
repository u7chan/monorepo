import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

test("描画: 本文の画像は拡大できる button になる", () => {
  const markdown = render("![alt text](/chart.png)");
  assert.ok(markdown.includes('<button type="button"'), "Markdown 画像が button になっていない");
  assert.ok(markdown.includes('aria-label="alt text を拡大表示"'), "読み上げ名が無い");
  const html = render('<img src="/chart.png" alt="alt text">');
  assert.ok(html.includes('<button type="button"'), "生 HTML の img が button になっていない");
  // 閉じている間は dialog を置かない (portal する要素を常時 DOM に残さない)
  assert.ok(!markdown.includes("<dialog"), "開いていないのに dialog を置いている");
  assert.ok(!html.includes("<dialog"), "開いていないのに dialog を置いている");
});

test("描画: リンクの中の画像は button にせず、素の img のまま残す", () => {
  // Markdown のリンクに画像を書く 3 通り。ラベル内の Markdown 画像は解析側が画像にしないため字面のまま残る
  for (const text of ["[![alt](img.png)](https://example.com)", '[<img src="/x.png">](https://example.com)']) {
    const markdown = render(text);
    assert.ok(!markdown.includes("<button"), `${text} を button にしている`);
    assert.ok(markdown.includes("<a href="), `${text} がリンクとして描かれていない`);
  }
  // 生 HTML の <a> の中と、その入れ子 (<a><span><img></span></a>) もリンクのままにする
  for (const text of [
    '<a href="https://example.com"><img src="/y.png" alt="y"></a>',
    '<a href="https://example.com"><span><img src="/z.png"></span></a>',
  ]) {
    const markdown = render(text);
    assert.ok(!markdown.includes("<button"), `${text} を button にしている`);
    assert.ok(markdown.includes("<a href="), `${text} がリンクとして描かれていない`);
  }
});
