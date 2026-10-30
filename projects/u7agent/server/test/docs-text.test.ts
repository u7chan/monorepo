// scripts/docs-text.mjs の契約を検証する。
// docs:check は散文の中のリンクとパスを検査するため、「どこまでが散文か」を外すと
// 正しい参照を消して拒否するか、コード例の中の参照を実リンクとして検証するかになる。
// 落とし方の境界をここで固定する。

import assert from "node:assert/strict";
import test from "node:test";

const { proseOf, withoutIndentedCode, withoutInlineCode } = await import(
  new URL("../../scripts/docs-text.mjs", import.meta.url).href
);

test("フェンスは ``` でも ~~~ でも落とす", () => {
  const tick = "# T\n\n```md\n[a](x.md)\n```\n\n本文";
  const tilde = "# T\n\n~~~md\n[a](x.md)\n~~~\n\n本文";
  assert.equal(proseOf(tick).includes("[a](x.md)"), false);
  assert.equal(proseOf(tilde).includes("[a](x.md)"), false);
  assert.equal(proseOf(tilde).includes("本文"), true);
});

test("バッククォートが奇数個の行は触らない（対応を推測して本文を消さない）", () => {
  const line = "説明 <!-- backtick: ` --> 契約は [API](api.md)。`例示`";
  assert.equal(proseOf(line).includes("[API](api.md)"), true);
});

test("バッククォートが偶数個の行はコード span を落とす", () => {
  assert.equal(withoutInlineCode("説明 `[a](x.md)` だけ").includes("[a](x.md)"), false);
  assert.equal(withoutInlineCode("`a` と `b` と [c](x.md)").includes("[c](x.md)"), true);
});

test("行頭 4 スペースのブロックはコードとして落とす", () => {
  const text = "本文\n\n    [a](x.md)\n";
  assert.equal(proseOf(text).includes("[a](x.md)"), false);
  assert.equal(proseOf(text).includes("本文"), true);
});

test("リストの継続は散文として残す（内容のインデント + 4 からがコード）", () => {
  const continuation = "- 項目\n\n    [a](x.md)\n";
  const codeInList = "- 項目\n\n      [a](x.md)\n";
  assert.equal(withoutIndentedCode(continuation).includes("[a](x.md)"), true);
  assert.equal(withoutIndentedCode(codeInList).includes("[a](x.md)"), false);
});

test("リストの外の本文はそのまま残す", () => {
  assert.equal(withoutIndentedCode("本文 [a](x.md)").includes("[a](x.md)"), true);
});
