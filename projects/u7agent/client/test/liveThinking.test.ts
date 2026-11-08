// 実行中の thinking 末尾を状態行の下の 2 行領域へ収める規則。末尾 2 行・160 code point・空行の除去を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { liveThoughtSnippet, THINKING_SNIPPET_CHARS, THINKING_SNIPPET_LINES } from "../src/lib/liveThinking";

test("空行を除いた末尾 2 行だけを残す", () => {
  assert.equal(liveThoughtSnippet("1 行目\n2 行目\n3 行目"), "2 行目\n3 行目");
  assert.equal(liveThoughtSnippet("検討する\n\n\n結論を出す\n"), "検討する\n結論を出す");
  assert.equal(liveThoughtSnippet("   "), "");
  assert.equal(THINKING_SNIPPET_LINES, 2);
});

test("160 code point を超えたら先頭を … にし、全体を 160 code point に収める", () => {
  const long = "あ".repeat(300);
  const snippet = liveThoughtSnippet(long);
  assert.deepEqual(Array.from(snippet).length, THINKING_SNIPPET_CHARS);
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("あ"));
  assert.equal(THINKING_SNIPPET_CHARS, 160);
});

test("絵文字を割らず、境界ちょうどでは … を付けない", () => {
  const exact = "🙂".repeat(THINKING_SNIPPET_CHARS);
  assert.equal(liveThoughtSnippet(exact), exact);
  const overflow = liveThoughtSnippet(`${exact}🙂`);
  assert.ok(overflow.startsWith("…"));
  assert.ok(!overflow.includes("\uFFFD"), "サロゲートペアを割らない");
  assert.deepEqual(Array.from(overflow).length, THINKING_SNIPPET_CHARS);
});
