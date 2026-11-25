import assert from "node:assert/strict";
import test from "node:test";
import { fileExtension, isInsideRoot } from "../src/path-strings";

test("パス内包は root 自身と子を受け入れ、接頭辞が同じ兄弟を拒む", () => {
  assert.equal(isInsideRoot("/work", "/work", "/"), true);
  assert.equal(isInsideRoot("/work", "/work/sub/file", "/"), true);
  assert.equal(isInsideRoot("/work/", "/work/sub/file", "/"), true);
  assert.equal(isInsideRoot("/", "/work/sub/file", "/"), true);
  assert.equal(isInsideRoot("/work", "/workspace/file", "/"), false);
});

test("パス内包は呼び出し側の区切り文字で境界を比較する", () => {
  assert.equal(isInsideRoot("C:\\work", "C:\\work\\file", "\\"), true);
  assert.equal(isInsideRoot("C:\\", "C:\\work\\file", "\\"), true);
  assert.equal(isInsideRoot("C:\\work", "C:\\workspace\\file", "\\"), false);
});

test("拡張子はワイヤパスの最終セグメントで、小文字の最終 suffix を返す", () => {
  assert.equal(fileExtension("folder.with.dot/report.Tar.GZ"), "gz");
  assert.equal(fileExtension("folder.with.dot/report"), undefined);
  assert.equal(fileExtension("folder.with.dot/"), undefined);
  assert.equal(fileExtension("folder/.env"), undefined);
  assert.equal(fileExtension("folder/.env.LOCAL"), "local");
  assert.equal(fileExtension("folder/report."), "");
});
