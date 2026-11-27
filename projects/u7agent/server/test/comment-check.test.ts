// scripts/comment-check.mjs の抽出境界を固定する。取りこぼすと ratchet が緩み、
// 数えすぎると文字列や URL が違反として並ぶ。

import assert from "node:assert/strict";
import test from "node:test";

const { commentsOf, isOverLong } = await import(new URL("../../scripts/comment-check.mjs", import.meta.url).href);

const linesOf = (source: string): number[] => commentsOf(source).map((comment: { lines: number }) => comment.lines);

test("文字列・テンプレート・正規表現の中の // はコメントにしない", () => {
  const source = [
    'const a = "// not a comment";',
    "const b = '// no';",
    "const c = `// ${inner} //`;",
    "const re = /\\/\\//;",
    "const url = <p>https://example.com</p>;",
  ].join("\n");
  assert.deepEqual(commentsOf(source), []);
});

test("連続する // は 1 つのコメントとして行数を数える", () => {
  assert.deepEqual(linesOf("// 1\n// 2\n// 3\nconst a = 1;"), [3]);
});

test("空行を含むブロックは空行を数えない", () => {
  assert.deepEqual(linesOf("/**\n * 1\n *\n * 2\n */\nconst a = 1;"), [2]);
});

test("/// と lint / format のディレクティブは対象外", () => {
  const source = [
    '/// <reference types="vite/client" />',
    "// oxlint-disable-next-line no-console -- 理由",
    "// prettier-ignore",
    "const a = 1;",
  ].join("\n");
  assert.deepEqual(commentsOf(source), []);
});

test("行中の // は直前が空白のときだけコメントにする", () => {
  assert.deepEqual(linesOf("const a = 1;// 説明\n"), []);
  assert.deepEqual(linesOf("const a = 1; // 説明\n"), [1]);
});

test("正規表現の中の引用符とバッククォートは文字列を開かない", () => {
  assert.deepEqual(linesOf("const re = /`([^`]+)`/;\n// a\n// b\n// c"), [3]);
});

test("テンプレートの ${} の中の正規表現も読み飛ばす", () => {
  assert.deepEqual(linesOf('const s = `${x.replace(/"/g, "q")}`;\n// a\n// b\n// c'), [3]);
});

test("値の後ろの / は除算として扱い、後続のコメントを飲み込まない", () => {
  assert.deepEqual(linesOf("const half = (a + b) / 2;\n// a\n// b\n// c"), [3]);
});

test("空白なしの除算と後置インクリメントの後ろでもコメントを数える", () => {
  assert.deepEqual(linesOf("const x = a/b; // a\n// b\n// c"), [3]);
  assert.deepEqual(linesOf("const s = `${a/b}`; // a\n// b\n// c"), [3]);
  assert.deepEqual(linesOf("let n = 0; n++ / 2; // a\n// b\n// c"), [3]);
});

test("return の後ろの / は正規表現として読み飛ばす", () => {
  assert.deepEqual(linesOf("function f() { return /a\\/b/.test(s); } // a\n// b\n// c"), [3]);
});

test("JSX の {/* ... */} も行数を数える", () => {
  assert.deepEqual(linesOf("const el = <div>{/* a\n  b\n  c */}</div>;\nconst x = 1;"), [3]);
});

test("しきい値は 3 行", () => {
  assert.equal(isOverLong({ lines: 2 }), false);
  assert.equal(isOverLong({ lines: 3 }), true);
});
