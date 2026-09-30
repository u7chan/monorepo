// ストレージ有効モード (別オリジンのプレビュー) の切替。client に DOM テスト基盤が無いため、react-dom/server の
// 静的な描画で iframe の src / sandbox とトグルの状態を固定し、配線はソース走査で固定する。ここが崩れると
// 次のどれかになる。
//   1. 有効モードなのに iframe の sandbox が allow-same-origin を落とす (オペークのままで storage が使えない)
//   2. 隔離モードの src が別オリジンになる (既定が隔離でなくなる)
//   3. ポート未取得でも切替が押せる (client にポートを焼き込む原因になる)
//   4. トグルの状態 (aria-pressed / disabled) が実際の iframe とずれる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FilePreviewProps } from "../src/components/FilePreview";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
// (dev はアプリが Vite の 3000 に居る想定にして、iframe が BFF の 4318 へ向くことを見る)
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { FilePreview } = await import("../src/components/FilePreview");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const noop = () => {};

function renderPreview(overrides: Partial<FilePreviewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FilePreview, {
      paths: ["chart.html"],
      activePath: "chart.html",
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

/** トグルの開始タグ (ラベルの直前まで)。属性の並びに依存しない */
function storageToggleTag(html: string): string {
  const label = html.indexOf("保存を有効化");
  assert.ok(label > 0, "ストレージ有効モードのトグルが描画されていない");
  return html.slice(html.lastIndexOf("<button", label), label);
}

test("既定 (隔離) はアプリ オリジンで、トグルは押されていない", () => {
  const html = renderPreview();
  assert.match(html, /sandbox="allow-scripts"/, "隔離モードの sandbox 属性が違う");
  assert.match(html, /src="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/, "隔離モードの src が違う");
  const toggle = storageToggleTag(html);
  assert.ok(toggle.includes('aria-pressed="false"'), "隔離モードなのに押された表示になっている");
  assert.ok(!toggle.includes('disabled=""'), "ポートがあるのに切替が無効になっている");
});

test("有効モードは別オリジンの src と storage の sandbox フラグを使う", () => {
  const html = renderPreview({ origins: { "chart.html": "storage" } });
  // CSP と両方に同じフラグを書く (片方だけ緩めてもオペークのまま)
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-pointer-lock"/, "有効モードの sandbox 属性が違う");
  assert.match(html, /src="http:\/\/localhost:4318\/api\/files\/html\/chart\.html"/, "有効モードの src が違う");
  const toggle = storageToggleTag(html);
  assert.ok(toggle.includes('aria-pressed="true"'), "有効モードなのに押された表示になっていない");
  assert.ok(!toggle.includes('disabled=""'), "有効モードなのに切替が無効になっている");
  // 「新しいタブで開く」は現行どおりアプリ オリジンのまま (隔離された文書を別タブで見る)
  assert.match(
    html,
    /href="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/,
    "新しいタブの URL が変わっている",
  );
});

test("ポート未取得の間は切替を無効にし、ポートを焼き込まない", () => {
  const html = renderPreview({ filePreviewPort: undefined, origins: { "chart.html": "storage" } });
  // 有効モードを選んでいても、ポートが無ければ隔離のまま開く (aria-pressed も実体に合わせる)
  assert.match(html, /sandbox="allow-scripts"/, "ポート無しで有効モードの属性を使っている");
  assert.match(
    html,
    /src="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/,
    "ポート無しで別オリジンを使っている",
  );
  const toggle = storageToggleTag(html);
  assert.ok(toggle.includes('aria-pressed="false"'), "実体と違って押された表示になっている");
  assert.ok(toggle.includes('disabled=""'), "ポート未取得でも切替が押せる");
  assert.ok(!html.includes("4318"), "client にポートを焼き込んでいる");
});

test("切替は配信元の state だけを変え、iframe の属性と src はその state から導く", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /aria-pressed=\{enabled\}/, "押下状態を出していない");
  assert.match(preview, /disabled=\{disabled\}/, "無効状態を出していない");
  assert.match(preview, /onClick=\{\(\) => onToggle\(!enabled\)\}/, "トグルの操作が状態の反転になっていない");
  assert.match(preview, /onOriginChange\(activePath, next \? "storage" : "app"\)/, "タブの配信元を切り替えていない");
  assert.match(preview, /disabled=\{filePreviewPort === undefined\}/, "ポート未取得の判定が違う");
  assert.match(
    preview,
    /filePreviewPort !== undefined && storageEnabled\s*\?\s*fileStoragePreviewUrl\(fetchPath, filePreviewPort\)\s*:\s*fileHtmlPreviewUrl\(fetchPath\)/,
    "src を配信元から導いていない",
  );
  assert.ok(!preview.includes("4318"), "client にポートを焼き込んでいる");

  // state は FileBrowser が持ち、health から受けたポートをそのまま渡す (画面ごとに取得し直さない)
  const browser = read("src/components/FileBrowser.tsx");
  assert.match(browser, /withPreviewOrigin\(prev, path, origin\)/, "配信元を保持していない");
  assert.match(browser, /filePreviewPort=\{filePreviewPort\}/, "FilePreview へポートを渡していない");
  assert.match(
    read("src/App.tsx"),
    /filePreviewPort=\{app\.health\?\.filePreviewPort\}/,
    "health からポートを渡していない",
  );
});
