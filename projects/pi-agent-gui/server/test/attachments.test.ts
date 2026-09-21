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
  toAttachmentPath,
} from "../src/attachments";
import { statusCodeOf } from "../src/http";

test("composePrompt appends the note with absolute paths at the end of the text", () => {
  assert.equal(
    composePrompt("これを見て", [
      "/workspace/.pi-agent-gui/uploads/a1b2c3d4e5/a.png",
      "/workspace/.pi-agent-gui/uploads/a1b2c3d4e5/b.pdf",
    ]),
    [
      "これを見て",
      "",
      "<attached_files>",
      "- /workspace/.pi-agent-gui/uploads/a1b2c3d4e5/a.png",
      "- /workspace/.pi-agent-gui/uploads/a1b2c3d4e5/b.pdf",
      "</attached_files>",
    ].join("\n"),
  );
  // 添付なしは本文そのまま
  assert.equal(composePrompt("これを見て", []), "これを見て");
  // 本文が空なら注記だけ (先頭に空行を作らない)
  assert.equal(
    composePrompt("", ["/workspace/.pi-agent-gui/uploads/a1b2c3d4e5/a.png"]),
    ["<attached_files>", "- /workspace/.pi-agent-gui/uploads/a1b2c3d4e5/a.png", "</attached_files>"].join("\n"),
  );
});

test("stripAttachedFiles and splitAttachedFiles round-trip the note", () => {
  const absolute = "/workspace/.pi-agent-gui/uploads/a1b2c3d4e5/a.png";
  const prompt = composePrompt("本文", [absolute]);
  assert.equal(stripAttachedFiles(prompt), "本文");
  assert.deepEqual(splitAttachedFiles(prompt), { text: "本文", files: [absolute] });
  // 注記が無い本文はそのまま
  assert.equal(stripAttachedFiles("本文だけ"), "本文だけ");
  assert.equal(splitAttachedFiles("本文だけ"), undefined);
  // 本文に同じタグが入っていても、末尾の注記だけを切り離す
  const tricky = composePrompt("タグ <attached_files> を含む本文", [absolute]);
  assert.equal(stripAttachedFiles(tricky), "タグ <attached_files> を含む本文");
});

test("normalizeAttachmentPaths requires the session uploads dir and at most 10 items", () => {
  const uploadsDir = ".pi-agent-gui/uploads/a1b2c3d4e5";
  assert.deepEqual(normalizeAttachmentPaths(undefined, uploadsDir), []);
  assert.deepEqual(normalizeAttachmentPaths([], uploadsDir), []);
  // `./` や連続スラッシュは正規化する
  assert.deepEqual(normalizeAttachmentPaths([`./${uploadsDir}/a.png`, `${uploadsDir}//b.png`], uploadsDir), [
    `${uploadsDir}/a.png`,
    `${uploadsDir}/b.png`,
  ]);

  for (const value of [
    {},
    "uploads/a.png",
    [42],
    [`${uploadsDir}`], // ディレクトリ自体は添付にできない
    [`${uploadsDir}/../secret.png`],
    ["docs/a.png"],
    ["uploads/a.png"],
    [".pi-agent-gui/uploads/fffffffff/a.png"], // 別セッションの保存先
    ["/.pi-agent-gui/uploads/a1b2c3d4e5/a.png"],
    [""],
  ]) {
    assert.equal(
      statusCodeOf(captureError(() => normalizeAttachmentPaths(value, uploadsDir))),
      400,
      JSON.stringify(value),
    );
  }
  assert.equal(
    statusCodeOf(
      captureError(() =>
        normalizeAttachmentPaths(
          Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => `${uploadsDir}/${index}.png`),
          uploadsDir,
        ),
      ),
    ),
    400,
  );
  assert.equal(
    normalizeAttachmentPaths(
      Array.from({ length: MAX_ATTACHMENTS }, () => `${uploadsDir}/a.png`),
      uploadsDir,
    ).length,
    10,
  );
});

test("toAttachmentPath only accepts paths under the session uploads dir", () => {
  const uploadsDir = ".pi-agent-gui/uploads/a1b2c3d4e5";
  assert.equal(toAttachmentPath(uploadsDir, `${uploadsDir}/a.png`), `${uploadsDir}/a.png`);
  assert.equal(toAttachmentPath(uploadsDir, `${uploadsDir}/a-1.png`), `${uploadsDir}/a-1.png`);
  // 別セッションの保存先や uploads 外は添付にできない
  assert.equal(toAttachmentPath(uploadsDir, ".pi-agent-gui/uploads/fffffffff/a.png"), undefined);
  assert.equal(toAttachmentPath(uploadsDir, `${uploadsDir}/../a.png`), undefined);
  assert.equal(toAttachmentPath(uploadsDir, "docs/a.png"), undefined);
  assert.equal(toAttachmentPath(uploadsDir, uploadsDir), undefined, "ディレクトリ自体は添付にできない");
  assert.equal(toAttachmentPath(uploadsDir, `${uploadsDir}/`), undefined);
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
