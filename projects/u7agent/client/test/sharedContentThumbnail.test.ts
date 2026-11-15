// What: 管理一覧の行のサムネイル枠の描画。未設定でも入口があり、設定済みは版付き URL で表示し、
// 一括停止の実行中だけ押せないことを、静的描画で固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SharedContentResponse } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SharedContentThumbnail } = await import("../src/components/sharing-settings/SharedContentThumbnail");

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  sourceKind: "directory",
  provider: "cloudflare",
  status: "published",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 1,
  publishedAt: 2,
  stoppedAt: null,
  lastError: null,
  thumbnail: null,
  ...overrides,
});

const render = (content: SharedContentResponse, options: { narrow?: boolean; disabled?: boolean } = {}): string =>
  renderToStaticMarkup(
    createElement(SharedContentThumbnail, {
      item: content,
      narrow: options.narrow ?? false,
      disabled: options.disabled ?? false,
      onOpen: () => {},
      onDropFiles: () => {},
    }),
  );

test("未設定: 画像を出さず、設定の入口になるボタンを置く", () => {
  const html = render(item());
  assert.ok(html.startsWith("<button"));
  assert.ok(html.includes('aria-label="dist のサムネイルを設定"'));
  assert.ok(html.includes("画像を設定"));
  assert.equal(html.includes("<img"), false);
});

test("設定済み: 版付き URL の画像を出し、押すと変更の入口になる", () => {
  const html = render(item({ thumbnail: { updatedAt: 1_700_000_000_000, width: 800, height: 500, bytes: 1000 } }));
  assert.ok(html.includes('aria-label="dist のサムネイルを変更"'));
  assert.ok(html.includes(`src="/api/shared-contents/abc123/thumbnail?v=1700000000000"`));
  assert.ok(html.includes('width="800"'));
  assert.ok(html.includes('height="500"'));
  // 一覧の画像は遅延読み込みにして、行が増えても初回の取得を重くしない
  assert.ok(html.includes('loading="lazy"'));
});

test("一括停止の実行中は押せない（未設定の入口も含む）", () => {
  assert.ok(render(item(), { disabled: true }).includes("disabled"));
  const withThumbnail = render(item({ thumbnail: { updatedAt: 5, width: 800, height: 500, bytes: 10 } }), {
    disabled: true,
  });
  assert.ok(withThumbnail.includes("disabled"));
});

test("狭い面では枠を小さくする（クラスだけが変わり、中身は同じ）", () => {
  const narrow = render(item(), { narrow: true });
  assert.ok(narrow.includes("w-20"));
  assert.equal(render(item()).includes("w-20"), false);
});
