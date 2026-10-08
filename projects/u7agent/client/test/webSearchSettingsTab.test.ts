// Web 検索タブの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 有効 / 無効の出し分け、provider の選択、キー行と外部送信の注記を固定する。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import { WebSearchSettingsTab } from "../src/components/model-settings/WebSearchSettingsTab";
import type { WebSearchSavingAction } from "../src/lib/webSearchSettings";
import type { WebSearchProvider, WebSearchSettingsResponse } from "../src/types";

/** API が返す文言（正は server/src/web-search-tool.ts）。画面は受け取った文字列をそのまま出す */
const WEB_SEARCH_DISABLED_MESSAGE =
  "Web 検索は無効化されています。有効にするには 設定 → モデル → Web 検索 を開いてください。";

const EXA: WebSearchProvider = { id: "exa", name: "Exa", host: "mcp.exa.ai", keyless: true, configured: true };
const TAVILY: WebSearchProvider = {
  id: "tavily",
  name: "Tavily",
  host: "api.tavily.com",
  keyless: false,
  configured: false,
};

function settings(overrides: Partial<WebSearchSettingsResponse> = {}): WebSearchSettingsResponse {
  return {
    enabled: true,
    provider: "exa",
    providers: [EXA, TAVILY],
    disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
    ...overrides,
  };
}

function render(value: WebSearchSettingsResponse, saving: WebSearchSavingAction | null = null): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(WebSearchSettingsTab, {
        settings: value,
        saving,
        onSetEnabled: async () => true,
        onSelectProvider: async () => true,
        onSaveKey: async () => true,
        onDeleteKey: async () => true,
      }),
    ),
  );
}

test("有効のときはスイッチが入り、固定文言は出さない", () => {
  const html = render(settings());
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.ok(html.includes(">有効<"), "有効のバッジを出す");
  assert.ok(html.includes("既定 Exa"), "既定 provider を出す");
  assert.ok(html.includes("mcp.exa.ai"), "送信先を出す");
  assert.ok(html.includes("キー不要"), "keyless のバッジを出す");
  assert.ok(html.includes("キー登録は不要です"));
  assert.equal(html.includes(WEB_SEARCH_DISABLED_MESSAGE), false, "有効の間は固定文言を出さない");
});

test("無効のときはスイッチが切り、モデルへ返る固定文言を出す", () => {
  const html = render(settings({ enabled: false }));
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  assert.ok(html.includes(">停止中<"), "停止中は warn のバッジで出す");
  assert.ok(html.includes(WEB_SEARCH_DISABLED_MESSAGE), "モデルへ返る文言をそのまま出す");
  assert.ok(html.includes("既存のセッション"), "既存の会話にも効くことを書く");
  assert.ok(html.includes("検索のクエリは Exa（mcp.exa.ai）へ送信されません"), "無効時は送らない旨に切り替える");
});

test("保存中はスイッチと provider の選択を押せなくする", () => {
  const html = render(settings(), "enabled");
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*\sdisabled=""/);
  assert.match(html, /<button[^>]*aria-label="既定の検索プロバイダー"[^>]*\sdisabled=""/);
  assert.equal(/\sdisabled=""/.test(render(settings())), false, "通常は押せる");
});

test("provider は選択肢を一覧に出し、選んだ時点で既定になる旨を書く", () => {
  const html = render(settings());
  assert.match(html, /<button[^>]*aria-haspopup="listbox"/);
  assert.equal((html.match(/role="option"/g) ?? []).length, 2, "一覧に 2 つ並べる");
  assert.ok(html.includes("キー不要（keyless の共有エンドポイント）"), "行の説明にキーの要否を出す");
  assert.ok(html.includes("APIキーが必要（平文で保存）"));
  assert.ok(html.includes("api.tavily.com"), "選択していない provider の送信先も一覧に出す");
  assert.ok(html.includes("選んだ時点で既定になり、保存されます。"));
  assert.ok(html.includes("他の provider へは自動で切り替えません"));
});

test("キー付きで未設定の provider では、キー入力と警告を出す", () => {
  const html = render(settings({ provider: "tavily" }));
  assert.ok(html.includes('type="password"'), "キー入力を出す");
  assert.match(html, /aria-label="Tavily のAPIキー"/);
  assert.equal(html.includes(">Tavily<"), true, "provider 名を出す");
  assert.ok(html.includes(">未設定<"), "キーのバッジを出す");
  assert.ok(html.includes("既定の Tavily のAPIキーが未設定です。"), "role=alert の警告文を出す");
  assert.match(html, /role="alert"[^>]*>既定の Tavily のAPIキーが未設定です。/);
  assert.ok(html.includes("8 文字以上で入力します"), "長さの下限を書く");
  assert.ok(html.includes("平文で保存"), "保存方式を隠さない");
  assert.equal(html.includes("キー登録は不要です"), false, "keyless の説明は出さない");
  assert.equal(html.includes("削除"), false, "未設定では削除ボタンを出さない");
  assert.ok(html.includes("クエリは既定の Tavily（api.tavily.com）へ送信され"), "送信先を選択に追随させる");
});

test("キー付きで設定済みの provider では、上書きと削除を出す", () => {
  const html = render(settings({ provider: "tavily", providers: [EXA, { ...TAVILY, configured: true }] }));
  assert.ok(html.includes(">設定済み<"));
  assert.ok(html.includes("上書き保存"));
  assert.ok(html.includes(">削除<"));
  assert.equal(html.includes("既定の Tavily のAPIキーが未設定です。"), false, "警告は出さない");
});

test("データの流れと、無効でもツールが残ることを既定で畳んで出す", () => {
  const html = render(settings());
  assert.match(
    html,
    /<summary[^>]*>[\s\S]*web_search ツールの実行時にだけ、クエリは Exa（mcp.exa.ai）へ送信されます。[\s\S]*<\/summary>/,
    "畳んだ 1 行に送信先を出す",
  );
  assert.equal(html.includes("<details open"), false, "既定は畳む");
  assert.ok(html.includes("web_search ツールを実行したときだけ"), "実行したときだけ送ることを書く");
  assert.ok(html.includes("モデル（LLM プロバイダー）へ渡ります"));
  assert.ok(html.includes("BFF をインターネットや LAN へ公開しないでください"));
  assert.ok(html.includes("ツール一覧に残り"), "ツールを消さない理由を書く");
  assert.ok(html.includes("Web 検索の設定はサーバーに保存され、再起動後も残ります。"));
});
