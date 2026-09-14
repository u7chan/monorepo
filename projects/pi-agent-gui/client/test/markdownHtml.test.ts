// 生 HTML の許可リスト。タグを自前でトークン化し、DOM に解釈させずに 3 段階へ振り分ける。
//   描画する / タグは描画して属性だけ落とす / タグごと原文表示 (実行も描画もしない)
import assert from "node:assert/strict";
import test from "node:test";
import { parseHtml, safeUrl, decodeEntities } from "../src/lib/markdown/html";
import { parseInline } from "../src/lib/markdown/inline";
import type { HtmlNode } from "../src/lib/markdown/types";

const text = (value: string) => ({ kind: "text" as const, text: value });

const ALLOWED = "b strong i em u s del ins code kbd mark small sub sup span a br hr img".split(" ");

function walk(node: HtmlNode, visit: (node: HtmlNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  if (node.kind === "element") {
    for (const child of node.children) walk(child, visit, depth + 1);
  }
}

test("許可タグは element として読める", () => {
  for (const tag of ALLOWED) {
    if (tag === "img") {
      const result = parseHtml('<img src="/a.png" alt="a">', 0);
      assert.equal(result?.node.kind, "element", tag);
      continue;
    }
    const result = parseHtml(`<${tag}>x</${tag}>`, 0);
    assert.equal(result?.node.kind, "element", tag);
  }
});

test("入れ子の許可タグは木になる", () => {
  assert.deepEqual(parseHtml("<b>太<b>字</b></b>", 0)?.node, {
    kind: "element",
    tag: "b",
    attrs: {},
    children: [
      { kind: "text", text: "太" },
      { kind: "element", tag: "b", attrs: {}, children: [{ kind: "text", text: "字" }] },
    ],
  });
});

test("装飾・識別属性はタグごと落とす (タグ自体は描画する)", () => {
  assert.deepEqual(parseHtml('<span id="i" class="c" style="color:red" data-x="1">x</span>', 0)?.node, {
    kind: "element",
    tag: "span",
    attrs: {},
    children: [{ kind: "text", text: "x" }],
  });
});

test("内容に意味を持つ属性だけを通す", () => {
  assert.deepEqual(parseHtml('<a href="/rel" title="t" target="_self" rel="x" onclick="steal()">x</a>', 0)?.node, {
    kind: "element",
    tag: "a",
    attrs: { href: "/rel", title: "t" },
    children: [{ kind: "text", text: "x" }],
  });
  assert.deepEqual(parseHtml('<img src="/a.png" alt="説明" title="t" width="9">', 0)?.node, {
    kind: "element",
    tag: "img",
    attrs: { src: "/a.png", alt: "説明", title: "t" },
    children: [],
  });
});

test("属性値の実体参照は URL として読める形に戻す", () => {
  assert.deepEqual(parseHtml('<a href="https://x.example/?a=1&amp;b=2">x</a>', 0)?.node, {
    kind: "element",
    tag: "a",
    attrs: { href: "https://x.example/?a=1&b=2" },
    children: [{ kind: "text", text: "x" }],
  });
});

test("不正な URL はタグごと原文表示に落ちる", () => {
  assert.deepEqual(parseHtml('<a href="javascript:alert(1)">x</a>', 0)?.node, {
    kind: "verbatim",
    text: '<a href="javascript:alert(1)">',
  });
  assert.deepEqual(parseHtml('<a href="vbscript:x">x</a>', 0)?.node, { kind: "verbatim", text: '<a href="vbscript:x">' });
});

test("外部 URL の画像と src の無い画像は原文表示に落ちる", () => {
  assert.deepEqual(parseHtml('<img src="https://evil.example/x.png">', 0)?.node, {
    kind: "verbatim",
    text: '<img src="https://evil.example/x.png">',
  });
  assert.deepEqual(parseInline('<img src="//evil.example/x.png">')[0], {
    kind: "html",
    node: { kind: "verbatim", text: '<img src="//evil.example/x.png">' },
  });
  assert.deepEqual(parseHtml("<img>", 0)?.node, { kind: "verbatim", text: "<img>" });
});

test("許可外のタグは実行も描画もせずタグごと原文になる", () => {
  assert.deepEqual(parseInline("<div>x</div>"), [
    { kind: "html", node: { kind: "verbatim", text: "<div>" } },
    { kind: "text", text: "x" },
    { kind: "html", node: { kind: "verbatim", text: "</div>" } },
  ]);
  assert.deepEqual(parseInline("<script>alert(1)</script>"), [
    { kind: "html", node: { kind: "verbatim", text: "<script>" } },
    { kind: "text", text: "alert(1)" },
    { kind: "html", node: { kind: "verbatim", text: "</script>" } },
  ]);
});

test("対応しない閉じタグは原文表示になる", () => {
  assert.deepEqual(parseHtml("<b>a</i>b</b>", 0)?.node, {
    kind: "element",
    tag: "b",
    attrs: {},
    children: [
      { kind: "text", text: "a" },
      { kind: "verbatim", text: "</i>" },
      { kind: "text", text: "b" },
    ],
  });
  assert.deepEqual(parseHtml("</b>", 0)?.node, { kind: "verbatim", text: "</b>" });
});

test("閉じの無いタグは開始タグだけ原文表示になる (自動補完しない)", () => {
  assert.deepEqual(parseInline("<b>閉じない"), [
    { kind: "html", node: { kind: "verbatim", text: "<b>" } },
    { kind: "text", text: "閉じない" },
  ]);
});

test("タグとして読めない < は本文の文字のまま残る", () => {
  assert.equal(parseHtml("a < b", 2), null);
  assert.deepEqual(parseInline("a < b"), [{ kind: "text", text: "a < b" }]);
  assert.deepEqual(parseInline("1 < 2 > 0"), [{ kind: "text", text: "1 < 2 > 0" }]);
});

test("入れ子が深すぎるときはタグごと原文に落として走査を打ち切る", () => {
  const deep = "<b>".repeat(12) + "x" + "</b>".repeat(12);
  const result = parseHtml(deep, 0);
  assert.ok(result, "先頭のタグは読める");
  let maxDepth = 0;
  const verbatim: string[] = [];
  walk(result.node, (node, depth) => {
    if (node.kind === "element") maxDepth = Math.max(maxDepth, depth);
    if (node.kind === "verbatim") verbatim.push(node.text);
  });
  assert.ok(maxDepth < 8, `入れ子は上限まで (実際: ${maxDepth})`);
  assert.ok(verbatim.length > 0, "上限を超えたタグは原文表示になる");
});

test("大文字のタグも小文字として扱う", () => {
  assert.deepEqual(parseHtml("<B>x</B>", 0)?.node, {
    kind: "element",
    tag: "b",
    attrs: {},
    children: [{ kind: "text", text: "x" }],
  });
});

test("safeUrl は相対パスと http / https / mailto だけを通す", () => {
  assert.equal(safeUrl("https://example.com/a", "link"), "https://example.com/a");
  assert.equal(safeUrl("http://example.com/a", "link"), "http://example.com/a");
  assert.equal(safeUrl("mailto:pi@example.com", "link"), "mailto:pi@example.com");
  assert.equal(safeUrl("/docs/README.md", "link"), "/docs/README.md");
  assert.equal(safeUrl("#section", "link"), "#section");
  for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.example/x", "a b", "a\\b", ""]) {
    assert.equal(safeUrl(url, "link"), null, url);
  }
});

