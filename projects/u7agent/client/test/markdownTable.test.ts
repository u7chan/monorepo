import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

test("Markdown の表はヘッダと本文を列順に描画する", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownView, {
      text: "| 左 | 中央 | 右 | 既定 |\n| :--- | :---: | ---: | --- |\n| L | C | R | D |",
    }),
  );
  assert.match(html, /<table\b/);
  assert.match(
    html,
    /<thead><tr><th[^>]*>左<\/th><th[^>]*>中央<\/th><th[^>]*>右<\/th><th[^>]*>既定<\/th><\/tr><\/thead>/,
  );
  assert.match(html, /<tbody><tr><td[^>]*>L<\/td><td[^>]*>C<\/td><td[^>]*>R<\/td><td[^>]*>D<\/td><\/tr><\/tbody>/);
});
