import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { FilePreviewProps } from "../src/components/FilePreview";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
// (dev はアプリが Vite の 3000 に居る想定にして、iframe が BFF の 4318 へ向くことを見る)
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { FilePreview } = await import("../src/components/FilePreview");

const noop = () => {};

function renderPreview(overrides: Partial<FilePreviewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FilePreview, {
      previewVersion: 0,
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

/** パス行の別オリジンのスイッチの開始タグ (ラベルまで)。属性の並びに依存しない */
function originSwitchTag(html: string): string {
  const label = html.indexOf(">別オリジン<");
  assert.ok(label > 0, "別オリジンのスイッチが描画されていない");
  return html.slice(html.lastIndexOf("<button", label), label);
}

test("既定は別オリジンで、スイッチは ON", () => {
  const html = renderPreview();
  // CSP と両方に同じフラグを書く (片方だけ緩めてもオペークのまま)
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-pointer-lock"/, "既定の sandbox 属性が違う");
  assert.match(html, /src="http:\/\/localhost:4318\/api\/files\/html\/chart\.html"/, "既定の src が別オリジンでない");
  const toggle = originSwitchTag(html);
  assert.ok(toggle.includes('role="switch"'), "スイッチになっていない");
  assert.ok(toggle.includes('aria-checked="true"'), "既定なのに OFF の表示になっている");
  assert.ok(!toggle.includes('disabled=""'), "ポートがあるのに切替が無効になっている");
  // ラベルは配信元 (別オリジン) を名指し、押した結果 (localStorage などが使えなくなる) は title で補う
  assert.ok(
    toggle.includes('title="アプリと同じオリジンで開き直し、localStorage などを使えなくします"'),
    "ON のスイッチの title が押した結果になっていない",
  );
});

test("隔離へ戻す選択はアプリ オリジンの src と allow-scripts を使う", () => {
  const html = renderPreview({ origins: { "chart.html": "app" } });
  assert.match(html, /sandbox="allow-scripts"/, "隔離モードの sandbox 属性が違う");
  assert.match(html, /src="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/, "隔離モードの src が違う");
  const toggle = originSwitchTag(html);
  assert.ok(toggle.includes('aria-checked="false"'), "隔離なのに ON の表示になっている");
  assert.ok(!toggle.includes('disabled=""'), "隔離モードなのに切替が無効になっている");
  assert.ok(
    toggle.includes('title="別オリジンで開き直し、localStorage などを使えるようにします"'),
    "OFF のスイッチの title が押した結果になっていない",
  );
});

test("新しいタブはパス行の切替と関係なく常に別オリジンで開く", () => {
  // ストレージ有効モードで開くのが別タブを出す目的なので、iframe を隔離へ戻していても別オリジンを使う
  const href = /href="http:\/\/localhost:4318\/api\/files\/html\/chart\.html"/;
  assert.match(renderPreview(), href, "新しいタブが別オリジンで開かない");
  assert.match(renderPreview({ origins: { "chart.html": "app" } }), href, "隔離へ戻すと新しいタブも隔離になっている");
  const html = renderPreview();
  assert.match(html, /<a[^>]*target="_blank"[^>]*rel="noreferrer noopener"[^>]*aria-label="新しいタブで開く"/);
});

test("ポート未取得の間はスイッチを無効にし、ポートを焼き込まない", () => {
  const html = renderPreview({ filePreviewPort: undefined });
  // 別オリジンを選べないので隔離で開く (aria-checked も実体に合わせる)
  assert.match(html, /sandbox="allow-scripts"/, "ポート無しで有効モードの属性を使っている");
  assert.match(
    html,
    /src="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/,
    "ポート無しで別オリジンを使っている",
  );
  // 新しいタブも行き先が分からない間だけ同一オリジンへ倒す
  assert.match(
    html,
    /href="http:\/\/localhost:3000\/api\/files\/html\/chart\.html"/,
    "ポート無しで別オリジンへ出そうとしている",
  );
  const toggle = originSwitchTag(html);
  assert.ok(toggle.includes('aria-checked="false"'), "実体と違って ON の表示になっている");
  assert.ok(toggle.includes('disabled=""'), "ポート未取得でも切替が押せる");
  assert.ok(!html.includes("4318"), "client にポートを焼き込んでいる");
});

test("画像は raw URL とサイズを表示し、HTML 用の切替や本文コピーは出さない", () => {
  const html = renderPreview({ paths: ["chart.png"], activePath: "chart.png", activeSize: 2_048, previewVersion: 7 });
  assert.match(html, /<img[^>]*src="[^"]*\/api\/files\/raw\?path=chart.png[^"]*v=7"[^>]*alt="chart.png のプレビュー"/);
  assert.ok(html.includes("2.0 KB"));
  assert.ok(!html.includes("別オリジン"));
  assert.ok(!html.includes('aria-label="本文をコピー"'));
  assert.ok(!html.includes('aria-label="新しいタブで開く"'));
});
