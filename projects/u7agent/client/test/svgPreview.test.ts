// SVG プレビューの data URL。ブラウザーの XML パーサーに渡る前の文字列だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { svgDataUrl } from "../src/lib/svgPreview";

const PREFIX = "data:image/svg+xml;base64,";

function decode(url: string): string {
  assert.ok(url.startsWith(PREFIX), "data URL の MIME が違う");
  return Buffer.from(url.slice(PREFIX.length), "base64").toString("utf8");
}

test("本文をそのまま data URL へ入れ、日本語も往復する", () => {
  const text = `<svg xmlns="http://www.w3.org/2000/svg"><text>日本語 #1</text><rect fill="url(#g)"/></svg>`;
  assert.equal(decode(svgDataUrl(text)), text);
  // fragment の # も base64 の中では区切りにならない (percent encoding だと # を潰す必要がある)
  assert.ok(!svgDataUrl(text).includes("#"), "data URL に生の # が残っている");
});

test("チャンク境界をまたぐ本文も欠けずに往復する (String.fromCharCode の分割)", () => {
  const ascii = `<svg>${"A".repeat(40_000)}</svg>`;
  assert.equal(decode(svgDataUrl(ascii)), ascii);
  const multibyte = `<svg>${"あ".repeat(20_000)}</svg>`;
  assert.equal(decode(svgDataUrl(multibyte)), multibyte);
});

test("空文字でも data URL を返す (描画側は空のファイルを別に扱う)", () => {
  assert.equal(decode(svgDataUrl("")), "");
});
