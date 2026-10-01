// client に DOM テスト基盤が無いため、iframe の属性と別オリジンのスイッチの状態は react-dom/server の静的描画で固定し、
// 配線はソース走査で固定する (sandbox フラグが読まれる時点は DOM の実挙動なので E2E で見る)。
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

test("スイッチは配信元の state だけを変え、iframe の属性と src と新しいタブはその state から導く", () => {
  const preview = read("src/components/FilePreview.tsx");
  assert.match(preview, /checked=\{storageEnabled\}/, "スイッチへ状態を渡していない");
  assert.match(preview, /disabled=\{filePreviewPort === undefined\}/, "ポート未取得の判定が違う");
  assert.match(
    preview,
    /onChange=\{\(next\) => onOriginChange\(activePath, next \? "storage" : "app"\)\}/,
    "タブの配信元を切り替えていない",
  );
  // スイッチは共有の ToggleSwitch を使い、パス行の高さに合わせる (aria-checked は ToggleSwitch が出す)
  assert.match(preview, /<ToggleSwitch[\s\S]*?size="sm"/, "パス行用の小さいスイッチを使っていない");
  assert.match(
    preview,
    /filePreviewPort !== undefined && storageEnabled\s*\?\s*fileStoragePreviewUrl\(fetchPath, filePreviewPort\)\s*:\s*fileHtmlPreviewUrl\(fetchPath\)/,
    "iframe の src を配信元から導いていない",
  );
  assert.match(
    preview,
    /filePreviewPort === undefined \? fileHtmlPreviewUrl\(fetchPath\) : fileStoragePreviewUrl\(fetchPath, filePreviewPort\)/,
    "新しいタブの URL をポートの有無から導いていない",
  );
  assert.ok(!preview.includes("4318"), "client にポートを焼き込んでいる");
  // 配信元の切替は src と sandbox を同時に変えるため、要素を作り直さないと Chromium は古い sandbox フラグで
  // 新文書を作る (属性の適用順に依存させない)
  assert.match(
    preview,
    /<iframe[\s\S]*?key=\{storageEnabled \? "storage" : "isolated"\}/,
    "配信元の切替で iframe を作り直す key が無い",
  );

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
