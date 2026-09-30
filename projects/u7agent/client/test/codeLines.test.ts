// コードブロック / ファイル本文の行番号と行数。チャット本文とファイルプレビューが同じ数え方をすることを固定する。
// 片方だけが独自に数えると、番号と本文の行が 1 対 1 でなくなる (docs/markdown.md#コードブロックの行番号)。
import assert from "node:assert/strict";
import test from "node:test";
import { codeLineCount, lineNumbers } from "../src/lib/codeLines";

test("行数は末尾の改行 1 つを数えない (空白だけの本文は 0 行)", () => {
  const cases: [string, number][] = [
    ["", 0],
    ["\n", 0],
    [" \n\t\n", 0],
    ["a", 1],
    ["a\n", 1],
    // 末尾の改行 2 つは空の行が 1 つ描かれるので 2 行
    ["a\n\n", 2],
    ["a\nb", 2],
    ["a\nb\n\n", 3],
    ["a\n\nb\n", 3],
  ];
  for (const [text, count] of cases) assert.equal(codeLineCount(text), count, JSON.stringify(text));
});

test("行番号の列は 1 から行数まで (行ごとの要素を作らない)", () => {
  assert.equal(lineNumbers(0), "");
  assert.equal(lineNumbers(1), "1");
  assert.equal(lineNumbers(4), "1\n2\n3\n4");
  // 桁が増えても 1 つのテキストノードのまま
  assert.equal(lineNumbers(12), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12");
});
