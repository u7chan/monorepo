// 設定 → コンテンツ生成のページ描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 見出し・本文の出し分け・この画面だけの再読み込みを固定する (本文の詳細は contentSettingsTab.test.ts)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ContentSettings } from "../src/hooks/useContentSettings";
import { CONTENT_SETTINGS_NOTE } from "../src/lib/contentSettings";
import type { ContentSettingsResponse } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ContentSettingsView } = await import("../src/components/ContentSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const CONTENT_SETTINGS: ContentSettingsResponse = {
  configured: true,
  provider: "openrouter",
  runtimeAvailable: true,
  image: {
    model: "openai/gpt-image-2",
    models: [
      { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
      { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
    ],
    catalogSource: "live",
    fetchedAt: null,
  },
  speech: {
    model: "google/gemini-3.8-flash-tts",
    voice: "Zephyr",
    models: [
      {
        provider: "openrouter",
        id: "google/gemini-3.8-flash-tts",
        name: "Google: Gemini 3.8 Flash TTS",
        voices: ["Zephyr", "Kore"],
      },
    ],
    catalogSource: "live",
    fetchedAt: null,
  },
};

function contentSettings(overrides: Partial<ContentSettings> = {}): ContentSettings {
  return {
    settings: CONTENT_SETTINGS,
    note: { text: CONTENT_SETTINGS_NOTE, error: false },
    saving: null,
    reloading: false,
    reload: async () => {},
    saveKey: async () => true,
    removeKey: async () => true,
    saveSelection: async () => true,
    saveSpeech: async () => true,
    refreshCatalog: async () => true,
    refreshSpeechCatalog: async () => true,
    speechSynced: true,
    ...overrides,
  };
}

function render(settings: ContentSettings): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ContentSettingsView, { contentSettings: settings, onBack: () => {} }),
    ),
  );
}

test("ページはコンテンツ生成の見出しと本文を出し、モデルのタブ行を持たない", () => {
  const html = render(contentSettings());
  assert.ok(html.includes("CONTENT"), "eyebrow は CONTENT");
  assert.ok(html.includes("コンテンツ生成"), "セクション名を見出しに出す");
  assert.equal(html.includes('role="tablist"'), false, "ルートのセクションなのでタブ行は出さない");
  assert.ok(html.includes('type="password"'), "APIキーの入力を出す");
  assert.equal(html.includes("モデル候補を保存"), false, "モデルの保存バーは出さない");
});

test("取得前はこの画面の注記と再読み込みの導線を出し、取得中は無効にする", () => {
  const html = render(contentSettings({ settings: null }));
  assert.ok(html.includes("コンテンツ生成の設定"), "取得前の見出しを出す");
  assert.ok(html.includes(CONTENT_SETTINGS_NOTE), "hook の注記をそのまま見せる");
  assert.ok(html.includes("再読み込み"), "この画面の再読み込みを出す");

  const reloading = render(contentSettings({ reloading: true }));
  assert.match(reloading, /<button[^>]*disabled=""[^>]*>.*再読み込み.*<\/button>/s, "取得中は押せない");
});

test("取得に失敗したときは、この画面の理由をそのまま出す", () => {
  const html = render(
    contentSettings({
      settings: null,
      note: { text: "コンテンツ生成の設定を読み込めませんでした。接続できません", error: true },
    }),
  );
  assert.ok(html.includes("コンテンツ生成の設定を読み込めませんでした。接続できません"));
});
