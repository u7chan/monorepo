import assert from "node:assert/strict";
import test from "node:test";
import { resolveMarkdownAssetPath } from "../src/lib/markdownAsset";

test("相対パスは表示中のファイルのディレクトリ基準で解決する", () => {
  const cases: [string, string, string | null][] = [
    ["a.png", "docs", "docs/a.png"],
    ["a.png", "docs/api", "docs/api/a.png"],
    ["img/a.png", "docs", "docs/img/a.png"],
    // `.` と空セグメントは畳む
    ["./img//a.png", "docs", "docs/img/a.png"],
    // 親参照はディレクトリから遡れる
    ["../shared/a.png", "docs/api", "docs/shared/a.png"],
    ["../../a.png", "docs/api", "a.png"],
    // workspace root の直下のファイルは dir が "." になる
    ["a.png", ".", "a.png"],
    ["img/a.png", ".", "img/a.png"],
    // 先頭の `/` は workspace root からの絶対パスとして扱う
    ["/assets/a.png", "docs/api", "assets/a.png"],
    // ファイル名に無い `?` / `#` 以降は落とす
    ["a.png?v=2", "docs", "docs/a.png"],
    ["a.png#section", "docs", "docs/a.png"],
    // 前後の空白は落とす (リンク記法の内側の空白)
    ["  a.png  ", "docs", "docs/a.png"],
    // dir 側に空セグメントや `.` が混じっても同じ結果になる
    ["a.png", "docs/./api/", "docs/api/a.png"],
    // ディレクトリ自身を指す `.` はそのディレクトリのパスになる (実体が画像かどうかは見ない)
    [".", "docs", "docs"],
  ];
  for (const [src, dir, expected] of cases) {
    assert.equal(resolveMarkdownAssetPath(src, dir), expected, `${src} @ ${dir}`);
  }
});

test("外部 URL・fragment だけ・root の外は解決しない (入力をそのまま使わせる)", () => {
  const cases: [string, string][] = [
    // scheme 付きと protocol-relative はローカルの参照ではない
    ["https://example.com/a.png", "docs"],
    ["http://example.com/a.png", "docs"],
    ["//cdn.example.com/a.png", "docs"],
    ["data:image/png;base64,AAAA", "docs"],
    ["mailto:a@example.com", "docs"],
    ["#section", "docs"],
    // `..` で workspace root より上へ出るものは開かせない
    ["../../../a.png", "docs/api"],
    ["../a.png", "."],
    ["/../a.png", "docs"],
    // 解決してもファイルを指さないもの
    ["", "docs"],
    ["   ", "docs"],
    ["..", "docs"],
    ["../..", "docs/api"],
    ["?v=2", "docs"],
    ["#a.png", "docs"],
  ];
  for (const [src, dir] of cases) {
    assert.equal(resolveMarkdownAssetPath(src, dir), null, `${src} @ ${dir}`);
  }
});

test("不正な入力でも例外を投げない", () => {
  for (const src of ["\u0000", "\r\n", "\u{1f600}.png", "a".repeat(10_000)]) {
    assert.doesNotThrow(() => resolveMarkdownAssetPath(src, "docs"), JSON.stringify(src.slice(0, 8)));
  }
});
