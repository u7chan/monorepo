// コードブロック / ファイル本文の行番号と行数。チャット本文とファイルプレビューが同じ数え方をすることを固定する。
// 片方だけが独自に数えると、番号と本文の行が 1 対 1 でなくなる (docs/markdown.md#コードブロックの行番号)。
import assert from "node:assert/strict";
import test from "node:test";
import { codeLineCount, lineNumbers } from "../src/lib/codeLines";

test("行数は本文の行ボックスと一致する (末尾の改行 1 つは数えない)", () => {
  const cases: [string, number][] = [
    ["", 0],
    // 空行も行として描かれる
    ["\n", 1],
    ["\n\n", 2],
    ["a", 1],
    ["a\n", 1],
    ["a\n\n", 2],
    ["a\nb", 2],
    ["a\nb\n\n", 3],
    ["a\n\nb\n", 3],
    // 空白だけの本文も行は描かれる (ファイルプレビューの行数と同じ)
    [" \n\t\n", 2],
  ];
  for (const [text, count] of cases) assert.equal(codeLineCount(text), count, JSON.stringify(text));
});

test("生成中のカーソルは本文の後ろの行に載る", () => {
  const cases: [string, boolean, number][] = [
    // 本文が空か改行で終わるときだけ、カーソルの行が増える
    ["", true, 1],
    ["\n", true, 2],
    ["a", true, 1],
    ["a\n", true, 2],
    ["a\n\n", true, 3],
    // カーソルを出さない (閉じたフェンス) ときは本文の行だけ
    ["", false, 0],
    ["a", false, 1],
    ["a\n", false, 1],
  ];
  for (const [text, caret, count] of cases) {
    assert.equal(codeLineCount(text, caret), count, `${JSON.stringify(text)} caret=${caret}`);
  }
});

test("行番号の列は 1 から行数まで (行ごとの要素を作らない)", () => {
  assert.equal(lineNumbers(0), "");
  assert.equal(lineNumbers(1), "1");
  assert.equal(lineNumbers(4), "1\n2\n3\n4");
  // 桁が増えても 1 つのテキストノードのまま
  assert.equal(lineNumbers(12), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12");
});
