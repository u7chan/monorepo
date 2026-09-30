// チャット本文のコードフェンスの行番号を成立させている実装を突き合わせる。どれかが崩れると、
// コピー / 選択に行番号が混ざる / 番号と本文の行がずれる / 空のブロックに番号だけ残る、のどれかになる。
// client に DOM テスト基盤が無いため、描画は react-dom/server、見た目の契約は CSS のソース走査で押さえる。
//   1. 番号の列は本文とは別の要素に出し、コードの文字列には入れない (コピーは text だけ)
//   2. 番号は 1 から行数まで (本文から数える)。空のブロックは列ごと出さない
//   3. 文字サイズと行送りは両者が継承する箱 (.md-code-body) に置き、上下の余白も揃える
//   4. 横スクロールでも左端に残し (sticky)、読み上げ (aria-hidden) と選択 (user-select: none) から外す
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

/** index.css の規則 1 つを宣言の表にする (入れ子の規則は見ない) */
function rule(selector: string): Record<string, string> {
  const css = read("src/styles/index.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(`${selector} {`);
  assert.ok(at > 0, `${selector} の規則が index.css に無い`);
  const open = css.indexOf("{", at);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const declarations: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
  }
  return declarations;
}

test("番号の列は本文の外に出し、本文の行と 1 対 1 にする", () => {
  const html = render("```ts\nconst a = 1;\nconst b = 2;\n```\n");
  assert.match(html, /<div aria-hidden="true" class="md-code-gutter">1\n2<\/div>/, "行番号の列が本文の外に出ていない");
  assert.ok(html.includes('<span class="md-code-lines">2 行</span>'), "ヘッダの行数が本文と合わない");
  // 番号はコードの文字列に入れない (コピーも選択も本文だけになる)
  const pre = /<pre class="md-code-pre">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(pre !== null, "本文の <pre> が無い");
  assert.equal(pre[1].replace(/<[^>]*>/g, ""), "const a = 1;\nconst b = 2;", "本文の文字列が番号や装飾で変わっている");
});

test("生成中も番号を出し、空のブロックには列を出さない", () => {
  const streaming = render("```ts\nconst a = 1;\n");
  assert.match(streaming, /<div aria-hidden="true" class="md-code-gutter">1<\/div>/, "生成中の行番号が無い");
  assert.ok(streaming.includes('<span class="md-caret" aria-hidden="true"></span>'), "生成中のカーソルが無い");
  // 空のブロックは行番号の列も「N 行」も出さない
  const empty = render("```ts\n```\n");
  assert.ok(!empty.includes("md-code-gutter"), "空のブロックに行番号を出している");
  assert.ok(!empty.includes("md-code-lines"), "空のブロックに「0 行」を出している");
});

test("桁が増えても番号は 1 つのテキストノードで出す", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line${index + 1};`).join("\n");
  const html = render(`\`\`\`ts\n${source}\n\`\`\`\n`);
  assert.match(html, /<div aria-hidden="true" class="md-code-gutter">1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12<\/div>/);
  assert.ok(html.includes('<span class="md-code-lines">12 行</span>'));
});

test("番号の列は本文と同じ行送りで、選択と読み上げから外す", () => {
  const body = rule(".md-code-body");
  assert.equal(body["font-size"], "12px", "文字サイズは両者が継承する箱に置く");
  assert.equal(body["line-height"], "1.6", "行送りは両者が継承する箱に置く");
  const gutter = rule(".md-code-gutter");
  const pre = rule(".md-code-pre");
  // 番号側で行送りを上書きすると 1 対 1 が崩れる
  for (const declarations of [gutter, pre]) {
    assert.equal(declarations["font-size"], undefined);
    assert.equal(declarations["line-height"], undefined);
  }
  // 上下の余白は本文と揃える (左右は列の幅)
  const vertical = (padding: string | undefined) => {
    const parts = (padding ?? "").split(" ");
    assert.equal(parts.length, 4, `padding が 4 値でない: ${padding}`);
    return [parts[0], parts[2]];
  };
  assert.deepEqual(vertical(gutter["padding"]), vertical(pre["padding"]));
  assert.equal(gutter["position"], "sticky", "横スクロールで番号が流れる");
  assert.equal(gutter["left"], "0");
  assert.equal(gutter["user-select"], "none", "選択コピーに行番号が混ざる");
  assert.equal(gutter["white-space"], "pre", "番号が折り返す");
  assert.equal(gutter["text-align"], "right");
});

test("コピーするのは本文だけ (行番号はコピーにも渡さない)", () => {
  const source = read("src/components/markdown/CodeBlock.tsx");
  assert.ok(source.includes('copyMessage(text, "code")'), "コピーに行番号を混ぜている");
  assert.ok(source.includes("lineNumbers(lineCount)"), "番号の列を本文から作っていない");
});
