import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileRefProvider } from "../src/components/markdown/FileRefLink";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

const ROOT_CWD = "/workspace";
const CWD = "projects/u7agent";

function render(text: string, options: { provider?: boolean; cwd?: string; rootCwd?: string } = {}): string {
  const markdown = createElement(MarkdownView, { text });
  if (options.provider === false) return renderToStaticMarkup(markdown);
  return renderToStaticMarkup(
    createElement(FileRefProvider, {
      rootCwd: options.rootCwd ?? ROOT_CWD,
      cwd: options.cwd ?? CWD,
      onOpen: async (): Promise<{ kind: "opened" }> => ({ kind: "opened" }),
      children: markdown,
    }),
  );
}

test("描画: 参照になるインラインコードだけ操作要素 (button) にする", () => {
  const html = render("`./index.html` をブラウザで開くと確認できる。");
  assert.ok(html.includes('<button type="button"'), "button になっていない");
  assert.ok(html.includes("<code>./index.html</code>"), "字面が code で見えていない");
});

test("描画: ディレクトリ区切りを持たない裸名はリンク化しない", () => {
  for (const raw of ["AGENTS.md", "feedback.md", "index.html", "navigator.clipboard"]) {
    const html = render(`実体のない \`${raw}\` を参照する。`);
    assert.ok(!html.includes("<button"), raw);
    assert.ok(html.includes(`<code>${raw}</code>`), raw);
  }
});

test("描画: provider が無い本文は従来どおりの code のまま", () => {
  const html = render("`./index.html`", { provider: false });
  assert.ok(html.includes("<code>./index.html</code>"));
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
  // 共通スキル以外の root 外パスは対象外のまま
  assert.ok(!render("`/workspace/generated/cafe.png`").includes("<button"));
});

test("描画: 共通スキルの絶対パスはスキル面の操作要素になる", () => {
  const text = "スキルの置き場は `/workspace/.agents/skills/alpha/SKILL.md` です。";
  const html = render(text, { cwd: ".u7agent/sessions/s1" });
  assert.ok(html.includes('<button type="button"'), "button になっていない");
  assert.ok(html.includes("<code>/workspace/.agents/skills/alpha/SKILL.md</code>"), "字面が code で見えていない");
  // 開く先の種別を操作名に出す (作業フォルダ面は従来の文言のまま)
  assert.ok(html.includes('title="スキルで開く"'), "スキル面へ開く操作名になっていない");
  assert.ok(render("`./index.html`").includes('title="作業フォルダで開く"'), "作業フォルダの操作名が変わった");
});

test("描画: Markdown リンクの children にある code は操作要素にしない", () => {
  const html = render("[`./index.html`](https://example.com)");
  assert.ok(html.includes('<a href="https://example.com"'), "リンクとして描画されていない");
  assert.ok(html.includes("<code>./index.html</code>"));
  assert.ok(!html.includes("<button"), "<a> の中に button が入っている");
});

test("描画: 作業フォルダのファイルを指す Markdown リンクは操作可能にする", () => {
  const html = render("[課題](docs/design.md) を確認する。");
  assert.ok(html.includes('class="md-filelink"'), html);
  assert.ok(html.includes('href="docs/design.md"'), html);
  assert.ok(html.includes('title="作業フォルダで開く"'), html);
});

test("描画: 裸名のリンクは遷移先を明示しているので採る", () => {
  const html = render("[AGENTS.md](AGENTS.md)");
  assert.ok(html.includes('class="md-filelink"'), html);
});

test("描画: フラグメント付きのリンクもファイルとして扱う", () => {
  const html = render("[x](notes/a.md#L10)");
  assert.ok(html.includes('class="md-filelink"'), html);
  // 遷移先の字面はそのまま残す (ファイルタブへはパスだけを渡す)
  assert.ok(html.includes('href="notes/a.md#L10"'), html);
});

test("描画: Markdown の title は開く先の案内より優先する", () => {
  const html = render('[x](notes/a.md "説明")');
  assert.ok(html.includes('title="説明"'), html);
});

test("描画: 通常の Web リンク・ページ内リンクは従来どおりの a のまま", () => {
  for (const text of [
    "[x](https://example.com/a.md)",
    "[x](#section)",
    "[x](/settings/appearance)",
    "[x](mailto:a@example.com)",
  ]) {
    const html = render(text);
    assert.ok(!html.includes("md-filelink"), text);
    assert.ok(html.includes('target="_blank"'), text);
    assert.ok(html.includes('rel="noreferrer noopener"'), text);
  }
});

test("描画: provider の外では Markdown リンクを横取りしない", () => {
  const html = render("[設計](docs/design.md)", { provider: false });
  assert.ok(!html.includes("md-filelink"), html);
  assert.ok(html.includes('target="_blank"'), html);
});

test("描画: 共通スキルの絶対パスへのリンクはスキル面の操作名になる", () => {
  const html = render("[SKILL](/workspace/.agents/skills/alpha/SKILL.md)", { cwd: ".u7agent/sessions/s1" });
  assert.ok(html.includes('class="md-filelink"'), html);
  assert.ok(html.includes('title="スキルで開く"'), html);
});

test("描画: ファイル参照のリンクでも、リンク内の code は操作要素にしない", () => {
  const html = render("[`docs/design.md`](docs/design.md)");
  assert.ok(html.includes('class="md-filelink"'), html);
  assert.ok(html.includes("<code>docs/design.md</code>"), html);
  assert.ok(!html.includes("<button"), "<a> の中に button が入っている");
});
