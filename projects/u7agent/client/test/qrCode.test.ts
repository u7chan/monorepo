// What: URL から作る QR の形（正方・version の範囲・位置検出 / タイミングパターン・dark module）、
// quiet zone を含む viewBox の計算、生成できない入力の扱いを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { QR_QUIET_ZONE_MODULES, qrCodeModules, qrCodePath, qrCodeViewSize } from "../src/lib/qrCode";

const URL = "https://u7s-abc123.demo.workers.dev/";

/** 7x7 の位置検出パターン。外周と中央 3x3 が黒で、その間の 1 輪が白 */
function assertFinder(modules: boolean[][], top: number, left: number) {
  for (let offset = 0; offset < 7; offset += 1) {
    assert.equal(modules[top][left + offset], true, `上辺 (${top}, ${left + offset})`);
    assert.equal(modules[top + 6][left + offset], true, `下辺 (${top + 6}, ${left + offset})`);
    assert.equal(modules[top + offset][left], true, `左辺 (${top + offset}, ${left})`);
    assert.equal(modules[top + offset][left + 6], true, `右辺 (${top + offset}, ${left + 6})`);
  }
  for (let offset = 1; offset <= 5; offset += 1) {
    assert.equal(modules[top + offset][left + 1], false, `白い輪 (${top + offset}, ${left + 1})`);
    assert.equal(modules[top + offset][left + 5], false, `白い輪 (${top + offset}, ${left + 5})`);
  }
  for (let row = 2; row <= 4; row += 1) {
    for (let column = 2; column <= 4; column += 1) {
      assert.equal(modules[top + row][left + column], true, `中央 (${top + row}, ${left + column})`);
    }
  }
}

test("QR: モジュールは正方で、version 1〜40 の大きさ（21〜177）に収まる", () => {
  const qr = qrCodeModules(URL);
  assert.ok(qr, "短い URL は生成できる");
  assert.equal(qr.modules.length, qr.size);
  for (const row of qr.modules) assert.equal(row.length, qr.size);
  assert.ok(qr.size >= 21 && qr.size <= 177, `size=${qr.size}`);
  // version が 1 つ増えると一辺は 4 モジュール増える
  assert.equal((qr.size - 21) % 4, 0);
});

test("QR: 3 つの位置検出パターンとタイミングパターン、dark module を持つ", () => {
  const qr = qrCodeModules(URL);
  assert.ok(qr);
  const last = qr.size - 7;
  assertFinder(qr.modules, 0, 0);
  assertFinder(qr.modules, 0, last);
  assertFinder(qr.modules, last, 0);

  // 位置検出パターンの間（row 6 / column 6）は 1 モジュールおきに黒。version 3 なので
  // 位置合わせパターンは中央にしかなく、timing pattern と重ならない
  for (let index = 8; index <= qr.size - 9; index += 1) {
    assert.equal(qr.modules[6][index], index % 2 === 0, `横 timing (6, ${index})`);
    assert.equal(qr.modules[index][6], index % 2 === 0, `縦 timing (${index}, 6)`);
  }

  // dark module は常に左下の位置検出パターンの右上に置かれる
  assert.equal(qr.modules[qr.size - 8][8], true);
});

test("QR: quiet zone を足した viewBox と、余白の分だけずらした path を返す", () => {
  const qr = qrCodeModules(URL);
  assert.ok(qr);
  assert.equal(QR_QUIET_ZONE_MODULES, 4);
  assert.equal(qrCodeViewSize(qr.size), qr.size + QR_QUIET_ZONE_MODULES * 2);
  assert.equal(qrCodePath([[true]]), "M4 4h1v1h-1z");
  assert.equal(qrCodePath([[false]]), "");
  assert.equal(qrCodePath([[false, true]]), "M5 4h1v1h-1z");
});

test("QR: 空文字と長すぎる URL は例外を投げず null を返す", () => {
  assert.equal(qrCodeModules(""), null);
  assert.equal(qrCodeModules(`https://example.com/${"a".repeat(4000)}`), null);
});
