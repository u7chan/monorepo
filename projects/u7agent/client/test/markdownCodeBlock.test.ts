import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

test("生成中はカーソルの行も数え、空のブロックには行数を出さない", () => {
  const streaming = render("```ts\nconst a = 1;\n");
  assert.match(streaming, /<div[^>]*aria-hidden="true"[^>]*>1\n2<\/div>/);
  assert.match(streaming, />2 行<\/span>/);
  const sameLine = render("```ts\nconst a = 1;");
  assert.match(sameLine, /<div[^>]*aria-hidden="true"[^>]*>1<\/div>/);
  assert.match(sameLine, />1 行<\/span>/);
  const empty = render("```ts\n```\n");
  assert.ok(!empty.includes("0 行"));
  assert.doesNotMatch(empty, /aria-hidden="true"[^>]*>\d/);
});

test("複数行は表示番号と本文の行数が一致する", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line${index + 1};`).join("\n");
  const html = render(`\`\`\`ts\n${source}\n\`\`\`\n`);
  assert.match(html, /<div[^>]*aria-hidden="true"[^>]*>1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12<\/div>/);
  assert.match(html, />12 行<\/span>/);
});