test("画像は相対パスだけを通す (外部 URL は CSP で表示できない)", () => {
  assert.equal(safeUrl("/a.png", "image"), "/a.png");
  assert.equal(safeUrl("./a.png", "image"), "./a.png");
  assert.equal(safeUrl("https://example.com/a.png", "image"), null);
  assert.equal(safeUrl("mailto:pi@example.com", "image"), null);
});

test("引用符無しの属性値が / で終わるときは自己終了にしない", () => {
  // HTML のトークナイザと同じく、区切りが無い属性値の末尾の / は値に含める
  assert.deepEqual(parseHtml("<a href=/docs/>リンク</a>", 0)?.node, {
    kind: "element",
    tag: "a",
    attrs: { href: "/docs/" },
    children: [text("リンク")],
  });
  assert.deepEqual(parseHtml("<img src=/x/>", 0)?.node, {
    kind: "element",
    tag: "img",
    attrs: { src: "/x/", alt: "" },
    children: [],
  });
  // 区切り (空白 / 引用符の閉じ) やタグ名の直後の / は自己終了のまま
  assert.deepEqual(parseHtml("<img src=/x />", 0)?.node, {
    kind: "element",
    tag: "img",
    attrs: { src: "/x", alt: "" },
    children: [],
  });
  assert.deepEqual(parseHtml('<img src="/x"/>', 0)?.node, {
    kind: "element",
    tag: "img",
    attrs: { src: "/x", alt: "" },
    children: [],
  });
  assert.deepEqual(parseHtml("<b/>x</b>", 0)?.node, { kind: "element", tag: "b", attrs: {}, children: [] });
});

test("生 HTML の中のテキストだけ実体参照を戻す", () => {
  assert.deepEqual(parseInline("<b>A &amp; B</b>"), [
    { kind: "html", node: { kind: "element", tag: "b", attrs: {}, children: [text("A & B")] } },
  ]);
  assert.deepEqual(parseInline("<b>&lt;div&gt; &quot;q&quot; &#39;s&#39; &#65; &#x41;</b>"), [
    { kind: "html", node: { kind: "element", tag: "b", attrs: {}, children: [text('<div> "q" \'s\' A A')] } },
  ]);
  // 標準 5 種と数値参照の以外は原文のまま残す (無効な符号位置も含む)
  assert.deepEqual(parseInline("<b>&nbsp; &unknown;</b>"), [
    { kind: "html", node: { kind: "element", tag: "b", attrs: {}, children: [text("&nbsp; &unknown;")] } },
  ]);
  assert.equal(decodeEntities("&#xD800;&#0;&#99999999;"), "&#xD800;&#0;&#99999999;");
  // markdown 本文 (生 HTML の外) は解釈しない
  assert.deepEqual(parseInline("A &amp; B"), [text("A &amp; B")]);
});

test("許可リストの判定は例外を投げない", () => {
  for (const input of ["<", "<>", "<>x", "</>", "<a href=>x</a>", "<a href='x'>", "<img src=>", "<b\t>", "<!x>", "<?x?>"]) {
    assert.doesNotThrow(() => parseInline(input), JSON.stringify(input));
  }
});
