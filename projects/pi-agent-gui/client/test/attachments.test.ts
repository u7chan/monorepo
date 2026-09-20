// 添付ファイルの純関数 (lib/attachments.ts)。注記の形式は server/src/attachments.ts と対で、
// ここではサーバーが実際に組み立てた形の文字列をパースできることを固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  attachmentRejection,
  formatBytes,
  isImageName,
  splitAttachedFiles,
} from "../src/lib/attachments";

/** server/src/attachments.ts の composePrompt が作る形 */
const PROMPT = [
  "これを見て",
  "",
  "<attached_files>",
  "- ./uploads/photo.png",
  "- ./uploads/report.pdf",
  "</attached_files>",
].join("\n");

test("splitAttachedFiles splits the trailing note from the body", () => {
  assert.deepEqual(splitAttachedFiles(PROMPT), {
    text: "これを見て",
    files: ["uploads/photo.png", "uploads/report.pdf"],
  });
  // 注記が無い本文はそのまま
  assert.deepEqual(splitAttachedFiles("ただの本文"), { text: "ただの本文", files: [] });
  // 添付だけの送信 (本文が空) は空文字に戻る
  assert.deepEqual(splitAttachedFiles(PROMPT.slice("これを見て\n\n".length)), {
    text: "",
    files: ["uploads/photo.png", "uploads/report.pdf"],
  });
  // 本文に同じタグが入っていても、末尾の注記だけを切り離す
  const tricky = [
    "本文に <attached_files> を含む",
    "",
    "<attached_files>",
    "- ./uploads/a.png",
    "</attached_files>",
  ].join("\n");
  assert.deepEqual(splitAttachedFiles(tricky).text, "本文に <attached_files> を含む");
  // ファイル行以外は無視する
  assert.deepEqual(splitAttachedFiles("<attached_files>\n補足\n- ./uploads/a.png\n</attached_files>").files, [
    "uploads/a.png",
  ]);
});

test("isImageName only accepts the raw-servable extensions", () => {
  for (const name of ["a.png", "photo.JPG", "x.jpeg", "x.gif", "x.webp", "x.avif", "x.bmp", "favicon.ico"]) {
    assert.equal(isImageName(name), true, name);
  }
  for (const name of ["a.svg", "a.html", "a.txt", "noext", ".env", "uploads/.png", "a.png.exe"]) {
    assert.equal(isImageName(name), false, name);
  }
});

test("formatBytes shows a compact size for chips", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(MAX_ATTACHMENT_BYTES), "100.0 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
  assert.equal(formatBytes(Number.NaN), "");
});

test("attachmentRejection reports the reason to keep as an error chip", () => {
  assert.equal(attachmentRejection({ name: "a.png", size: 1024 }, 0), undefined);
  assert.equal(attachmentRejection({ name: "a.png", size: 1024 }, MAX_ATTACHMENTS - 1), undefined);
  assert.match(attachmentRejection({ name: "a.png", size: 1024 }, MAX_ATTACHMENTS) ?? "", /最大 10 件まで/);
  assert.match(attachmentRejection({ name: "a.bin", size: MAX_ATTACHMENT_BYTES + 1 }, 0) ?? "", /100 MiB を超える/);
  // 上限ちょうどは通す
  assert.equal(attachmentRejection({ name: "a.bin", size: MAX_ATTACHMENT_BYTES }, 0), undefined);
});
