// 本文由来の文字列が HTML として解釈される経路そのものを持たないことをソース走査で固定する。
// 実装を差し替えても、ここにある書き方が戻れば落ちる (コメント行は判定から外す)。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LIB_DIR = "src/lib/markdown";
const COMPONENT_DIR = "src/components/markdown";

/** DOM 文字列の生成・HTML のパース・React の外での DOM 操作 */
const FORBIDDEN = ["innerHTML", "dangerouslySetInnerHTML", "DOMParser", "document.", "window.", "eval(", "new Function"];
/** 本番の CSP は style-src 'self' のため、インライン style 属性は使えない */
const INLINE_STYLE = ["style={", 'style="'];

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function sourceFiles(dir: string): { path: string; code: string }[] {
  const absolute = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  return readdirSync(absolute)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ path: `${dir}/${name}`, code: stripComments(readFileSync(`${absolute}/${name}`, "utf8")) }));
}

const libFiles = sourceFiles(LIB_DIR);
const componentFiles = sourceFiles(COMPONENT_DIR);
const allFiles = [...libFiles, ...componentFiles];

test("解析と描画のソースが揃っている (走査対象が空にならない)", () => {
  assert.deepEqual(libFiles.map((file) => file.path.split("/").pop()).sort(), [
    "highlight.ts",
    "html.ts",
    "inline.ts",
    "latex.ts",
    "latexLayout.ts",
    "parse.ts",
    "types.ts",
  ]);
  assert.deepEqual(componentFiles.map((file) => file.path.split("/").pop()).sort(), [
    "CodeBlock.tsx",
    "HtmlInline.tsx",
    "MarkdownView.tsx",
    "MathView.tsx",
  ]);
});

test("DOM 文字列の生成と HTML のパースを使っていない", () => {
  for (const file of allFiles) {
    for (const token of FORBIDDEN) {
      assert.ok(!file.code.includes(token), `${file.path} に ${token} がある`);
    }
  }
});

test("インライン style を使っていない (本番 CSP は style-src 'self')", () => {
  for (const file of allFiles) {
    for (const token of INLINE_STYLE) {
      assert.ok(!file.code.includes(token), `${file.path} に ${token} がある`);
    }
  }
});

test("lib/markdown は DOM と React に依存しない (Node のテストで検証できる)", () => {
  for (const file of libFiles) {
    const imports = [...file.code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("./"), `${file.path} が ${specifier} を import している`);
    }
    assert.ok(!/\breact\b/i.test(file.code), `${file.path} が React に触れている`);
  }
});
