// What: QR ダイアログの描画。共有物名・QR（SVG）・URL・開く・コピー・閉じるを併置し、
// QR の配色を固定して quiet zone を含めること、生成できないときは QR を出さず逃げ道を残すことを固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { QR_QUIET_ZONE_MODULES, qrCodeModules } from "../src/lib/qrCode";
import type { SharedContentResponse } from "../src/types";

const { QrCodeDialog } = await import("../src/components/QrCodeDialog");

const URL_PUBLISHED = "https://u7s-abc123.demo.workers.dev/";
const PUBLISHED_AT = 1_000;

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  sourceKind: "directory",
  provider: "cloudflare",
  status: "published",
  publicUrl: URL_PUBLISHED,
  createdAt: 1,
  updatedAt: 1,
  publishedAt: PUBLISHED_AT,
  stoppedAt: null,
  lastError: null,
  ...overrides,
});

function render(content: SharedContentResponse): string {
  return renderToStaticMarkup(createElement(QrCodeDialog, { item: content, onClose: () => {} }));
}

test("QR ダイアログ: 共有物名・QR・URL・開く・コピー・閉じるを出す", () => {
  const html = render(item());
  const qr = qrCodeModules(URL_PUBLISHED);
  assert.ok(qr, "テスト用 URL から QR を作れる");
  const viewSize = qr.size + QR_QUIET_ZONE_MODULES * 2;

  assert.match(html, /aria-label="dist の QR コード"/);
  assert.ok(html.includes(URL_PUBLISHED), "URL をテキストで出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "開くは外部リンクとして出す");
  assert.match(html, /URL をコピー/);
  assert.match(html, /閉じる/);

  // QR は装飾ではなく画像として読み上げ、URL は本文側に任せる
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="公開 URL の QR コード"/);
  assert.ok(html.includes(`viewBox="0 0 ${viewSize} ${viewSize}"`), "viewBox は quiet zone を含む");
  // テーマのトークンを使わず、白地 + 黒で固定する
  assert.match(html, /fill="#ffffff"/);
  assert.match(html, /fill="#000000"/);
  assert.match(html, /shape-rendering="crispEdges"/);
});

test("QR ダイアログ: 生成できない URL では QR を出さず、URL とコピーだけを残す", () => {
  const longUrl = `https://example.com/${"a".repeat(4000)}`;
  const html = render(item({ publicUrl: longUrl }));

  assert.equal(html.includes('role="img"'), false);
  assert.ok(html.includes(longUrl), "URL はそのまま出す");
  assert.match(html, /URL をコピー/);
  assert.match(html, /QR コードを作れませんでした。下の URL をコピーして渡してください。/);
});
