// シンタックスハイライトの契約: 対応言語と言語判定 / 未知の言語と上限超過でハイライトしない /
// トークンが入力を欠落させない (連結すると元の文字列に戻る)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HIGHLIGHT_MAX_LENGTH, highlightCode } from "../src/lib/markdown/highlight";
import type { MdToken, MdTokenKind } from "../src/lib/markdown/highlight";
import { THEMES } from "../src/theme/themes";

const KINDS: MdTokenKind[] = ["key", "str", "num", "com", "fn", "type", "op", "plain"];

const SAMPLES: Record<string, string> = {
  ts: 'export function parseMarkdown(input: string): MdBlock[] {\n  // 純関数\n  return scanBlocks(input.split(/\\r?\\n/), "tsx", 1.5);\n}\n',
  c: '#include <stdio.h>\n\n/* 配列を並べ替える */\nvoid sort(int *a, size_t n) {\n  for (size_t i = 0; i < n; i++) printf("%d\\n", a[i]);\n}\n',
  cpp: "#include <vector>\n\nclass Box final {\npublic:\n  explicit Box(std::vector<int> values) : values_(std::move(values)) {}\n\nprivate:\n  std::vector<int> values_;\n};\n",
  java: "import java.util.List;\n\npublic final class Box<T> {\n  private final List<T> values; // 値\n\n  Box(List<T> values) {\n    this.values = values;\n  }\n}\n",
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvalues := []int{1, 2, 3}\n\tfor i, v := range values {\n\t\tfmt.Println(i, v)\n\t}\n}\n',
  rust: "use std::collections::HashMap;\n\n/// 数を数える\nfn count(values: &[u32]) -> HashMap<u32, usize> {\n    let mut counts = HashMap::new();\n    for value in values {\n        *counts.entry(*value).or_insert(0) += 1;\n    }\n    counts\n}\n",
  json: '{\n  "name": "u7agent",\n  "count": 12,\n  "ok": true,\n  "none": null\n}\n',
  bash: '# 実行\npnpm --filter client test -- --test-name-pattern markdown\ngit switch -c "feat/x"\necho $HOME > out.txt\n',
  python: 'import os\n\n\ndef main(x: int) -> str:\n    """doc"""\n    return f"{x}"  # 文字列\n',
  css: "/* テーマ */\n.md h1, #id .cls:hover {\n  color: var(--c-ink);\n  width: 12.5rem;\n}\n",
  html: "<!-- コメント -->\n<div class=\"a\" data-x='1'><br>text</div>\n",
  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n",
  md: "# 見出し\n\n**強調**と `code`、[link](https://example.com)\n",
};

const tokensOf = (kind: MdTokenKind, tokens: MdToken[] | null) => (tokens ?? []).filter((token) => token.kind === kind);

test("対応言語はトークンに分解し、入力を欠落させない", () => {
  for (const [lang, source] of Object.entries(SAMPLES)) {
    const tokens = highlightCode(source, lang);
    assert.ok(tokens !== null, lang);
    assert.equal(tokens.map((token) => token.text).join(""), source, lang);
    assert.ok(
      tokens.every((token) => token.text !== ""),
      `${lang}: 空トークンを作らない`,
    );
    assert.ok(
      tokens.every((token) => KINDS.includes(token.kind)),
      `${lang}: 未知の種別を作らない`,
    );
  }
});

test("TypeScript はキーワード / 関数 / 文字列 / コメント / 数値 / 型に分かれる", () => {
  const tokens = highlightCode(SAMPLES.ts, "ts");
  assert.deepEqual(
    tokensOf("key", tokens).map((token) => token.text),
    ["export", "function", "return"],
  );
  assert.deepEqual(
    tokensOf("fn", tokens).map((token) => token.text),
    ["parseMarkdown", "scanBlocks", "split"],
  );
  assert.ok(tokensOf("str", tokens).some((token) => token.text === '"/\\r?\\n/"' || token.text.includes("tsx")));
  assert.deepEqual(
    tokensOf("com", tokens).map((token) => token.text),
    ["// 純関数"],
  );
  assert.deepEqual(
    tokensOf("num", tokens).map((token) => token.text),
    ["1.5"],
  );
  assert.deepEqual(
    tokensOf("type", tokens).map((token) => token.text),
    ["string", "MdBlock"],
  );
});

test("C はプリプロセッサ / キーワード / 型名 / マクロ / コメントを塗り分ける", () => {
  const tokens = highlightCode(
    "#include <stdio.h>\n\n/* 配列を並べ替える */\nvoid sort(int *a, size_t n) {\n  FILE *out = NULL;\n}\n",
    "c",
  );
  assert.deepEqual(
    tokensOf("key", tokens).map((token) => token.text),
    ["#include", "void", "int"],
  );
  assert.deepEqual(
    tokensOf("fn", tokens).map((token) => token.text),
    ["sort"],
  );
  assert.deepEqual(
    tokensOf("type", tokens).map((token) => token.text),
    ["size_t", "FILE", "NULL"],
  );
  assert.deepEqual(
    tokensOf("com", tokens).map((token) => token.text),
    ["/* 配列を並べ替える */"],
  );
});

test("JSON のキーと文字列を区別し、リテラルを強調する", () => {
  const tokens = highlightCode(SAMPLES.json, "json");
  assert.deepEqual(
    tokensOf("key", tokens).map((token) => token.text),
    ['"name"', '"count"', '"ok"', "true", '"none"', "null"],
  );
  assert.deepEqual(
    tokensOf("str", tokens).map((token) => token.text),
    ['"u7agent"'],
  );
});

