// 設定 → Web 検索のページ描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 見出し・本文の出し分け・この画面だけの再読み込みを固定する (本文の詳細は webSearchSettingsTab.test.ts)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { WebSearchSettings } from "../src/hooks/useWebSearchSettings";
import { WEB_SEARCH_SETTINGS_NOTE } from "../src/lib/webSearchSettings";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { WebSearchSettingsView } = await import("../src/components/WebSearchSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

/** API が返す文言（正は server/src/web-search-tool.ts）。画面は受け取った文字列をそのまま出す */
const WEB_SEARCH_DISABLED_MESSAGE = "Web 検索は無効化されています。有効にするには 設定 → Web 検索 を開いてください。";

function webSearchSettings(overrides: Partial<WebSearchSettings> = {}): WebSearchSettings {
  return {
    settings: {
      enabled: true,
      provider: "exa",
      providers: [
        { id: "exa", name: "Exa", host: "mcp.exa.ai", keyless: true, configured: true },
        { id: "tavily", name: "Tavily", host: "api.tavily.com", keyless: false, configured: false },
      ],
      disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
    },
    note: { text: WEB_SEARCH_SETTINGS_NOTE, error: false },
    saving: null,
    reloading: false,
    reload: async () => {},
    setEnabled: async () => true,
    setProvider: async () => true,
    saveKey: async () => true,
    removeKey: async () => true,
    ...overrides,
  };
}

function render(settings: WebSearchSettings): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(WebSearchSettingsView, { webSearchSettings: settings, onBack: () => {} }),
    ),
  );
}

test("ページは Web 検索の見出しと実行時トグルの状態を出し、モデルのタブ行を持たない", () => {
  const html = render(webSearchSettings());
  assert.ok(html.includes("WEB SEARCH"), "eyebrow は WEB SEARCH");
  assert.equal(html.includes('role="tablist"'), false, "ルートのセクションなのでタブ行は出さない");
  assert.ok(html.includes('role="switch"'), "有効 / 無効のスイッチを出す");
  assert.ok(html.includes("mcp.exa.ai"), "送信先のホストを出す");
  assert.ok(html.includes("キー登録は不要です"), "keyless であることを書く");
  assert.ok(html.includes("web_search ツールを実行したときだけ"), "実行したときだけ送ることを書く");
  assert.equal(html.includes("モデル候補を保存"), false, "モデルの保存バーは出さない");
});

test("取得前はこの画面の注記と再読み込みの導線を出し、スイッチは出さない", () => {
  const html = render(webSearchSettings({ settings: null }));
  assert.ok(html.includes("Web 検索の設定"), "取得前の見出しを出す");
  assert.ok(html.includes(WEB_SEARCH_SETTINGS_NOTE), "hook の注記をそのまま見せる");
  assert.ok(html.includes("再読み込み"), "この画面の再読み込みを出す");
  assert.equal(html.includes('role="switch"'), false, "取得前はスイッチを出さない");

  const reloading = render(webSearchSettings({ reloading: true }));
  assert.match(reloading, /<button[^>]*disabled=""[^>]*>.*再読み込み.*<\/button>/s, "取得中は押せない");
});

test("無効のときは、ツールが返す固定文言をそのまま出す", () => {
  const html = render(
    webSearchSettings({
      settings: { ...webSearchSettings().settings!, enabled: false },
    }),
  );
  assert.ok(html.includes(WEB_SEARCH_DISABLED_MESSAGE));
  assert.ok(html.includes("設定 → Web 検索"), "案内はルートのセクション名までにする");
});
