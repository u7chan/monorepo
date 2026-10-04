// 入力欄への画像ペースト。名前はブラウザーごとに違い (`image.png` / `blob`) 拡張子も保証されないため、
// 保存名が MIME と日時から決まること、画像以外を添付に混ぜないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { imageExtensionForMime, pastedImageFiles, pastedImageName } from "../src/lib/clipboardImages";

const NOW = new Date(2026, 0, 2, 3, 4, 5);

function fileItem(type: string, file: File | null = new File(["x"], "image.png", { type })) {
  return { kind: "file", type, getAsFile: () => file };
}

test("pastedImageName はローカル時刻の日時を含む保存名を返す", () => {
  assert.equal(pastedImageName("png", NOW), "pasted-20260102-030405.png");
  assert.equal(pastedImageName("jpg", new Date(2026, 11, 31, 23, 59, 59)), "pasted-20261231-235959.jpg");
});

test("imageExtensionForMime は subtype をそのまま使わない MIME を補正する", () => {
  assert.equal(imageExtensionForMime("image/png"), "png");
  assert.equal(imageExtensionForMime("IMAGE/JPEG"), "jpg", "大文字の MIME も受ける");
  assert.equal(imageExtensionForMime(" image/svg+xml "), "svg", "複合 subtype は svg に畳む");
  assert.equal(imageExtensionForMime("image/x-icon"), "ico");
  assert.equal(imageExtensionForMime("image/heic"), "heic", "既知の map に無くても素直な subtype は使える");
  assert.equal(imageExtensionForMime("text/plain"), undefined, "画像以外は扱わない");
  assert.equal(imageExtensionForMime("image/vnd.foo"), undefined, "拡張子にできない subtype は扱わない");
});

test("貼り付けた画像は MIME から決めた名前と型の File になる", () => {
  const [file] = pastedImageFiles({ items: [fileItem("image/png")] }, NOW);
  assert.equal(file.name, "pasted-20260102-030405.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 1, "中身はそのまま引き継ぐ");
});

test("Clipboard item の名前と型が空でも MIME から保存名と型を決める", () => {
  const source = fileItem("image/jpeg", new File(["x"], "blob", { type: "" }));
  const [file] = pastedImageFiles({ items: [source] }, NOW);
  assert.equal(file.name, "pasted-20260102-030405.jpg");
  assert.equal(file.type, "image/jpeg", "file.type が空なら clipboard item の型で補う");
});

test("複数の画像は順番を保って返す", () => {
  const files = pastedImageFiles({ items: [fileItem("image/png"), fileItem("image/webp")] }, NOW);
  assert.deepEqual(
    files.map((file) => file.name),
    ["pasted-20260102-030405.png", "pasted-20260102-030405.webp"],
  );
});

test("画像以外と getAsFile が null の項目は添付しない", () => {
  const items = [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    fileItem("application/pdf", new File(["x"], "doc.pdf", { type: "application/pdf" })),
    fileItem("image/png", null),
  ];
  assert.deepEqual(pastedImageFiles({ items }, NOW), []);
});

test("clipboardData が無い / items が空なら何も返さない", () => {
  assert.deepEqual(pastedImageFiles(null, NOW), []);
  assert.deepEqual(pastedImageFiles(undefined, NOW), []);
  assert.deepEqual(pastedImageFiles({ items: null }, NOW), []);
  assert.deepEqual(pastedImageFiles({ items: [] }, NOW), []);
});