test("bash は行頭のコマンド名とオプションを塗り分ける", () => {
  const tokens = highlightCode(SAMPLES.bash, "bash");
  assert.deepEqual(
    tokensOf("fn", tokens).map((token) => token.text),
    ["pnpm", "git", "echo"],
  );
  assert.deepEqual(tokensOf("com", tokens), [{ kind: "com", text: "# 実行" }]);
  assert.ok(tokensOf("op", tokens).some((token) => token.text === "--filter"));
  assert.ok(tokensOf("type", tokens).some((token) => token.text === "$HOME"));
});

test("HTML はタグ / 属性 / 属性値に分かれる", () => {
  const tokens = highlightCode(SAMPLES.html, "html");
  assert.deepEqual(
    tokensOf("key", tokens).map((token) => token.text),
    ["<div", "<br", "</div"],
  );
  assert.deepEqual(
    tokensOf("type", tokens).map((token) => token.text),
    ["class", "data-x"],
  );
  assert.deepEqual(
    tokensOf("str", tokens).map((token) => token.text),
    ['"a"', "'1'"],
  );
});

test("diff は追加 / 削除 / ハンクを行単位で塗る", () => {
  const tokens = highlightCode(SAMPLES.diff, "diff");
  assert.deepEqual(
    tokensOf("str", tokens).map((token) => token.text),
    ["+new"],
  );
  assert.deepEqual(
    tokensOf("type", tokens).map((token) => token.text),
    ["-old"],
  );
  assert.deepEqual(
    tokensOf("key", tokens).map((token) => token.text),
    ["@@ -1,3 +1,3 @@"],
  );
});

test("別名の言語も同じルールでハイライトする", () => {
  const source = "const a: number = 1;\n";
  const base = JSON.stringify(highlightCode(source, "ts"));
  for (const alias of ["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"]) {
    assert.equal(JSON.stringify(highlightCode(source, alias)), base, alias);
  }
  // C 系 / Go / Rust の別名 (拡張子とフェンスの info 文字列の両方から同じ規則で引ける)
  const cSource = "#include <stdio.h>\nint main(void) { return 0; }\n";
  const cBase = JSON.stringify(highlightCode(cSource, "c"));
  for (const alias of ["c", "h"]) assert.equal(JSON.stringify(highlightCode(cSource, alias)), cBase, alias);
  const cppSource = "class Box final {\npublic:\n  int v = 0;\n};\n";
  const cppBase = JSON.stringify(highlightCode(cppSource, "cpp"));
  for (const alias of ["cpp", "c++", "cc", "cxx", "hh", "hpp", "hxx"])
    assert.equal(JSON.stringify(highlightCode(cppSource, alias)), cppBase, alias);
  const goSource = "func main() {\n\tfmt.Println(len(os.Args))\n}\n";
  const goBase = JSON.stringify(highlightCode(goSource, "go"));
  for (const alias of ["go", "golang"]) assert.equal(JSON.stringify(highlightCode(goSource, alias)), goBase, alias);
  const rustSource = "pub fn count(v: &[u32]) -> usize { v.len() }\n";
  const rustBase = JSON.stringify(highlightCode(rustSource, "rust"));
  for (const alias of ["rs", "rust"]) assert.equal(JSON.stringify(highlightCode(rustSource, alias)), rustBase, alias);
  assert.notEqual(highlightCode("public static void main(String[] a) {}", "java"), null);
  assert.notEqual(highlightCode("pnpm x", "sh"), null);
  assert.notEqual(highlightCode("py = 1", "py"), null);
  assert.notEqual(highlightCode("# h", "markdown"), null);
  assert.notEqual(highlightCode("<!-- x -->", "xml"), null);
  assert.notEqual(highlightCode("+x", "patch"), null);
});

test("未知の言語 (図を含む) と上限超過ではハイライトしない", () => {
  assert.equal(highlightCode("flowchart TD\n  a --> b", "mermaid"), null);
  assert.equal(highlightCode("x = 1", "brainfuck"), null);
  assert.equal(highlightCode("x = 1", null), null);
  assert.equal(highlightCode("x = 1", "{unknown}"), null);
  assert.equal(highlightCode("x".repeat(HIGHLIGHT_MAX_LENGTH + 1), "ts"), null);
  assert.notEqual(highlightCode("x".repeat(HIGHLIGHT_MAX_LENGTH), "ts"), null);
});

test("Object.prototype の名前は言語名として拾わない (継承プロパティを仕様として引かない)", () => {
  // `` ```constructor `` のようなフェンスで ALIASES の継承プロパティを拾うと、言語名が関数になり描画で落ちる
  for (const lang of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])
    assert.equal(highlightCode("const a = 1;", lang), null, lang);
});

test("空のコードでも例外を投げない", () => {
  assert.deepEqual(highlightCode("", "ts"), []);
  assert.deepEqual(highlightCode("", "diff"), []);
});

// 種別と CSS の対応がずれると色が付かないまま静かに壊れるため、ここで突き合わせる
const indexCss = readFileSync(fileURLToPath(new URL("../src/styles/index.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

test("トークン種別すべてに CSS クラスがある", () => {
  for (const kind of KINDS.filter((kind) => kind !== "plain")) {
    assert.ok(indexCss.includes(`.tok-${kind} {`), `.tok-${kind} が index.css に無い`);
  }
});

test("6 テーマすべてがシンタックスの色を定義する", () => {
  for (const name of ["key", "str", "num", "com", "fn", "type", "op"]) {
    const count = indexCss.match(new RegExp(`--c-syn-${name}:`, "g"))?.length ?? 0;
    assert.equal(count, THEMES.length, `--c-syn-${name} が ${THEMES.length} テーマ分無い`);
  }
});
