// client に DOM テスト基盤が無いため、列が潰れないための CSS 契約をソース走査で、
// 横スクロールの受け皿とセルの整列を react-dom/server で固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function readCss(): string {
  return readFileSync(fileURLToPath(new URL("../src/styles/index.css", import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

/** index.css の規則 1 つを宣言の表にする (入れ子の規則は見ない) */
function rule(selector: string): Record<string, string> {
  const css = readCss().replace(/\s+/g, " ");
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} の規則が index.css に無い`);
  const open = css.indexOf("{", at);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const declarations: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
  }
  return declarations;
}

test("全セルを語の境界で折り返し、列に下限幅を置く", () => {
  const cell = rule(".md-table th, .md-table td");
  assert.equal(cell["white-space"], "normal", "ヘッダも本文も折り返せるようにする");
  assert.equal(cell["word-break"], "normal", "本文の break-word をセルだけで打ち消す");
  assert.equal(cell["overflow-wrap"], "break-word", "緊急折り返しは min-content 幅を縮めない");
  assert.equal(cell["min-width"], "5em", "和文の列も 1 文字幅まで縮めない");
});

test("最終列だけを折り返す特例を置かない", () => {
  assert.ok(!/\.md-table\s+(?:td|th):last-child\b/.test(readCss()), "最終列だけ幅を譲る規則が残っている");
});

test("表の外の本文には従来の word-break を残す", () => {
  assert.equal(rule(".md")["word-break"], "break-word", "本文の長いパスなどの折り返しを変えない");
});

test("収まらない表だけを横スクロールする受け皿を残す", () => {
  assert.equal(rule(".md-table-wrap")["overflow-x"], "auto");
  const html = render("| モデル | USD/1M |\n| --- | --- |\n| Gemini 3 Pro Image (Nano Banana Pro) | 120 |");
  assert.match(html, /<div class="md-table-wrap scrollbar-thin"><table class="md-table">[\s\S]*?<\/table><\/div>/);
});

test("ヘッダと本文のセルに従来の整列クラスを付ける", () => {
  const html = render("| 左 | 中央 | 右 | 既定 |\n| :--- | :---: | ---: | --- |\n| L | C | R | D |");
  assert.match(
    html,
    /<thead><tr><th class="md-al-left">左<\/th><th class="md-al-center">中央<\/th><th class="md-al-right">右<\/th><th class="md-al-left">既定<\/th><\/tr><\/thead>/,
  );
  assert.match(
    html,
    /<tbody><tr><td class="md-al-left">L<\/td><td class="md-al-center">C<\/td><td class="md-al-right">R<\/td><td class="md-al-left">D<\/td><\/tr><\/tbody>/,
  );
  assert.equal(rule(".md-table th, .md-table td")["text-align"], "left");
  assert.equal(rule(".md-table .md-al-center")["text-align"], "center");
  assert.equal(rule(".md-table .md-al-right")["text-align"], "right");
});
