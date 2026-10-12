// ファイルビューアの取得待ちの印。見た目はスピナー、意味は sr-only の文字で持つことを固定する
// (見え方そのものは client に DOM テスト基盤が無いため、ブラウザで手動確認する)。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FilePreviewProps } from "../src/components/FilePreview";

// FileBrowser / FilePreview は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { LoadingMark } = await import("../src/components/LoadingMark");
const { FilePreview } = await import("../src/components/FilePreview");
const { FileBrowser } = await import("../src/components/FileBrowser");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

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

test("印はスピナーを出し、文字は読み上げ用に残す", () => {
  const html = renderToStaticMarkup(createElement(LoadingMark));
  assert.ok(html.includes('role="status"'), html);
  assert.ok(html.includes("run-spinner"), html);
  assert.ok(html.includes('aria-hidden="true"'), html);
  // 文字は sr-only の 1 箇所だけにする (見た目には出さず、読み上げには残す)
  assert.match(html, /<span class="sr-only">読み込み中…<\/span>/);
  assert.equal(html.match(/読み込み中/g)?.length, 1, html);
});

test("本文の取得待ち (ソース / Markdown プレビュー) はスピナーで示す", () => {
  // どちらも本文の取得は effect なので、SSR の初期描画が待ちの状態になる
  const source = renderPreview({ paths: ["a.ts"], activePath: "a.ts" });
  assert.ok(source.includes("run-spinner"), source);
  assert.ok(source.includes("読み込み中…"), source);

  const markdown = renderPreview();
  assert.ok(markdown.includes("run-spinner"), markdown);
  assert.ok(markdown.includes("読み込み中…"), markdown);
});

test("本文を取得しない面 (画像 / 音声 / HTML) は待ちの印を出さない", () => {
  for (const path of ["chart.png", "bgm.mp3", "page.html"]) {
    const html = renderPreview({ paths: [path], activePath: path });
    assert.ok(!html.includes("run-spinner"), `${path}: ${html}`);
    assert.ok(!html.includes("読み込み中"), `${path}: ${html}`);
  }
});

test("ツリーの一覧待ちの行もスピナーで示す", () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmProvider, null, createElement(FileBrowser, { root: ".", reloadToken: 0, excludeNames: [] })),
  );
  assert.ok(html.includes("run-spinner"), html);
  assert.ok(html.includes("読み込み中…"), html);
});
