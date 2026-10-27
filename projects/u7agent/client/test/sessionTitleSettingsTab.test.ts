// 会話タイトルタブの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 定義 → 動作確認の順、短い注記、動作確認の結果 (成功 / 失敗) とコピーの出し分けを固定する。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SessionTitleSettingsTab } from "../src/components/session-title-settings/SessionTitleSettingsTab";
import type { TitleSummarySettingsResponse, TitleSummaryTestResponse } from "../src/types";

const MODEL = { provider: "stub", id: "stub-model", name: "Stub Model", thinkingLevels: ["off", "low"] as const };

function settings(overrides: Partial<TitleSummarySettingsResponse> = {}): TitleSummarySettingsResponse {
  return {
    enabled: true,
    model: "stub/stub-model",
    thinkingLevel: "low",
    effectiveThinkingLevel: "low",
    definition: "定義の本文",
    defaultDefinition: "既定の定義",
    models: [{ ...MODEL, thinkingLevels: [...MODEL.thinkingLevels] }],
    modelAvailable: true,
    ...overrides,
  };
}

function render(
  value: TitleSummarySettingsResponse = settings(),
  testResult: TitleSummaryTestResponse | null = null,
): string {
  return renderToStaticMarkup(
    createElement(SessionTitleSettingsTab, {
      settings: value,
      saving: null,
      onSetEnabled: async () => true,
      onSelectModel: async () => true,
      onSelectEffort: async () => true,
      onSaveDefinition: async () => true,
      onResetDefinition: async () => true,
      testing: false,
      testResult,
      onTest: () => {},
    }),
  );
}

test("定義は動作確認より前に置き、注記は短いラベルにする", () => {
  const html = render();
  const definition = html.indexOf("要約の定義");
  const test = html.indexOf(">動作確認<");
  assert.ok(definition >= 0 && test >= 0);
  assert.ok(definition < test, "定義を確認してから試せる順にする");
  assert.ok(html.includes("送信先は要約モデルのプロバイダー（本会話とは別）"));
  assert.ok(html.includes("自動実行は会話ごとに 1 回だけ（失敗しても再試行しない）"));
  assert.equal(html.includes("本会話のモデルとは独立しています"), false, "長い注記は残さない");
});

test("動作確認の成功は、状態の 1 行とタイトルのパネルで出し、コピーできる", () => {
  const html = render(settings(), {
    ok: true,
    title: "エラー表示の改善",
    model: "stub/stub-model",
    thinkingLevel: "low",
    inputTokens: 31,
    outputTokens: 9,
    costTotal: 0.0002,
    durationMs: 1400,
  });
  assert.ok(html.includes(">成功<"));
  assert.ok(html.includes(">Stub Model<"), "モデルをチップで出す");
  assert.ok(html.includes(">Effort Low<"), "Effort はラベル付きで出す");
  assert.ok(html.includes("入力 31 / 出力 9"));
  assert.ok(html.includes("1.4 秒"));
  assert.ok(html.includes("エラー表示の改善"));
  assert.ok(html.includes('aria-label="タイトルをコピー"'), "生成したタイトルをコピーできる");
  assert.ok(html.includes(">title<"), "出力パネルの見出し");
});

test("動作確認の失敗は、理由を出してコピーは出さない", () => {
  const html = render(settings(), { ok: false, error: "rate limited", durationMs: 300 });
  assert.ok(html.includes(">失敗<"));
  assert.ok(html.includes("rate limited"));
  assert.equal(html.includes('aria-label="タイトルをコピー"'), false, "生成できていないのでコピーしない");
});

test("Off とモデル未選択では動作確認の理由を出す", () => {
  assert.ok(render(settings({ enabled: false })).includes("AI要約を On にすると動作確認できます。"));
  assert.ok(render(settings({ model: null })).includes("要約モデルを選ぶと動作確認できます。"));
});
