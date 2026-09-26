// 設定 → モデルの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// provider 行・キー入力・削除・再同期・未設定の畳み・ランタイム不可の警告が出ることを固定する
// (状態遷移と保存の文言は lib/modelSettings の純関数テストが担う)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ModelSettings } from "../src/hooks/useModelSettings";
import { MODEL_SETTINGS_NOTE } from "../src/lib/modelSettings";
import type {
  ModelsSettingsResponse,
  ModelMutationResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
} from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ModelSettingsPage, ModelSettingsView } = await import("../src/components/ModelSettingsPage");

function provider(overrides: Partial<ProviderAuthSetting> = {}): ProviderAuthSetting {
  return {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: false, environmentVariables: [] },
    managed: false,
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
    ...overrides,
  };
}

const CATALOG: RuntimeModelsResponse = {
  whitelistConfigured: false,
  catalogCount: 2,
  whitelistCount: 2,
  availableCount: 1,
  versions: { piCodingAgent: "0.87.1" },
  providers: [
    {
      provider: "anthropic",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet", available: true, inWhitelist: true },
        { id: "claude-haiku", name: "Claude Haiku", available: false, inWhitelist: true },
      ],
    },
  ],
};

const SETTINGS: ModelsSettingsResponse = {
  runtimeAvailable: true,
  whitelistConfigured: true,
  defaultModel: "anthropic/claude-sonnet",
  providers: [
    provider({ auth: { configured: true, source: "environment", environmentVariables: ["ANTHROPIC_API_KEY"] } }),
    provider({ provider: "openai", name: "OpenAI", canSetApiKey: false, supportsOAuth: true }),
    provider({ provider: "local", name: "Local" }),
    provider({ provider: "ghost", name: "ghost", managed: true, canSetApiKey: false, orphan: true }),
    provider({
      provider: "stale",
      name: "Stale",
      managed: true,
      degraded: "apply",
      auth: { configured: true, source: "runtime", environmentVariables: [] },
    }),
  ],
};

function modelSettings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    settings: SETTINGS,
    catalog: CATALOG,
    catalogError: null,
    note: { text: MODEL_SETTINGS_NOTE, error: false },
    saving: null,
    reloading: false,
    reload: async () => {},
    save: async () => true,
    remove: async () => true,
    resync: async () => true,
    ...overrides,
  };
}

function render(settings: ModelSettings): string {
  return renderToStaticMarkup(createElement(ModelSettingsView, { modelSettings: settings, onBack: () => {} }));
}

test("provider 行に認証バッジ・キー入力・削除・再同期・モデル数を出す", () => {
  const html = render(modelSettings());
  assert.ok(html.includes("モデル</h2>"), "タイトルを出す");
  assert.ok(html.includes("Anthropic") && html.includes("anthropic"), "表示名と provider id を出す");
  assert.ok(html.includes("環境変数（ANTHROPIC_API_KEY）"), "実効の認証ソースを出す");
  assert.ok(html.includes("利用可能 1 / カタログ 2"), "カタログから数えたモデル数を出す");
  assert.ok(html.includes('type="password"'), "キー入力はマスクする");
  assert.ok(html.includes("保存"), "保存ボタンを出す");
  assert.ok(html.includes("削除"), "managed の provider には削除を出す");
  assert.ok(html.includes("保存済み（未反映）") && html.includes("再同期"), "degraded には再同期を出す");
  assert.ok(html.includes("カタログ外（保存済み）"), "orphan を警告として出す");
  assert.ok(html.includes("カタログに戻るまで再登録はできません"), "orphan の保存行は削除だけできると書く");
  assert.ok(html.includes("未設定のプロバイダーを表示 (2)"), "未設定は畳んで件数だけ出す");
  assert.ok(html.includes("PI_MODELS"), "whitelist の注記を出す");
  assert.ok(html.includes("アプリ既定モデル"), "既定モデルを出す");
  assert.ok(html.includes("キーの有効性は保存時に確認しません"), "有効性を検証しない旨を出す");
});

test("カタログ外で未反映の行は再同期ボタンを出さず、削除とカタログ復帰を案内する", () => {
  const html = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({
            provider: "ghost",
            name: "Ghost",
            managed: true,
            canSetApiKey: false,
            orphan: true,
            degraded: "apply",
          }),
        ],
      },
      catalog: null,
    }),
  );
  assert.ok(html.includes("保存済み（未反映）"), "未反映として警告する");
  assert.ok(
    html.includes("カタログに戻ってから登録し直してください"),
    "実行できない再同期ではなく削除と復帰を案内する",
  );
  assert.ok(html.includes("削除"), "managed なので削除は出る");
  assert.equal(html.includes("再同期"), false, "resync API が 400 になるカードに再同期ボタンを出さない");
});

test("キー登録できない provider は入力欄を出さず、理由を書く", () => {
  const html = render(
    modelSettings({
      settings: { ...SETTINGS, providers: [provider({ provider: "local", name: "Local", canSetApiKey: false })] },
    }),
  );
  assert.ok(html.includes("この画面からは登録できません"));
  // 設定済みとして先頭に出るので、入力欄は 1 つも無い
  assert.equal(html.includes('type="password"'), false);
});

test("ランタイム不可のときは警告を出し、カタログ失敗も独立して出す", () => {
  const html = render(
    modelSettings({
      settings: { ...SETTINGS, runtimeAvailable: false },
      catalog: null,
      catalogError: "ランタイムのモデル情報を取得できません",
    }),
  );
  assert.ok(html.includes("APIキーの登録・削除はできません"), "変更できないことを先に伝える");
  assert.ok(html.includes("モデル一覧を取得できませんでした"), "カタログの失敗を独立して出す");
});

test("ページ本体は取得前の初期状態 (読み込み中) を出す", () => {
  // hook が取得を始めるのは mount 後なので、react-dom/server の初期描画は読み込み中になる
  const html = renderToStaticMarkup(
    createElement(ModelSettingsPage, { onRefreshHealth: async () => null, onBack: () => {} }),
  );
  assert.ok(html.includes("プロバイダーの認証状態を読み込んでいます。"));
  assert.ok(html.includes("ランタイムが利用できないため") === false, "取得前に警告を出さない");
});

test("読み込み中の状態を出す", () => {
  const html = render(
    modelSettings({
      settings: null,
      note: { text: "プロバイダーの認証状態を読み込んでいます。", error: false },
    }),
  );
  assert.ok(html.includes("プロバイダーの認証状態を読み込んでいます。"));
  assert.ok(html.includes("再読み込み"));
});

test("保存の警告 (applied_unsynced) は注記として出る", () => {
  const response: ModelMutationResponse = { ...SETTINGS, state: "applied_unsynced" };
  const html = render(
    modelSettings({
      settings: response,
      note: { text: "APIキーを保存しましたが、実行中のランタイムへは未反映です。", error: true },
    }),
  );
  assert.ok(html.includes("実行中のランタイムへは未反映です"));
});
