// scripts/docs-text.mjs の散文境界を固定する。推測を外すと、正しい参照を消すか、
// コード例の中の参照を実リンクとして検証するかになる。

import assert from "node:assert/strict";
import test from "node:test";

const { proseOf, unsupportedBlocks, withoutIndentedCode, withoutInlineCode } = await import(
  new URL("../../scripts/docs-text.mjs", import.meta.url).href
);

test("フェンスは ``` でも ~~~ でも落とす", () => {
  const tick = "# T\n\n```md\n[a](x.md)\n```\n\n本文";
  const tilde = "# T\n\n~~~md\n[a](x.md)\n~~~\n\n本文";
  assert.equal(proseOf(tick).includes("[a](x.md)"), false);
  assert.equal(proseOf(tilde).includes("[a](x.md)"), false);
  assert.equal(proseOf(tilde).includes("本文"), true);
});

test("バッククォートが奇数個の行は触らない", () => {
  const line = "説明 <!-- backtick: ` --> 契約は [API](api.md)。`例示`";
  assert.equal(proseOf(line).includes("[API](api.md)"), true);
});

test("バッククォートが偶数個の行はコード span を落とす", () => {
  assert.equal(withoutInlineCode("説明 `[a](x.md)` だけ").includes("[a](x.md)"), false);
  assert.equal(withoutInlineCode("`a` と `b` と [c](x.md)").includes("[c](x.md)"), true);
});

test("空行の後のインデントコードは落とす", () => {
  const text = "本文\n\n    [a](x.md)\n";
  assert.equal(proseOf(text).includes("[a](x.md)"), false);
  assert.equal(proseOf(text).includes("本文"), true);
});

test("段落の継続行は散文として残す", () => {
  assert.equal(proseOf("本文の続き\n    [a](x.md)").includes("[a](x.md)"), true);
});

test("コード例の中のリスト記法はリストとして扱わない", () => {
  assert.equal(proseOf("本文\n\n    - [a](x.md)").includes("[a](x.md)"), false);
});

test("入れ子リストから外側へ戻ると外側の内容インデントで判定する", () => {
  const nested = "- 外側\n  - 内側\n\n  外側の段落\n\n      [a](x.md)\n";
  assert.equal(withoutIndentedCode(nested).includes("[a](x.md)"), false);
});

test("リスト項目の直後の継続行は散文として残す", () => {
  assert.equal(withoutIndentedCode("- 項目\n      [a](x.md)").includes("[a](x.md)"), true);
});

test("見出しや水平線の直後のインデント行はコードとして落とす", () => {
  assert.equal(withoutIndentedCode("# 見出し\n    [a](x.md)").includes("[a](x.md)"), false);
  assert.equal(withoutIndentedCode("---\n    [a](x.md)").includes("[a](x.md)"), false);
});

test("見出しを内容にするリスト項目の直後はコードとして落とす", () => {
  assert.equal(withoutIndentedCode("- # 見出し\n      [a](x.md)").includes("[a](x.md)"), false);
});

test("リストの継続は散文として残す", () => {
  assert.equal(withoutIndentedCode("- 項目\n  継続 [a](x.md)").includes("[a](x.md)"), true);
  assert.equal(withoutIndentedCode("本文 [a](x.md)").includes("[a](x.md)"), true);
});

test("リスト項目の内容が setext 見出しなら、直後のインデント行はコードとして落とす", () => {
  assert.equal(withoutIndentedCode("- 見出し\n  ===\n      [a](x.md)").includes("[a](x.md)"), false);
  assert.equal(withoutIndentedCode("- 見出し\n  --\n      [a](x.md)").includes("[a](x.md)"), false);
});

test("段落のない下線だけの行は段落として扱い、直後のインデント行は散文に残す", () => {
  assert.equal(withoutIndentedCode("===\n    [a](x.md)").includes("[a](x.md)"), true);
});

test("リスト項目の内容が表なら、表の行は段落を開かず、直後のインデント行はコードとして落とす", () => {
  const text = "- | 列 |\n  | --- |\n  | 値 |\n      [a](x.md)";
  assert.equal(withoutIndentedCode(text).includes("[a](x.md)"), false);
});

test("表の直後のインデント行はコードとして落とす", () => {
  assert.equal(withoutIndentedCode("| a |\n| --- |\n| b |\n    [a](x.md)").includes("[a](x.md)"), false);
});

test("表の後の散文は散文として残す", () => {
  assert.equal(withoutIndentedCode("| a |\n| --- |\n散文 [a](x.md)").includes("[a](x.md)"), true);
});

test("段落のない区切り行は表を開かない", () => {
  assert.equal(withoutIndentedCode("本文\n\n| --- |\n    [a](x.md)").includes("[a](x.md)"), true);
});

test("散文の境界を決められない引用と HTML ブロックを検出する", () => {
  assert.deepEqual(unsupportedBlocks("本文\n\n> 引用\n"), [{ line: 3, syntax: "quote" }]);
  assert.deepEqual(unsupportedBlocks("- 項目\n  > 引用\n"), [{ line: 2, syntax: "quote" }]);
  assert.deepEqual(unsupportedBlocks("<div>\n本文\n</div>\n"), [
    { line: 1, syntax: "html" },
    { line: 3, syntax: "html" },
  ]);
});

test("フェンスとインデントコードの中の引用と HTML は検出しない", () => {
  assert.deepEqual(unsupportedBlocks("```\n> 引用\n<div>\n```\n"), []);
  assert.deepEqual(unsupportedBlocks("本文\n\n    > 引用\n"), []);
});

test("行番号はフェンスを外しても元の行を指す", () => {
  assert.deepEqual(unsupportedBlocks("```sh\nls\n```\n本文\n> 引用\n"), [{ line: 5, syntax: "quote" }]);
});
