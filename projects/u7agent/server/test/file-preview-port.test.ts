// プレビュー オリジンのポート解決。待受 (`PI_FILE_PREVIEW_LISTEN_PORT`) とブラウザから見た値
// (`PI_FILE_PREVIEW_PORT`) は別の env で、どちらも未設定は 4318 (prod は compose が 8017:4318 を publish)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FILE_PREVIEW_LISTEN_PORT,
  DEFAULT_FILE_PREVIEW_PORT,
  resolveDevFilePreviewPort,
  resolveFilePreviewListenPort,
  resolveFilePreviewPort,
} from "../src/file-preview-port";

test("待受とブラウザから見たポートの既定はどちらも 4318", () => {
  assert.equal(DEFAULT_FILE_PREVIEW_LISTEN_PORT, 4318);
  assert.equal(DEFAULT_FILE_PREVIEW_PORT, 4318);
});

test("未設定 (undefined / 空文字 / 空白だけ) は既定へ倒す", () => {
  for (const value of [undefined, "", "  "]) {
    assert.equal(resolveFilePreviewPort(value), DEFAULT_FILE_PREVIEW_PORT, JSON.stringify(value));
    assert.equal(resolveFilePreviewListenPort(value), DEFAULT_FILE_PREVIEW_LISTEN_PORT, JSON.stringify(value));
  }
});

test("1〜65535 の整数はそのまま使う", () => {
  for (const resolve of [resolveFilePreviewPort, resolveFilePreviewListenPort]) {
    assert.equal(resolve("1"), 1);
    assert.equal(resolve("4317"), 4317);
    assert.equal(resolve("4318"), 4318);
    assert.equal(resolve("4319"), 4319);
    assert.equal(resolve("65535"), 65535);
    // 前後の空白は許す (env ファイルの書き方に依存させない)
    assert.equal(resolve(" 4319 "), 4319);
  }
});

test("不正な値は起動時に止め、指定した env を名指しする", () => {
  // 値は URL 生成と待受にしか使わず、誤りが画面から見えないため、黙って既定へ落とさない
  for (const value of ["0", "-1", "65536", "99999", "12.5", "abc", "80a", "0x10", "1e3", "+80", "1 2", "NaN"]) {
    assert.throws(() => resolveFilePreviewPort(value), /PI_FILE_PREVIEW_PORT/, `${value} を受け入れている`);
    assert.throws(
      () => resolveFilePreviewListenPort(value),
      /PI_FILE_PREVIEW_LISTEN_PORT/,
      `${value} を受け入れている`,
    );
  }
});

test("dev は PI_FILE_PREVIEW_PORT を正とし、待受 env しか無いときはその値へ揃える", () => {
  assert.equal(resolveDevFilePreviewPort({}), DEFAULT_FILE_PREVIEW_PORT);
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "4319" }), 4319);
  // 待受 env だけを指定してもブラウザから見た値を同じ値にする (dev はブラウザが直接開く)
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_LISTEN_PORT: "4319" }), 4319);
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "4319", PI_FILE_PREVIEW_LISTEN_PORT: "4319" }), 4319);
  // 両方あるときはブラウザから見た値が正 (待受はその値へ寄せる)
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "4319", PI_FILE_PREVIEW_LISTEN_PORT: "4320" }), 4319);
  assert.equal(
    resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: " 4319 ", PI_FILE_PREVIEW_LISTEN_PORT: "4320" }),
    4319,
  );
  // 空白だけの env は未設定として次の env へ倒す
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "  ", PI_FILE_PREVIEW_LISTEN_PORT: "4319" }), 4319);
  assert.equal(resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "  " }), DEFAULT_FILE_PREVIEW_PORT);
});

test("dev の不正値も起動時に止め、指定した env を名指しする", () => {
  assert.throws(() => resolveDevFilePreviewPort({ PI_FILE_PREVIEW_PORT: "abc" }), /PI_FILE_PREVIEW_PORT/);
  assert.throws(() => resolveDevFilePreviewPort({ PI_FILE_PREVIEW_LISTEN_PORT: "0" }), /PI_FILE_PREVIEW_LISTEN_PORT/);
});
