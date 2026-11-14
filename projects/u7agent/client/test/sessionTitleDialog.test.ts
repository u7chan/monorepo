// AI要約のダイアログ。閲覧型の閉じる導線 (ヘッダーの X だけ) と、フッターの並びを静的描画で固定する。
// 初期焦点・Escape・タップ領域はブラウザーで確認する (docs/testing.md)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SpaceContextValue } from "../src/SpaceContext";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");
const { SessionTitleDialog } = await import("../src/components/SessionTitleDialog");
const { SpaceContext } = await import("../src/SpaceContext");

// 再要約の設定取得は effect で走るので SSR では呼ばれない。API は押したときだけ使う
const space = { api: {} as SpaceContextValue["api"] } as SpaceContextValue;

function render(): string {
  return renderToStaticMarkup(
    createElement(
      SpaceContext.Provider,
      { value: space },
      createElement(
        ConfirmProvider,
        null,
        createElement(SessionTitleDialog, {
          sessionId: "s1",
          title: "決済画面の検証",
          onClose: () => {},
          onOpenSettings: () => {},
          onUpdated: () => {},
        }),
      ),
    ),
  );
}

test("閉じる導線はヘッダーの X だけにする", () => {
  const html = render();
  assert.match(html, /<button[^>]*aria-label="閉じる"[^>]*>/);
  assert.ok(html.includes('title="閉じる"'), "hover の補助が無い");
  assert.equal(html.includes(">閉じる<"), false, "文字ラベルの閉じるを置かない");
  assert.equal((html.match(/aria-label="閉じる"/g) ?? []).length, 1, "閉じる導線が 2 つある");
});

test("フッターは補助リンクを左、再要約を右に置く", () => {
  const html = render();
  const footer = html.slice(html.indexOf("<footer"));
  const settings = footer.indexOf(">設定を開く<");
  const resummarize = footer.indexOf(">再要約<");
  assert.ok(settings >= 0 && resummarize >= 0, "フッターの操作が揃っていない");
  assert.ok(settings < resummarize, "補助リンクが主操作より右にある");
  assert.equal(footer.includes(">キャンセル<"), false, "閲覧型のフッターにキャンセルを置かない");
});
