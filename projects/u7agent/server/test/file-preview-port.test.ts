// プレビュー オリジンのポート解決。待受は定数 4318 で、ブラウザから見たポートだけを env で差し替える
// (prod は compose が 8017:4318 を publish して PI_FILE_PREVIEW_PORT=8017 を載せる)。
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FILE_PREVIEW_PORT, FILE_PREVIEW_LISTEN_PORT, resolveFilePreviewPort } from "../src/file-preview-port";

test("プレビュー オリジンの待受は 4318 で、ブラウザから見たポートの既定も同じ", () => {
  assert.equal(FILE_PREVIEW_LISTEN_PORT, 4318);
  assert.equal(DEFAULT_FILE_PREVIEW_PORT, 4318);
});

test("未設定 (undefined / 空文字 / 空白だけ) は既定へ倒す", () => {
  for (const value of [undefined, "", "  "]) {
    assert.equal(resolveFilePreviewPort(value), DEFAULT_FILE_PREVIEW_PORT, JSON.stringify(value));
  }
});

test("1〜65535 の整数はそのまま使う", () => {
  assert.equal(resolveFilePreviewPort("1"), 1);
  assert.equal(resolveFilePreviewPort("4318"), 4318);
  assert.equal(resolveFilePreviewPort("8017"), 8017);
  assert.equal(resolveFilePreviewPort("65535"), 65535);
  // 前後の空白は許す (env ファイルの書き方に依存させない)
  assert.equal(resolveFilePreviewPort(" 8017 "), 8017);
});

test("不正な値は起動時に止める", () => {
  // 値は URL 生成にしか使わず、誤りが画面から見えないため、黙って既定へ落とさない
  for (const value of [
    "0",
    "-1",
    "65536",
    "99999",
    "12.5",
    "abc",
    "80a",
    "0x10",
    "1e3",
    "+80",
    "1 2",
    "NaN",
    "Infinity",
  ]) {
    assert.throws(() => resolveFilePreviewPort(value), /PI_FILE_PREVIEW_PORT/, `${value} を受け入れている`);
  }
});
