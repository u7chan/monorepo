// Web 検索タブの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 有効 / 無効の出し分けと、provider と外部送信の注記を固定する。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { WebSearchSettingsTab } from "../src/components/model-settings/WebSearchSettingsTab";

/** API が返す文言（正は server/src/web-search-tool.ts）。画面は受け取った文字列をそのまま出す */
const WEB_SEARCH_DISABLED_MESSAGE =
  "Web 検索は無効化されています。有効にするには 設定 → モデル → Web 検索 を開いてください。";

function render(enabled: boolean, saving = false): string {
  return renderToStaticMarkup(
    createElement(WebSearchSettingsTab, {
      settings: { enabled, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE },
      saving,
      onChange: () => {},
    }),
  );
}

test("有効のときはスイッチが入り、固定文言は出さない", () => {
  const html = render(true);
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.ok(html.includes(">有効<"), "有効のバッジを出す");
  assert.ok(html.includes(">Exa<"), "使っている provider を出す");
  assert.ok(html.includes("mcp.exa.ai"), "送信先を出す");
  assert.ok(html.includes("キー不要"));
  assert.equal(html.includes(WEB_SEARCH_DISABLED_MESSAGE), false, "有効の間は固定文言を出さない");
});

test("無効のときはスイッチが切り、モデルへ返る固定文言を出す", () => {
  const html = render(false);
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  assert.ok(html.includes(">停止中<"), "停止中は warn のバッジで出す");
  assert.ok(html.includes(WEB_SEARCH_DISABLED_MESSAGE), "モデルへ返る文言をそのまま出す");
  assert.ok(html.includes("既存のセッション"), "既存の会話にも効くことを書く");
});

test("保存中はスイッチを押せなくする", () => {
  assert.match(render(true, true), /role="switch"[^>]*aria-checked="true"[^>]*\sdisabled=""/);
  assert.equal(/\sdisabled=""/.test(render(true)), false, "通常は押せる");
});

test("データの流れと、無効でもツールが残ることを常時出す", () => {
  const html = render(true);
  assert.ok(html.includes("web_search ツールを実行したときだけ"), "実行したときだけ送ることを書く");
  assert.ok(html.includes("モデル（LLM プロバイダー）へ渡ります"));
  assert.ok(html.includes("BFF をインターネットや LAN へ公開しないでください"));
  assert.ok(html.includes("ツール一覧に残り"), "ツールを消さない理由を書く");
  assert.ok(html.includes("#1776"), "provider の切り替えが別 Issue であることを書く");
});
