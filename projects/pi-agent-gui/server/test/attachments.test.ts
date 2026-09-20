// server/src/attachments.ts の純関数。クライアント側 (client/src/lib/attachments.ts) と同じ
// 注記の形式を固定するため、組み立てと分解の往復をここで確かめる。

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATTACHMENTS,
  composePrompt,
  normalizeAttachmentPaths,
  splitAttachedFiles,
  stripAttachedFiles,
} from "../src/attachments";
import { statusCodeOf } from "../src/http";

test("composePrompt appends the note at the end of the text", () => {
  assert.equal(
    composePrompt("これを見て", ["uploads/a.png", "uploads/b.pdf"]),
    ["これを見て", "", "<attached_files>", "- ./uploads/a.png", "- ./uploads/b.pdf", "</attached_files>"].join("\n"),
  );
  // 添付なしは本文そのまま
  assert.equal(composePrompt("これを見て", []), "これを見て");
  // 本文が空なら注記だけ (先頭に空行を作らない)
  assert.equal(
    composePrompt("", ["uploads/a.png"]),
    ["<attached_files>", "- ./uploads/a.png", "</attached_files>"].join("\n"),
  );
});

test("stripAttachedFiles and splitAttachedFiles round-trip the note", () => {
  const prompt = composePrompt("本文", ["uploads/a.png"]);
  assert.equal(stripAttachedFiles(prompt), "本文");
  assert.deepEqual(splitAttachedFiles(prompt), { text: "本文", files: ["uploads/a.png"] });
  // 注記が無い本文はそのまま
  assert.equal(stripAttachedFiles("本文だけ"), "本文だけ");
  assert.equal(splitAttachedFiles("本文だけ"), undefined);
  // 本文に同じタグが入っていても、末尾の注記だけを切り離す
  const tricky = composePrompt("タグ <attached_files> を含む本文", ["uploads/a.png"]);
  assert.equal(stripAttachedFiles(tricky), "タグ <attached_files> を含む本文");
});

test("normalizeAttachmentPaths requires uploads/ paths and at most 10 items", () => {
  assert.deepEqual(normalizeAttachmentPaths(undefined), []);
  assert.deepEqual(normalizeAttachmentPaths([]), []);
  // `./` や連続スラッシュは正規化する
  assert.deepEqual(normalizeAttachmentPaths(["./uploads/a.png", "uploads//b.png"]), ["uploads/a.png", "uploads/b.png"]);

  for (const value of [
    {},
    "uploads/a.png",
    [42],
    ["uploads"], // ディレクトリ自体は添付にできない
    ["docs/a.png"],
    ["uploads/../etc/passwd"],
    ["/uploads/a.png"],
    [""],
  ]) {
    assert.equal(statusCodeOf(captureError(() => normalizeAttachmentPaths(value))), 400, JSON.stringify(value));
  }
  assert.equal(
    statusCodeOf(
      captureError(() =>
        normalizeAttachmentPaths(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `uploads/${index}.png`)),
      ),
    ),
    400,
  );
  assert.equal(normalizeAttachmentPaths(Array.from({ length: MAX_ATTACHMENTS }, () => "uploads/a.png")).length, 10);
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
