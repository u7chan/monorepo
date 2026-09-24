// assistant 本文のインラインコードをファイル参照の操作要素にするかの描画契約。client に DOM テスト基盤が
// 無いため、react-dom/server の描画で markup を固定し、リンク内 code の除外と rest / hover の cue はソース走査で押さえる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileRefProvider } from "../src/components/markdown/FileRefLink";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const ROOT_CWD = "/workspace";
const CWD = "projects/u7agent";

function render(text: string, options: { provider?: boolean; cwd?: string; rootCwd?: string } = {}): string {
  const markdown = createElement(MarkdownView, { text });
  if (options.provider === false) return renderToStaticMarkup(markdown);
  return renderToStaticMarkup(
    createElement(FileRefProvider, {
      rootCwd: options.rootCwd ?? ROOT_CWD,
      cwd: options.cwd ?? CWD,
      onOpen: () => {},
      children: markdown,
    }),
  );
}

test("描画: 参照になるインラインコードだけ操作要素 (button) にする", () => {
  const html = render("`index.html` をブラウザで開くと確認できる。");
  assert.ok(html.includes('<button type="button"'), "button になっていない");
  assert.ok(html.includes('class="md-fileref"'));
  assert.ok(html.includes("<code>index.html</code>"), "字面が code で見えていない");
});

test("描画: provider が無い本文は従来どおりの code のまま", () => {
  const html = render("`index.html`", { provider: false });
  assert.ok(html.includes("<code>index.html</code>"));
  assert.ok(!html.includes("<button"), "provider の外で操作要素にしている");
});

test("描画: 参照にならない字面は code のまま", () => {
  for (const text of ["`localStorage`", "`node --check script.js`", "`assets/`", "`v1.2.3`", "`a/../b.html`"]) {
    const html = render(text);
    assert.ok(!html.includes("<button"), text);
    assert.ok(html.includes("<code>"), text);
  }
});

test("描画: rootCwd 前置きの絶対パスは解決し、cwd 外は解決しない", () => {
  assert.ok(render("`/workspace/projects/u7agent/index.html`").includes("<button"));
  assert.ok(!render("`/workspace/.u7agent/uploads/3a7bfba36f/a.png`").includes("<button"));
  assert.ok(!render("`/etc/passwd.md`").includes("<button"));
});

test("描画: Markdown リンクの children にある code は操作要素にしない", () => {
  const html = render("[`index.html`](https://example.com)");
  assert.ok(html.includes('<a href="https://example.com"'), "リンクとして描画されていない");
  assert.ok(html.includes("<code>index.html</code>"));
  assert.ok(!html.includes("<button"), "<a> の中に button が入っている");
});

test("描画: 引用 / リスト / 表の中の code も操作要素にする", () => {
  const blocks = ["> `index.html`", "- `index.html`", "| a |\n| --- |\n| `index.html` |"];
  for (const text of blocks) {
    assert.ok(render(text).includes("<button"), text);
  }
});

test("ソース走査: インラインコードの描画が matcher を通り、リンク内を除外している", () => {
  const source = read("src/components/markdown/MarkdownView.tsx");
  assert.ok(source.includes("<InlineFileRef text={node.text} />"), "matcher を通す描画がない");
  assert.ok(source.includes("return inLink ? <code>{node.text}</code> : <InlineFileRef text={node.text} />;"));
  assert.ok(source.includes("<InlineNodes nodes={node.children} inLink />"), "リンクの children に印を渡していない");
  // 長文のプレーン表示フォールバックは code を作らない (解析もしない)
  assert.ok(
    source.includes(
      'if (text.length > MARKDOWN_MAX_LENGTH) return <div className="md whitespace-pre-wrap">{text}</div>;',
    ),
  );
});

test("ソース走査: 判定は純関数 (lib/fileRef) に閉じている", () => {
  const link = read("src/components/markdown/FileRefLink.tsx");
  assert.ok(link.includes("resolveFileRef(text, rootCwd, cwd)"), "解決を lib/fileRef に委譲していない");
  assert.ok(!link.includes("split("), "matcher が描画側に漏れている");
});

const indexCss = read("src/styles/index.css").replace(/\/\*[\s\S]*?\*\//g, "");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = indexCss.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} のルールが index.css に無い`);
  return match[1];
}

test("CSS: rest で非操作の code と区別できる cue を持つ", () => {
  const rest = cssRule(".md-fileref code");
  assert.match(rest, /color:\s*var\(--c-accent-text\)/);
  assert.match(rest, /text-decoration:\s*underline/);
  assert.match(rest, /border-color:\s*color-mix\(in srgb,\s*var\(--c-focus\) 50%,\s*var\(--c-line\)\)/);
  // .md code と同じ詳細度 (0,1,1) なので、後ろにあるこのルールが勝つ (順序を入れ替えない)
  assert.ok(indexCss.indexOf(".md-fileref code") > indexCss.indexOf(".md code"), "ルールの順序が逆");
});

test("CSS: hover と focus-visible は rest との差が分かる", () => {
  const hover = cssRule(".md-fileref:hover code");
  assert.match(hover, /border-color:\s*var\(--c-focus\)/);
  assert.match(hover, /background:\s*var\(--c-accent-wash\)/);
  assert.match(cssRule(".md-fileref:focus-visible"), /outline:\s*2px solid var\(--c-focus\)/);
});
