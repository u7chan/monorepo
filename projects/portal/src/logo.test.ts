// ロゴアセットの仕様

import { describe, expect, test } from "bun:test";

const logoUrl = new URL("./logo.svg", import.meta.url);

function loadLogo() {
  return Bun.file(logoUrl).text();
}

describe("logo.svg", () => {
  test("faviconとヘッダーで共用できるよう、viewBox付きのSVGである", async () => {
    const svg = await loadLogo();

    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 64 64"');
  });

  test("外部リソースに依存しない（スクリプト・ラスタ画像・外部参照を含まない）", async () => {
    const svg = await loadLogo();

    expect(svg).not.toMatch(/<script|<image|<foreignObject|xlink:href|href="(?!#)/i);
  });
});
