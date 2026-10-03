import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownImageProvider } from "../src/components/markdown/MarkdownImageRefs";
import { MarkdownView } from "../src/components/markdown/MarkdownView";

const ROOT_CWD = "/workspace";
const CWD = "projects/u7agent";
const rawUrl = (path: string): string => `/api/files/raw?path=${path}`;

function render(
  text: string,
  options: { provider?: boolean; cwd?: string; rootCwd?: string; raw?: (path: string) => string } = {},
): string {
  const markdown = createElement(MarkdownView, { text });
  if (options.provider === false) return renderToStaticMarkup(markdown);
  return renderToStaticMarkup(
    createElement(MarkdownImageProvider, {
      rootCwd: options.rootCwd ?? ROOT_CWD,
      cwd: options.cwd ?? CWD,
      rawUrl: options.raw ?? rawUrl,
      children: markdown,
    }),
  );
}

test("描画: cwd 相対の src を root 相対へ前置して配信 URL にする", () => {
  const html = render("![cafe](generated/cafe.png)");
  assert.ok(
    html.includes('src="/api/files/raw?path=projects/u7agent/generated/cafe.png"'),
    `解決した URL になっていない: ${html}`,
  );
  assert.ok(html.includes('alt="cafe"'));
  assert.ok(html.includes('<button type="button"'), "拡大表示の button で包まれていない");
});

test("描画: 同じ画像の解決 URL は version が変わったときだけ変わる", async () => {
  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:5173", hostname: "localhost" },
    configurable: true,
  });
  const { fileRawUrl } = await import("../src/api");
  const imageUrl = (version: number, suffix = ""): URL => {
    const html = render(`![cafe](generated/cafe.png)${suffix}`, {
      raw: (path) => fileRawUrl(path, version),
    });
    const src = html.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1];
    assert.ok(src, html);
    return new URL(src.replaceAll("&amp;", "&"));
  };
  const initial = imageUrl(0);
  assert.equal(initial.searchParams.get("path"), "projects/u7agent/generated/cafe.png");
  assert.equal(initial.searchParams.get("v"), "0");
  assert.equal(imageUrl(0, "\n\n生成中の追記").toString(), initial.toString());
  const ended = imageUrl(1);
  assert.notEqual(ended.toString(), initial.toString());
  assert.equal(ended.searchParams.get("path"), initial.searchParams.get("path"));
  assert.equal(ended.searchParams.get("v"), "1");
  assert.equal(imageUrl(1).toString(), ended.toString());
});

test("描画: rootCwd 前置きの絶対パスは cwd 相対へ剥がして解決する", () => {
  const html = render("![cafe](/workspace/projects/u7agent/generated/cafe.png)");
  assert.ok(html.includes('src="/api/files/raw?path=projects/u7agent/generated/cafe.png"'), html);
});

test("描画: provider が無い本文は従来どおり src をそのまま使う", () => {
  const html = render("![cafe](generated/cafe.png)", { provider: false });
  assert.ok(html.includes('src="generated/cafe.png"'), html);
});

test("描画: 解決できない src は従来どおり素の src のまま", () => {
  const unchanged = [
    "![cafe](https://example.com/cafe.png)",
    "![cafe](/workspace/other/cafe.png)",
    "![cafe](/etc/passwd.png)",
    "![cafe](../cafe.png)",
    "![cafe](generated/cafe)",
  ];
  for (const text of unchanged) {
    const html = render(text);
    assert.ok(!html.includes("/api/files/raw"), `${text} を解決している`);
  }
  // 外部 URL は safeUrl が画像として描画しない (CSP と同じ結論をパース段階で出す)
  assert.ok(render("![cafe](https://example.com/cafe.png)").includes("md-lit"));
});

test("描画: cwd 未確定の本文は解決しない", () => {
  const html = render("![cafe](generated/cafe.png)", { cwd: "" });
  assert.ok(html.includes('src="generated/cafe.png"'), html);
  assert.ok(!html.includes("/api/files/raw"));
});
