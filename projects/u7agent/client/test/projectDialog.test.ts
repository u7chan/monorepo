// プロジェクト追加の専用ダイアログ。ヘッダーの閉じる (X) とフッターの並びを静的描画で固定する。
// 初期焦点・Escape・タップ領域はブラウザーで確認する (docs/testing.md)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ProjectDialog } = await import("../src/components/ProjectDialog");

function render(): string {
  return renderToStaticMarkup(createElement(ProjectDialog, { onClose: () => {}, onCreate: async () => {} }));
}

/** ヘッダーの閉じる。文字を持たないので読み上げ名で引く */
function closeButtonTag(html: string): string {
  const tag = html.match(/<button[^>]*aria-label="閉じる"[^>]*>/)?.[0];
  assert.ok(tag, "ヘッダーの閉じるが無い");
  return tag;
}

test("ヘッダーは X だけで閉じ、文字ラベルを置かない", () => {
  const html = render();
  assert.ok(closeButtonTag(html).includes('title="閉じる"'), "hover の補助が無い");
  assert.equal(html.includes(">閉じる<"), false, "ヘッダーに閉じるの文字を置かない");
});

test("フッターは注記を上、キャンセルと作成を下の右寄せに置く", () => {
  const html = render();
  const footer = html.slice(html.indexOf("<footer"));
  const note = footer.indexOf("登録はサーバーに保存され");
  const cancel = footer.indexOf(">キャンセル<");
  const create = footer.indexOf(">作成<");
  assert.ok(note >= 0 && cancel >= 0 && create >= 0, "注記とボタンが揃っていない");
  assert.ok(note < cancel, "注記がボタン行より後にある");
  assert.ok(cancel < create, "主操作がキャンセルの左にある");
});
