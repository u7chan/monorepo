import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 取得後のソース本文は SSR の初期描画では検査できないため、安全性だけ限定的に走査する。
test("ファイルのソース表示は HTML 挿入・HTML パース・インライン style を使わない", () => {
  const paths = ["src/lib/fileCode.ts", "src/components/FilePreview.tsx"];
  const forbidden = ["innerHTML", "dangerouslySetInnerHTML", "DOMParser", "style={", 'style="'];
  for (const path of paths) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const token of forbidden) assert.ok(!source.includes(token), `${path} に ${token} がある`);
  }
});
