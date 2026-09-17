// ファイルプレビュー本文のモデル: 言語判定 / 本文の正規化と行数 / ハイライトの上限とフォールバック。
// 本文由来の文字列を HTML として解釈する書き方が描画側に戻らないことを、ソース走査でも固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPreviewCode, FILE_PREVIEW_MAX_TOKENS, previewLang, previewLineNumbers } from "../src/lib/fileCode";

test("拡張子から言語を決める", () => {
  const cases: [string, string | null][] = [
    ["a.ts", "ts"],
    ["a.tsx", "ts"],
    ["a.js", "ts"],
    ["A.TSX", "ts"],
    ["dir.v2/a.json", "json"],
    ["dir/a.jsonc", "json"],
    ["a.py", "python"],
    ["a.sh", "bash"],
    ["a.css", "css"],
    ["a.html", "html"],
    ["a.md", "md"],
    ["a.diff", "diff"],
    ["Dockerfile", "bash"],
    ["dockerfile", "bash"],
    // 判定できないものは素のテキスト
    ["a.yaml", null],
    ["a.toml", null],
    ["README", null],
    [".gitignore", null],
    ["Dockerfile.dev", null],
    ["a.", null],
    [".ts", null],
  ];
  for (const [path, lang] of cases) assert.equal(previewLang(path), lang, path);
});

test("行数は末尾の空行を数えず、CRLF / CR は LF に揃える", () => {
  const cases: [string, string, number][] = [
    ["", "", 0],
    ["a", "a", 1],
    ["a\n", "a", 1],
    ["a\n\n", "a", 1],
    ["a\nb", "a\nb", 2],
    ["a\nb\n\n\n", "a\nb", 2],
    ["a\n\nb\n", "a\n\nb", 3],
    ["a\r\nb\r\n", "a\nb", 2],
    ["a\rb", "a\nb", 2],
    ["\n", "", 0],
    ["\n\n", "", 0],
  ];
  for (const [input, text, lineCount] of cases) {
    const code = buildPreviewCode(input, "a.txt");
    assert.deepEqual({ text: code.text, lineCount: code.lineCount }, { text, lineCount }, JSON.stringify(input));
  }
});

test("対応言語はトークンに分解し、入力を欠落させない", () => {
  const source = "export function f(x: number): string {\n  // メモ\n  return `v=${x}`;\n}\n";
  const code = buildPreviewCode(source, "src/a.ts");
  assert.equal(code.highlight?.lang, "ts");
  assert.equal(code.highlight?.tokens.map((token) => token.text).join(""), code.text);
  assert.ok(
    code.highlight?.tokens.some((token) => token.kind === "key"),
    "キーワードを色分けする",
  );
});

test("判定できない拡張子でも本文と行数は出す (ハイライトだけ落とす)", () => {
  const code = buildPreviewCode("a\nb\n", "a.yaml");
  assert.equal(code.highlight, null);
  assert.equal(code.text, "a\nb");
  assert.equal(code.lineCount, 2);
});

test("フェンスの上限 (40 KiB) を超える本文もファイル側の上限まではハイライトする", () => {
  const source = `const a = "${"x".repeat(50_000)}";\n`;
  const code = buildPreviewCode(source, "a.ts");
  assert.ok(source.length > 40 * 1024);
  assert.equal(code.highlight?.lang, "ts");
});

test("上限を超える本文はハイライトしない", () => {
  // サンドボックスの上限 (256 KiB) を超える本文は素のテキストで出す
  const source = `const a = 1;\n${"// x\n".repeat(60_000)}`;
  const code = buildPreviewCode(source, "a.ts");
  assert.ok(source.length > 256 * 1024);
  assert.equal(code.highlight, null);
  assert.equal(code.lineCount, 60_001);
});

test("トークンが多すぎるときはハイライトしない", () => {
  // 1 文字ずつ別トークンになる JSON (詰めた本文) でも span を作りすぎない
  const source = "1,".repeat(FILE_PREVIEW_MAX_TOKENS / 2 + 1);
  const code = buildPreviewCode(source, "a.json");
  assert.equal(code.highlight, null);
  assert.equal(code.text, source);
});

test("行番号の列は 1 から行数まで (行ごとの要素を作らない)", () => {
  assert.equal(previewLineNumbers(0), "");
  assert.equal(previewLineNumbers(1), "1");
  assert.equal(previewLineNumbers(4), "1\n2\n3\n4");
});

test("不正な入力でも例外を投げない", () => {
  for (const input of ["\u0000", "\r", "\u{1f600}", "\ud800", "a".repeat(10_000), "a\r\n\r\nb\r"]) {
    assert.doesNotThrow(() => buildPreviewCode(input, "a.ts"), JSON.stringify(input.slice(0, 8)));
  }
});

test("描画側は DOM 文字列も HTML パースもインライン style も使わない (本番 CSP は style-src 'self')", () => {
  const files = ["src/lib/fileCode.ts", "src/components/FilePreview.tsx"];
  const forbidden = ["innerHTML", "dangerouslySetInnerHTML", "DOMParser", "style={", 'style="'];
  for (const file of files) {
    const code = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    for (const token of forbidden) assert.ok(!code.includes(token), `${file} に ${token} がある`);
  }
});
