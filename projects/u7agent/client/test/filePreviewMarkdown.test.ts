import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FilePreviewProps } from "../src/components/FilePreview";
import { MarkdownFilePreview } from "../src/components/markdown/MarkdownFilePreview";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { FilePreview } = await import("../src/components/FilePreview");

const noop = () => {};

function renderPreview(overrides: Partial<FilePreviewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FilePreview, {
      previewVersion: 0,
      paths: ["README.md"],
      activePath: "README.md",
      rootPath: ".",
      modes: {},
      origins: {},
      filePreviewPort: 4318,
      onReveal: noop,
      onModeChange: noop,
      onOriginChange: noop,
      onSelect: noop,
      onClose: noop,
      ...overrides,
    }),
  );
}

/** パス行の切替ボタンの開始タグ (ラベルまで)。属性の並びに依存しない */
function modeButtonTag(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  assert.ok(at > 0, `${label} の切替が描画されていない`);
  return html.slice(html.lastIndexOf("<button", at), at);
}

function imageSrcs(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1] ?? "");
}

test("Markdown のタブは既定でプレビュー、パス行の切替でソースへ戻せる", () => {
  const html = renderPreview();
  assert.ok(modeButtonTag(html, "プレビュー").includes('aria-pressed="true"'), html);
  assert.ok(modeButtonTag(html, "ソース").includes('aria-pressed="false"'), html);
  // HTML 用の操作 (iframe / 別オリジン / 新しいタブ) は Markdown に出さない
  assert.ok(!html.includes("<iframe"), html);
  assert.ok(!html.includes("別オリジン"), html);
  assert.ok(!html.includes("新しいタブで開く"), html);
  // プレビュー中は行数・コピーを出さない (HTML と同じ扱い)。本文の取得は effect なので SSR では読み込み中になる
  assert.ok(!html.includes("本文をコピー"), html);
  assert.ok(html.includes("読み込み中…"), html);
  const source = renderPreview({ modes: { "README.md": "source" } });
  assert.ok(modeButtonTag(source, "ソース").includes('aria-pressed="true"'), source);
  assert.ok(modeButtonTag(source, "プレビュー").includes('aria-pressed="false"'), source);
});

test("Markdown 以外のテキストには切替を出さない", () => {
  const html = renderPreview({ paths: ["a.txt"], activePath: "a.txt" });
  assert.ok(!html.includes(">プレビュー<"), html);
  assert.ok(!html.includes(">ソース<"), html);
});

test("本文を描画し、相対画像は表示中のファイルのディレクトリ基準で解決する", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownFilePreview, {
      text: "# 見出し\n\n![図](assets/flow.png)\n\n![親](../shared/logo.png)",
      dir: "projects/u7agent/docs/api",
      rawUrl: (path) => `/raw/${path}`,
    }),
  );
  assert.ok(html.includes("<h1>見出し</h1>"), html);
  assert.deepEqual(imageSrcs(html), [
    "/raw/projects/u7agent/docs/api/assets/flow.png",
    "/raw/projects/u7agent/docs/shared/logo.png",
  ]);
});

test("解決できない相対画像は入力をそのまま使う", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownFilePreview, {
      text: "![x](../../../secret/a.png)",
      dir: "docs",
      rawUrl: (path) => `/raw/${path}`,
    }),
  );
  assert.deepEqual(imageSrcs(html), ["../../../secret/a.png"]);
});
