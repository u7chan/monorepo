// 引っ越しの専用ダイアログ。候補の一覧と確定の可否は純関数では固定できないため SSR で描画して検査する
// (送信の直列化・失敗表示・焦点はブラウザの受入で確認する)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SessionMoveDialog } from "../src/components/SessionMoveDialog";
import type { Space } from "server";
import { sessionMoveDialogText } from "../src/lib/sidebarRowMenu";

const normal: Space = { id: "default", name: "通常", createdAt: 0 };
const demo: Space = { id: "space-1111111111111111", name: "デモ", createdAt: 1 };

function render(destinations: Space[]): string {
  return renderToStaticMarkup(
    createElement(SessionMoveDialog, {
      text: sessionMoveDialogText("決済画面の検証"),
      destinations,
      onClose: () => {},
      onMove: async () => {},
    }),
  );
}

/** 確定ボタン。取り消しと区別するため submit で引く */
function submitButton(html: string): string {
  const match = /<button[^>]*type="submit"[^>]*>/.exec(html);
  assert.ok(match, "確定ボタンが無い");
  return match[0];
}

test("移動先の候補と対象を並べ、確定を押せる状態で出す", () => {
  const html = render([normal, demo]);
  assert.ok(html.includes('aria-label="別のスペースへ引っ越す"'), "見出しが読み上げ名になっていない");
  assert.ok(html.includes("決済画面の検証"), "対象のタイトルが出ていない");
  assert.ok(html.includes("通常") && html.includes("デモ"), "移動先の候補が出ていない");
  assert.ok(html.includes("会話履歴") && html.includes("破棄"), "履歴が破棄されることが出ていない");
  assert.ok(html.includes("引き継がれます"), "ファイルの引き継ぎが出ていない");
  assert.ok(!submitButton(html).includes("disabled"), "候補があるのに確定が無効になっている");
  assert.match(html, /<button[^>]*type="submit"[^>]*>引っ越す<\/button>/, "確定の名前が違う");
});

test("候補が 0 件のときは案内を出し、確定を無効にする", () => {
  const html = render([]);
  assert.ok(html.includes("移動先のスペースがありません"), "候補 0 件の案内が無い");
  assert.ok(html.includes("設定 → スペース"), "作成先の導線が無い");
  assert.ok(submitButton(html).includes("disabled"), "候補 0 件で確定を押せてしまう");
});
