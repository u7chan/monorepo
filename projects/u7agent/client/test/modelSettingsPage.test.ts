import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ModelSettings } from "../src/hooks/useModelSettings";
import { MODEL_SETTINGS_NOTE, UNSET_DEFAULT_MODEL_LABEL } from "../src/lib/modelSettings";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import type { ModelsSubsection } from "../src/lib/settingsNav";
import type {
  CustomProviderSummary,
  ModelsSettingsResponse,
  ModelMutationResponse,
  OAuthLoginState,
  ProviderAuthSetting,
  RuntimeModelsResponse,
  SessionSummary,
} from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ModelSettingsPage, ModelSettingsView } = await import("../src/components/ModelSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

function provider(overrides: Partial<ProviderAuthSetting> = {}): ProviderAuthSetting {
  return {
    provider: "anthropic",
    name: "Anthropic",
    auth: { configured: false, environmentVariables: [] },
    managed: false,
    keyUpdatedAt: null,
    keyAvailable: false,
    keyEvaluated: true,
    keyErrorMessage: null,
    canSetApiKey: true,
    supportsOAuth: false,
    credentialKind: null,
    oauthLoginLabel: null,
    hiddenStoredOAuth: false,
    orphan: false,
    login: null,
    memo: null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    title: "title",
    agentId: "agent-zundamon",
    status: "idle",
    queueDepth: 0,
    messageCount: 0,
    createdAt: 1,
    lastUsedAt: 2,
    pinned: false,
    serveCommand: null,
    ...overrides,
  };
}

const CATALOG: RuntimeModelsResponse = {
  catalogCount: 3,
  availableCount: 1,
  versions: { piCodingAgent: "0.87.1" },
  providers: [
    {
      provider: "anthropic",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet", available: true },
        { id: "claude-haiku", name: "Claude Haiku", available: false },
      ],
    },
    {
      provider: "local",
      auth: { configured: false, environmentVariables: [] },
      models: [{ id: "local-a", name: "Local A", available: false }],
    },
  ],
};

const SETTINGS: ModelsSettingsResponse = {
  runtimeAvailable: true,
  allowedModels: ["anthropic/claude-sonnet"],
  defaultModel: null,
  ignoredEnvironmentVariables: [],
  customProviders: [],
  providers: [
    provider({ auth: { configured: true, source: "environment", environmentVariables: ["ANTHROPIC_API_KEY"] } }),
    provider({ provider: "openai", name: "OpenAI", canSetApiKey: false, supportsOAuth: true, canSignInHere: true }),
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
    savingAvailability: false,
    reloading: false,
    refreshing: false,
    reload: async () => {},
    refreshCatalog: async () => {},
    save: async () => true,
    saveMemo: async () => true,
    saveAvailability: async () => SETTINGS,
    remove: async () => true,
    resync: async () => true,
    createCustom: async () => true,
    updateCustom: async () => true,
    removeCustom: async () => true,
    probeCustom: async () => ({
      checkedAt: 0,
      baseUrl: "",
      failure: null,
      httpStatus: null,
      models: [],
      truncated: false,
      message: null,
    }),
    startLogin: async () => true,
    submitLoginCode: async () => true,
    cancelLogin: async () => true,
    signOut: async () => true,
    ...overrides,
  };
}

function render(
  settings: ModelSettings,
  options: {
    modelsSubsection?: ModelsSubsection;
    sessions?: SessionSummary[];
    sessionsLoaded?: boolean;
    onSelectModelsSubsection?: (subsection: ModelsSubsection) => void;
    singleColumn?: boolean;
  } = {},
): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ModelSettingsView, {
        modelSettings: settings,
        sessions: options.sessions ?? [],
        sessionsLoaded: options.sessionsLoaded ?? false,
        modelsSubsection: options.modelsSubsection ?? "models",
        onSelectModelsSubsection: options.onSelectModelsSubsection ?? (() => {}),
        singleColumn: options.singleColumn,
        onBack: () => {},
      }),
    ),
  );
}

test("タブ行は URL が決めるタブを示し、2 つのタブを出す", () => {
  const html = render(modelSettings());
  assert.ok(html.includes('role="tablist"'), "タブ行を出す");
  assert.ok(html.includes('aria-label="モデルの設定"'), "タブ行のラベルを渡す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2, "タブは 2 つ");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>モデルを選ぶ</, "既定は「モデルを選ぶ」");
  assert.ok(html.includes("プロバイダー"));
  assert.equal(html.includes("コンテンツ生成"), false, "独立したセクションはタブに出さない");
  assert.equal(html.includes("Web 検索"), false, "独立したセクションはタブに出さない");
  // タブの切替は URL 経由で親へ渡す
  const calls: ModelsSubsection[] = [];
  render(modelSettings(), { onSelectModelsSubsection: (subsection) => calls.push(subsection) });
  assert.deepEqual(calls, [], "描画だけでは切替を要求しない");

  const providersHtml = render(modelSettings(), { modelsSubsection: "providers" });
  assert.match(providersHtml, /<button[^>]*aria-selected="true"[^>]*>プロバイダー</);
  assert.equal(providersHtml.includes("モデル候補を保存"), false, "プロバイダータブに候補の保存バーは出さない");
  assert.ok(providersHtml.includes("provider 名 / ID で絞り込み"));
  assert.ok(providersHtml.includes('fill-rule="evenodd"'), "ロゴのある provider は一覧にロゴを出す");
  assert.ok(providersHtml.includes(">L<"), "ロゴの無い provider は頭文字を出す");
});

test("singleColumn のプロバイダー詳細は一覧を畳んでキー入力を表示する", () => {
  const html = render(modelSettings(), { modelsSubsection: "providers", singleColumn: true });
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>.*プロバイダーを変更.*<\/button>/s);
  assert.ok(html.includes('type="password"'), "選択中の provider のキー欄を出す");
  assert.equal(html.includes('aria-label="プロバイダーを絞り込む"'), false, "一覧の検索は閉じている");
  assert.ok(html.includes("SQLite"), "キーの保存に関する警告を詳細に残す");

  const desktop = render(modelSettings(), { modelsSubsection: "providers" });
  assert.ok(desktop.includes('aria-label="プロバイダーを絞り込む"'), "desktop は一覧と詳細を同時に出す");
  assert.equal(desktop.includes("プロバイダーを変更"), false);
});

test("モデルを選ぶタブは既定モデル・選択数・候補・保存バーを出し、折りたたみは既定で閉じる", () => {
  const html = render(modelSettings());
  assert.ok(html.includes("既定モデル"), "既定モデルの見出しを出す");
  assert.ok(html.includes(UNSET_DEFAULT_MODEL_LABEL), "既定の未設定を残す");
  assert.ok(html.includes("選択 1 / 利用可能 1"), "選択数と利用可能数を出す");
  assert.ok(html.includes("チェックしたモデルだけが候補になります"));
  assert.ok(
    html.includes("Anthropic") && html.includes("利用可能 1/2 ・ 選択 1"),
    "provider 行に名前と a/b と選択数を出す",
  );
  assert.ok(html.includes('fill-rule="evenodd"'), "モデル候補の provider 行にもロゴを出す");
  assert.ok(html.includes("開いている会話のモデルは切り替えません"), "live の会話へ効かないことを注記する");
  assert.ok(html.includes("モデル一覧を表示") === false, "ModelTable は出さない");
  // 先頭の provider も含めて既定は閉じ、折りたたみ中は行を描画しない
  assert.equal((html.match(/<details[^>]*\sopen=""/g) ?? []).length, 0, "警告が無ければ既定で全部閉じる");
  assert.equal(html.includes("すべて解除"), false, "折りたたみ中の一括操作も描画しない");
  assert.equal(html.includes('title="anthropic/claude-sonnet"'), false, "折りたたみ中の行も描画しない");
  // 下部の固定アクション行は変更なしを示し、ボタンは無効
  assert.ok(html.includes("未保存の変更はありません"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*モデル候補を保存<\/button>/);
  assert.ok(html.includes("モデル候補を保存"));
});

test("既存の null（制限なし）は利用可能な全モデルを選択済みとして表示する", () => {
  const html = render(modelSettings({ settings: { ...SETTINGS, allowedModels: null } }));
  assert.ok(html.includes("選択 1 / 利用可能 1"));
  assert.ok(html.includes("利用可能 1/2 ・ 選択 1"), "展開した選択が provider 行の選択数に出る");
});

test("認証が設定されていない provider の選択は表示せず、下書きからも落とす", () => {
  const html = render(
    modelSettings({ settings: { ...SETTINGS, allowedModels: ["local/local-a"], defaultModel: "local/local-a" } }),
  );
  assert.equal(html.includes("Local A"), false, "未認証 provider の行は出さない");
  assert.equal(html.includes("認証が設定されていない provider"), false, "警告付きの未認証グループも出さない");
  assert.ok(html.includes("選択 0 / 利用可能 1"), "見えない選択は数えない (保存値に残っていても下書きから落とす)");
  assert.ok(html.includes(UNSET_DEFAULT_MODEL_LABEL), "未認証を指す既定も未設定へ戻す");
  assert.ok(html.includes("登録が無いプロバイダーに残った選択は候補に出さず"), "残った選択の扱いを注意書きに出す");
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*モデル候補を保存<\/button>/);
});

test("カタログ外の保存済みエントリは警告付きで残し、既定モデルの候補にも出す", () => {
  const html = render(
    modelSettings({
      settings: { ...SETTINGS, allowedModels: ["anthropic/ghost"], defaultModel: "anthropic/ghost" },
    }),
  );
  assert.ok(html.includes("現在のカタログに無いモデルが保存されています"));
  assert.ok(html.includes("Claude Sonnet"), "認証済み provider のカタログ全件は出す");
  assert.ok(html.includes("anthropic/ghost"), "カタログ外のエントリも出す");
  assert.ok(html.includes("選択 1 / 利用可能 1"));
  assert.ok(html.includes("すべて解除"), "外せる一括操作も出す");
  assert.equal(
    (html.match(/<details[^>]*\sopen=""/g) ?? []).length,
    1,
    "警告のある provider だけは対処できるように開く",
  );
});

test("選択 0 件は保存できず、空を送らない理由を出す", () => {
  const html = render(modelSettings({ settings: { ...SETTINGS, allowedModels: [], defaultModel: null } }));
  assert.ok(html.includes("選択したモデルが 0 件のため保存できません"));
  assert.ok(html.includes("空の選択は API で「制限なし（全モデル）」へ正規化される"));
  assert.ok(html.includes("「モデル候補」から 1 つ以上選ぶと既定モデルを選べます"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*モデル候補を保存<\/button>/);
});

test("カタログを取得できないときは候補を編集させず、保存もできない", () => {
  const html = render(modelSettings({ catalog: null, catalogError: "ランタイムのモデル情報を取得できません" }));
  assert.ok(html.includes("モデル一覧を取得できないため、モデル候補は編集できません"));
  assert.ok(html.includes("ランタイムのモデル情報を取得できません"));
  assert.equal(html.includes("モデル一覧を読み込んでいます"), false, "取得失敗と読み込み中を混同しない");
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*モデル候補を保存<\/button>/);
});

test("カタログの読み込み中は編集不可と出さず、保存も押せない", () => {
  const html = render(modelSettings({ catalog: null, catalogError: null }));
  assert.ok(html.includes("モデル一覧を読み込んでいます"));
  assert.equal(html.includes("モデル一覧を取得できないため"), false);
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*モデル候補を保存<\/button>/);
  assert.ok(html.includes("モデル一覧を読み込んでいます。"), "固定バーも読み込み中を示す");
});

test("無限に無視される環境変数を注記する", () => {
  const html = render(
    modelSettings({ settings: { ...SETTINGS, ignoredEnvironmentVariables: ["PI_MODELS", "PI_PROVIDER"] } }),
  );
  assert.ok(html.includes("PI_MODELS") && html.includes("PI_PROVIDER"), "無視する環境変数名を出す");
  assert.ok(html.includes("デプロイ設定からは削除"), "環境変数の削除を促す");
});

test("プロバイダータブは一覧と詳細を分け、キー暗号化の注意を既定で畳んで出す", () => {
  const html = render(modelSettings(), { modelsSubsection: "providers" });
  assert.ok(html.includes("設定済み 3") && html.includes("未設定 2"), "全件を設定済み / 未設定に分けて出す");
  for (const name of ["Anthropic", "OpenAI", "Local", "ghost", "Stale"]) {
    assert.ok(html.includes(name), `${name} を一覧に出す`);
  }
  assert.ok(html.includes("環境変数（ANTHROPIC_API_KEY）"), "詳細の認証バッジを出す");
  assert.ok(html.includes("利用可能 1 / カタログ 2"), "カタログから数えたモデル数を出す");
  assert.ok(html.includes('type="password"'), "キー入力はマスクする");
  assert.match(
    html,
    /<summary[^>]*>[\s\S]*キーは暗号化・メモは平文で保存されます。ログインがないため公開しないでください。[\s\S]*<\/summary>/,
    "畳んだ 1 行にキー・メモの保存と公開の注意を出す",
  );
  assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:[\s=>])/, "注意は既定で畳む");
  assert.ok(html.includes("BFF をインターネットや LAN へ公開しないでください"), "展開で公開しない注意を読める");
  assert.ok(html.includes("キーの有効性は保存時に確認しません"));
  assert.ok(html.includes("キーを保存して「モデルを選ぶ」タブに戻ると"));
  assert.ok(html.includes("各項目の保存ボタンでその場で保存されます"), "キー・メモは即時保存だと区別する");
  assert.ok(html.includes("「モデルを選ぶ」タブを開く"));
  assert.ok(html.includes("モデル一覧を表示") === false, "ModelTable は削除した");
});

const CUSTOM_PROVIDER: CustomProviderSummary = {
  id: "local-llm",
  name: "自宅のLLM",
  baseUrl: "http://192.0.2.10:11434/v1",
  api: "openai-completions",
  model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
  hasKey: true,
};

function customProviderRow(overrides: Partial<ProviderAuthSetting> = {}): ProviderAuthSetting {
  return provider({
    provider: CUSTOM_PROVIDER.id,
    name: CUSTOM_PROVIDER.name,
    custom: true,
    auth: { configured: true, source: "runtime", environmentVariables: [] },
    credentialKind: "api_key",
    ...overrides,
  });
}

test("カスタムプロバイダーは専用セクションに出し、通常の一覧と件数には混ぜない", () => {
  const html = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [...SETTINGS.providers, customProviderRow()],
        customProviders: [CUSTOM_PROVIDER],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes("カスタムプロバイダー"), "専用セクションの見出しを出す");
  assert.ok(html.includes("カスタムプロバイダーを追加"), "追加の導線を出す");
  assert.ok(html.includes("メモリのみ"), "オンメモリであることを一覧の行に出す");
  assert.ok(html.includes("qwen2.5-coder:7b"), "一覧の行にモデル ID を出す");
  assert.ok(html.includes("設定済み 3") && html.includes("未設定 2"), "件数にカスタムを含めない");
  // 既定の選択は通常の provider なので、通常の詳細（キー・メモ）を出す
  assert.ok(html.includes("メモ（キー本体は書かないでください）"), "通常の詳細はこれまでどおり");
  assert.equal(html.includes('aria-label="provider id"'), false, "カスタムを選ぶまではフォームを出さない");
});

test("カスタム注意は要点の 1 行だけを常時見せ、詳細は既定で畳む", () => {
  const html = render(modelSettings(), { modelsSubsection: "providers", singleColumn: false });
  const summary = html.indexOf("BFF のメモリにだけ保存されます");
  assert.ok(summary >= 0, "要点の 1 行を出す");
  // 要点は summary の中だけに置き、長い理由は同じ details の中へ入れて既定では閉じる
  assert.ok(html.lastIndexOf("<summary", summary) > html.lastIndexOf("</summary>", summary));
  const details = html.lastIndexOf("<details", summary);
  assert.ok(details >= 0 && html.indexOf("</details>", summary) > summary, "同じ details の中に置く");
  assert.ok(html.indexOf("同じ provider id とモデル id", details) > details);

  // singleColumn は一覧を畳んで詳細側に同じ注意を出すが、これも同じ形で畳む
  const single = render(
    modelSettings({
      settings: { ...SETTINGS, providers: [customProviderRow()], customProviders: [CUSTOM_PROVIDER] },
    }),
    { modelsSubsection: "providers", singleColumn: true },
  );
  const singleSummary = single.indexOf("BFF のメモリにだけ保存されます");
  assert.ok(singleSummary >= 0);
  assert.ok(single.lastIndexOf("<summary", singleSummary) > single.lastIndexOf("</summary>", singleSummary));
});

test("カスタム定義が無く通常 provider を選んでいても、専用セクションに注意を常時出す", () => {
  const html = render(modelSettings(), { modelsSubsection: "providers" });
  assert.ok(html.includes("カスタムプロバイダー"), "専用セクションは定義が無くても出す");
  assert.ok(html.includes("カスタムプロバイダーを追加"));
  assert.ok(html.includes("BFF のメモリにだけ保存されます"), "オンメモリであることを常時出す");
  assert.ok(html.includes("再起動すると定義とAPIキーは消えます"));
  assert.ok(html.includes("同じ provider id とモデル id で再登録すれば"), "再登録で選択が戻ることを出す");
  assert.ok(html.includes("アプリ既定モデルにカスタムモデルを指定している場合"));
  assert.ok(html.includes("Authorization: Bearer"), "キー必須 / ダミーの要点を出す");
  assert.ok(html.includes("信頼できる baseUrl"));
  // 通常 provider の詳細はこれまでどおり DB 保存の注意を持つ
  assert.ok(html.includes("キーは暗号化・メモは平文で保存されます"));
});

test("カスタムプロバイダーの詳細は専用フォームと注意を出し、通常のキー・メモ・再同期を出さない", () => {
  const html = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [customProviderRow()],
        customProviders: [CUSTOM_PROVIDER],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.equal(html.includes("設定済み "), false, "カスタムは通常の一覧（設定済み）に入れない");
  assert.equal(html.includes("未設定 "), false, "カスタムは通常の一覧（未設定）に入れない");
  // 注意書きは追加・編集のどちらでも読めるように常時出す
  assert.ok(html.includes("BFF のメモリにだけ保存されます"));
  assert.ok(html.includes("同じ provider id とモデル id"));
  assert.ok(html.includes("Authorization: Bearer"));
  assert.ok(html.includes("信頼できる baseUrl"));
  // 1 provider = 1 model のフォーム
  for (const label of ["provider id", "baseUrl", "APIキー", "モデル ID", "contextWindow", "maxTokens"]) {
    assert.ok(html.includes(`aria-label="${label}"`), `${label} の入力欄を出す`);
  }
  assert.ok(html.includes('aria-label="provider id"') && html.includes('readOnly=""'), "provider id は編集できない");
  assert.ok(html.includes("空欄なら既存のAPIキーを維持"), "キーの空欄は既存の維持だと示す");
  assert.ok(html.includes("実モデルの context window より大きくしないでください"));
  assert.ok(html.includes("表示名だけ"), "名前が表示用で、モデル ID に付かないことを出す");
  // 通常の認証・メモ・再同期・モデル導線は出さない
  assert.equal(html.includes("キーとメモは平文で保存されます"), false, "DB 保存の注意はカスタム詳細に出さない");
  assert.equal(html.includes("メモ（キー本体は書かないでください）"), false, "通常のメモ欄を出さない");
  assert.equal(html.includes("再同期"), false, "再同期を出さない");
  assert.equal(html.includes("サインイン"), false, "OAuth の操作を出さない");
  assert.equal(html.includes("「モデルを選ぶ」タブを開く"), false, "通常のモデル導線を出さない");

  // singleColumn では一覧を畳むため、同じ注意を詳細側に出して常時読めるようにする
  const single = render(
    modelSettings({
      settings: { ...SETTINGS, providers: [customProviderRow()], customProviders: [CUSTOM_PROVIDER] },
    }),
    { modelsSubsection: "providers", singleColumn: true },
  );
  assert.ok(single.includes("BFF のメモリにだけ保存されます"));
  assert.equal((single.match(/BFF のメモリにだけ保存されます/g) ?? []).length, 1, "一覧と詳細で二重に出さない");
});

test("プロバイダー詳細は保存済み認証の種別を出し、この画面のキーが OAuth を覆っているときだけ注記する", () => {
  const stored = provider({
    provider: "openai",
    name: "OpenAI",
    auth: { configured: true, source: "stored", environmentVariables: [] },
    credentialKind: "oauth",
    supportsOAuth: true,
    canSignInHere: true,
    oauthLoginLabel: "Sign in with ChatGPT",
  });
  const storedHtml = render(modelSettings({ settings: { ...SETTINGS, providers: [stored] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(
    storedHtml.includes("保存済み（auth.json）: Sign in with ChatGPT"),
    "保存済み OAuth は provider の表示名で区別する",
  );
  assert.equal(storedHtml.includes("は使われていません"), false, "実効ならキーの削除を促す注記は出さない");

  // この画面のキーが保存済み OAuth を覆っているときだけ、削除を促す注記を出す
  const coveredHtml = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({
            provider: "openai",
            name: "OpenAI",
            managed: true,
            auth: { configured: true, source: "runtime", environmentVariables: [] },
            credentialKind: "api_key",
            supportsOAuth: true,
            canSignInHere: true,
            oauthLoginLabel: "Sign in with ChatGPT",
            hiddenStoredOAuth: true,
          }),
        ],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.match(
    coveredHtml,
    /この画面のキーが優先され、Sign in with ChatGPT は使われていません。使うにはキーを削除してください。/,
    "auth.json の OAuth が覆われているときは理由と対処を出す",
  );

  // 削除が未反映の間は [削除] を出せず DELETE も 400 なので、押せる [再同期] を案内する
  const removeFailedHtml = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({
            provider: "openai",
            name: "OpenAI",
            managed: false,
            auth: { configured: true, source: "runtime", environmentVariables: [] },
            credentialKind: "api_key",
            supportsOAuth: true,
            canSignInHere: true,
            oauthLoginLabel: "Sign in with ChatGPT",
            hiddenStoredOAuth: true,
            degraded: "remove",
          }),
        ],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.match(
    removeFailedHtml,
    /この画面のキーが優先され、Sign in with ChatGPT は使われていません。\[再同期\] でキーの削除を反映してください。/,
    "削除が未反映の間は、実際に押せる再同期を案内する",
  );
  assert.match(removeFailedHtml, /<button[^>]*>(?:(?!<\/button>)[\s\S])*再同期<\/button>/, "再同期ボタンを出す");
  assert.equal(
    removeFailedHtml.includes("使うにはキーを削除してください"),
    false,
    "この状態で実行できない削除を案内しない",
  );
  assert.equal(
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*削除<\/button>/.test(removeFailedHtml),
    false,
    "DB 行が無いので削除ボタンは出さない",
  );
});

// 進行中は「まず何を押すか」が 1 つに見えるよう、主文 1 行 + 補助行にし、代替経路は折りたたみへ畳む。
// 認可 URL は空タブを遷移できなかったときだけリンクとして出し、補足 (遷移できた) とは排他にする
const AUTH_URL = "https://auth.example.test/authorize";
const AUTHORIZE_INSTRUCTIONS = "ブラウザのタブで承認してください。承認が終わると、この画面の表示が自動で更新されます。";
const DEVICE_INSTRUCTIONS = "ブラウザでこの URL を開き、画面に表示されたコードを入力して承認してください。";
const INPUT_MESSAGE = "ブラウザの最後の画面の URL を貼り付けてください";
const INPUT_PLACEHOLDER = "ブラウザの最後の画面の URL";

function loginState(status: OAuthLoginState["status"], overrides: Partial<OAuthLoginState> = {}): OAuthLoginState {
  return {
    status,
    authUrl: null,
    instructions: null,
    progress: null,
    input: null,
    userCode: null,
    error: null,
    ...overrides,
  };
}

test("サインインの操作は未認証の説明と注意 (期限・利用条件) を常時出し、旧文を残さない", () => {
  const signIn = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    oauthLoginLabel: "Sign in with ChatGPT",
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [signIn] } }), {
    modelsSubsection: "providers",
  });
  assert.match(
    html,
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*Sign in with ChatGPT<\/button>/,
    "loginLabel をボタン名にする",
  );
  assert.equal(html.includes(">サインアウト<"), false, "保存済み OAuth が無ければサインアウトは出さない");
  assert.ok(html.includes("ブラウザのタブで承認すると、この画面の表示が自動で更新されます。"), "未認証の説明を出す");
  assert.ok(html.includes("サインインは開始から 10 分で自動的に中断します。"), "期限の注意を折りたたみの外に出す");
  assert.ok(html.includes("ローカルの単一ユーザー向けです"), "利用条件を折りたたみの外に出す");
  assert.equal(html.includes("同じマシンのブラウザで承認する必要があります。"), false, "旧文を残さない");
  assert.equal(html.includes("1455"), false, "コールバックのポートを名指ししない");
});

test("認証方法はタブで分け、実効側を既定で開いて印を出す", () => {
  const apiKeyInUse = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    credentialKind: "api_key",
    auth: { configured: true, source: "runtime", environmentVariables: [] },
    oauthLoginLabel: "Sign in with ChatGPT",
    login: loginState("running", { authUrl: AUTH_URL, instructions: AUTHORIZE_INSTRUCTIONS }),
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [apiKeyInUse] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(html.includes('aria-label="OpenAI の認証方法"'), "タブ行を出す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4, "設定の 2 タブ + 認証方法の 2 タブ");
  assert.match(html, /aria-selected="true"[^>]*aria-label="APIキー（使用中）"/, "実効のキー側を既定で開く");
  assert.match(html, /aria-selected="false"[^>]*aria-label="サインイン（進行中）"/, "隠れている側にも状態を出す");
  assert.ok(html.includes(">使用中<"), "「使用中」を印に出す");
  assert.match(html, /<div hidden="" inert="">/, "非表示側はフォーカス対象から外す");
  // タブの切替ではアンマウントしない (進行中の表示と、自分が開いた空タブの参照を保つ)
  assert.ok(html.includes(AUTHORIZE_INSTRUCTIONS), "隠れている側の進行中の表示も残す");

  const signedIn = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    credentialKind: "oauth",
    auth: { configured: true, source: "stored", environmentVariables: [] },
    oauthLoginLabel: "Sign in with ChatGPT",
  });
  const signedInHtml = render(modelSettings({ settings: { ...SETTINGS, providers: [signedIn] } }), {
    modelsSubsection: "providers",
  });
  assert.match(
    signedInHtml,
    /aria-selected="true"[^>]*aria-label="サインイン（使用中）"/,
    "実効が OAuth ならサインイン側",
  );
  assert.match(
    signedInHtml,
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*サインアウト<\/button>/,
    "保存済み OAuth にはサインアウトを出す",
  );
  assert.ok(signedInHtml.includes("ChatGPT の設定から行ってください"), "provider 側を失効させないことを案内する");
});

test("承認待ちは主文と補助行を併記し、代替経路と貼り付けを折りたたみへ畳む", () => {
  const running = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    oauthLoginLabel: "Sign in with ChatGPT",
    login: loginState("running", {
      authUrl: AUTH_URL,
      instructions: AUTHORIZE_INSTRUCTIONS,
      progress: "ブラウザからのコールバックを待っています",
      input: { message: INPUT_MESSAGE, placeholder: INPUT_PLACEHOLDER },
    }),
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [running] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(html.includes(AUTHORIZE_INSTRUCTIONS), "progress があっても主文を消さない");
  assert.ok(html.includes("ブラウザからのコールバックを待っています"), "補助行として併記する");
  assert.equal(html.includes("Sign in with ChatGPT</button>"), false, "進行中は開始ボタンを出さない");
  assert.match(html, /<a[^>]*href="https:\/\/auth\.example\.test\/authorize"/, "遷移できていないのでリンクを出す");
  assert.equal(html.includes("の承認ページが開きます。"), false, "遷移できていないときは補足を出さない");
  assert.ok(html.includes("別のマシンのブラウザで承認する場合"), "代替経路を折りたたみに畳む");
  assert.ok(html.includes("この URL を別のマシンのブラウザで開いて承認し"), "折りたたみの中に手順を出す");
  assert.ok(html.includes("同じホストで別のサインインを同時に進めると"), "ポート競合の注意を折りたたみの中へ移す");
  assert.ok(html.includes(">URL をコピー</button>"), "コピーの導線を出す");
  assert.ok(html.includes(INPUT_MESSAGE), "貼り付けの案内を出す");
  assert.ok(html.includes(`placeholder="${INPUT_PLACEHOLDER}"`), "placeholder も provider 中立の文言にする");
  assert.equal(html.includes("いまは貼り付けを受け付けていません。"), false, "input がある間は受付中とする");
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*中断<\/button>/, "中断を出す");
});

test("貼り付け待ちでない間はフォームを出さず、受け付けていないことを伝える", () => {
  const authorizing = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    login: loginState("running", { authUrl: AUTH_URL, instructions: AUTHORIZE_INSTRUCTIONS }),
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [authorizing] } }), {
    modelsSubsection: "providers",
  });
  assert.equal(html.includes('aria-label="OpenAI のサインインコード"'), false, "フォームを出さない");
  assert.ok(html.includes("いまは貼り付けを受け付けていません。"), "送信後は受け付けていないことを出す");
  assert.ok(html.includes(">URL をコピー</button>"), "URL があればコピーは出し続ける");
});

test("URL 未着の間は折りたたみもリンクも出さず、準備中と伝える", () => {
  const preparing = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    login: loginState("running"),
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [preparing] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(html.includes("認可の準備をしています。"), "URL 未着の主文を出す");
  assert.equal(html.includes("別のマシンのブラウザで承認する場合"), false, "折りたたみを出さない");
  assert.equal(html.includes("承認ページを開く"), false, "開く先が無い間はリンクを出さない");
  assert.equal(html.includes(">URL をコピー</button>"), false);
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*中断<\/button>/, "中断は進行中のすべての副状態で出す");
});

test("デバイスコードは折りたたみを使わず、コードと承認ページをパネルに出す", () => {
  const device = provider({
    provider: "openai",
    name: "OpenAI",
    supportsOAuth: true,
    canSignInHere: true,
    login: loginState("running", {
      authUrl: "https://auth.example.test/device",
      instructions: DEVICE_INSTRUCTIONS,
      userCode: "ABCD-1234",
    }),
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [device] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(html.includes(DEVICE_INSTRUCTIONS), "コード入力の案内を主文にする");
  assert.ok(html.includes("ABCD-1234"), "コードをパネルに出す");
  assert.match(
    html,
    /<a[^>]*href="https:\/\/auth\.example\.test\/device"/,
    "遷移できていないので承認ページのリンクをパネルに出す",
  );
  assert.ok(html.includes(">URL をコピー</button>"), "折りたたみを出さない副状態でもコピーの導線を出す");
  assert.equal(html.includes("別のマシンのブラウザで承認する場合"), false, "折りたたみを使わない");
  assert.equal(html.includes("の承認ページが開きます。"), false, "遷移できていないので補足は出さない");
});

test("終端は結果と [閉じる] だけを残し、進行中の導線を落とす", () => {
  for (const [status, text] of [
    ["succeeded", "サインインしました。資格情報は Pi の auth.json に保存されました。"],
    ["cancelled", "サインインを中断しました。"],
    ["failed", "認可のコールバックポート（1455）が使用中です。"],
  ] as const) {
    const finished = provider({
      provider: "openai",
      name: "OpenAI",
      supportsOAuth: true,
      canSignInHere: true,
      login: loginState(status, { error: status === "failed" ? text : null }),
    });
    const html = render(modelSettings({ settings: { ...SETTINGS, providers: [finished] } }), {
      modelsSubsection: "providers",
    });
    assert.ok(html.includes(text), `${status} の結果を出す`);
    assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*閉じる<\/button>/, "結果表示を消す導線を出す");
    assert.equal(html.includes(">中断</button>"), false, "進行中の導線は残さない");
    assert.equal(html.includes("承認ページを開く"), false);
  }
});

test("カタログ外の provider はサインインの面を出さない", () => {
  const ghost = provider({
    provider: "ghost",
    name: "ghost",
    managed: true,
    canSetApiKey: false,
    supportsOAuth: true,
    canSignInHere: true,
    oauthLoginLabel: "Sign in with ChatGPT",
    orphan: true,
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [ghost] } }), {
    modelsSubsection: "providers",
  });
  assert.equal(html.includes("Sign in with ChatGPT"), false, "開始ボタンを出さない");
  assert.equal(html.includes(">OAuth サインイン</div>"), false, "サインインの面ごと出さない");
  assert.equal(html.includes('aria-label="ghost の認証方法"'), false, "タブも出さない");
});

test("片方の経路しか無い provider はタブを出さず、セクションの見出しを残す", () => {
  const keyOnly = provider({ provider: "local", name: "Local", canSetApiKey: true, supportsOAuth: false });
  const keyHtml = render(modelSettings({ settings: { ...SETTINGS, providers: [keyOnly] } }), {
    modelsSubsection: "providers",
  });
  assert.equal(keyHtml.includes('aria-label="Local の認証方法"'), false, "タブにしない");
  assert.ok(keyHtml.includes(">APIキー</div>"), "セクションの見出しを残す");

  const oauthOnly = provider({
    provider: "openai",
    name: "OpenAI",
    canSetApiKey: false,
    supportsOAuth: true,
    canSignInHere: true,
    oauthLoginLabel: "Sign in with ChatGPT",
  });
  const oauthHtml = render(modelSettings({ settings: { ...SETTINGS, providers: [oauthOnly] } }), {
    modelsSubsection: "providers",
  });
  assert.equal(
    oauthHtml.includes('aria-label="OpenAI の認証方法"'),
    false,
    "キーを登録できない provider はタブにしない",
  );
  assert.ok(oauthHtml.includes(">OAuth サインイン</div>"), "セクションの見出しを残す");
});

test("この画面でサインインできない provider は開始も手順も出さず、理由と [サインアウト] を出す", () => {
  // anthropic はキーを登録できるので行は残るが、OAuth の flow は選択の対話を求める
  const unsupported = provider({
    provider: "anthropic",
    name: "Anthropic",
    supportsOAuth: true,
    canSignInHere: false,
    credentialKind: "oauth",
    auth: { configured: true, source: "stored", environmentVariables: [] },
  });
  const html = render(modelSettings({ settings: { ...SETTINGS, providers: [unsupported] } }), {
    modelsSubsection: "providers",
  });
  assert.ok(html.includes("同じ agent dir を使う pi /login"), "理由として pi /login を案内する");
  assert.ok(html.includes("docs/model-settings.md"), "詳しい手順の docs を示す");
  assert.equal(html.includes("OAuth でサインイン</button>"), false, "開始ボタンを出さない");
  assert.equal(html.includes("同じマシンのブラウザで承認する必要があります。"), false, "手順の説明も出さない");
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*サインアウト<\/button>/, "保存済み OAuth の解除手段は残す");
});

test("provider 行にメモ欄と保存ボタンを出し、runtime 不可では disable する", () => {
  const html = render(
    modelSettings({ settings: { ...SETTINGS, providers: [provider({ memo: "個人アカウントの控え" })] } }),
    {
      modelsSubsection: "providers",
    },
  );
  const textarea = /<textarea[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(textarea !== "", "メモ欄を出す");
  assert.ok(
    textarea.toLowerCase().includes('maxlength="500"') && textarea.includes('rows="2"'),
    "rows と上限で高さを押さえる",
  );
  assert.equal(textarea.includes("disabled"), false, "runtime が使えるときは編集できる");
  assert.ok(html.includes("個人アカウントの控え"), "保存済みのメモを入力値として出す");
  assert.ok(html.includes("メモを保存"), "メモの保存ボタンを出す");
  assert.ok(
    html.includes("例: 個人アカウントの本番キー（2026-01 発行）"),
    "placeholder でキー本体を書かないよう誘導する",
  );
  assert.ok(html.includes("メモは平文で保存され"), "メモが画面と API 応答に出ることを注記する");
  assert.equal(html.includes("メモに未保存の変更があります"), false, "変更がなければ未保存の印を出さない");
  // キー入力の form と別にして、Enter がキーの保存を走らせないようにする
  assert.ok((html.match(/<form/g) ?? []).length >= 2, "メモは専用の form に分ける");

  const stopped = render(
    modelSettings({ settings: { ...SETTINGS, runtimeAvailable: false, providers: [provider()] } }),
    { modelsSubsection: "providers" },
  );
  const stoppedTextarea = /<textarea[^>]*>/.exec(stopped)?.[0] ?? "";
  assert.ok(stoppedTextarea.includes("disabled"), "runtime 不可ではメモ欄を disable する");
  assert.ok(stopped.includes("APIキーとメモの変更はできません"), "変更できないことを先に伝える");
});

test("managed の provider だけにキー最終保存を出し、日時が無ければ保存日不明と書く", () => {
  const stamped = render(
    modelSettings({ settings: { ...SETTINGS, providers: [provider({ managed: true, keyUpdatedAt: 1 })] } }),
    { modelsSubsection: "providers" },
  );
  assert.ok(stamped.includes("キー最終保存:"), "managed には保存日時を出す");
  assert.equal(stamped.includes("保存日不明"), false);

  // 移行前の行 (keyUpdatedAt: null) は「不明」と明示する
  const migrated = render(
    modelSettings({ settings: { ...SETTINGS, providers: [provider({ managed: true, keyUpdatedAt: null })] } }),
    { modelsSubsection: "providers" },
  );
  assert.ok(migrated.includes("キー最終保存: 保存日不明"));

  // 環境変数などの非 managed には日時の行を出さない
  const ambient = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({ provider: "local", name: "Local", auth: { configured: true, environmentVariables: [] } }),
        ],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.equal(ambient.includes("キー最終保存"), false);
});

test("最終使用は一覧の取得後だけ出し、会話が無いときの言い分けを分ける", () => {
  const managed = provider({ managed: true, keyUpdatedAt: 1 });
  const sessions = [
    session({ sessionId: "a", model: "anthropic/claude-sonnet", lastUsedAt: 100 }),
    session({ sessionId: "b", model: "anthropic/claude-haiku", lastUsedAt: 300 }),
  ];
  const withSessions = render(modelSettings({ settings: { ...SETTINGS, providers: [managed] } }), {
    modelsSubsection: "providers",
    sessions,
    sessionsLoaded: true,
  });
  assert.ok(withSessions.includes("最終使用:"), "取得後は最終使用を出す");
  assert.ok(withSessions.includes("この provider の会話 2 件"), "会話数を出す");

  // 未取得の間は最終使用の行ごと出さない (「0 件」と混同しない)
  const beforeLoad = render(modelSettings({ settings: { ...SETTINGS, providers: [managed] } }), {
    modelsSubsection: "providers",
    sessions: [],
    sessionsLoaded: false,
  });
  assert.equal(beforeLoad.includes("最終使用"), false);
  assert.equal(beforeLoad.includes("この provider の会話はありません"), false);

  // 取得済みで 1 件も無ければ、managed には「会話はありません」と書く
  const noSessions = render(modelSettings({ settings: { ...SETTINGS, providers: [managed] } }), {
    modelsSubsection: "providers",
    sessions: [],
    sessionsLoaded: true,
  });
  assert.ok(noSessions.includes("この provider の会話はありません"));

  // managed でなく会話も 0 件ならどちらの行も出さない (ノイズを作らない)
  const quiet = render(
    modelSettings({ settings: { ...SETTINGS, providers: [provider({ provider: "local", name: "Local" })] } }),
    { modelsSubsection: "providers", sessions: [], sessionsLoaded: true },
  );
  assert.equal(quiet.includes("キー最終保存"), false);
  assert.equal(quiet.includes("最終使用"), false);

  // managed でなくても会話があれば最終使用だけを出す (環境変数認証など)
  const ambient = render(modelSettings({ settings: { ...SETTINGS, providers: [provider()] } }), {
    modelsSubsection: "providers",
    sessions,
    sessionsLoaded: true,
  });
  assert.equal(ambient.includes("キー最終保存"), false);
  assert.ok(ambient.includes("最終使用:"));
  assert.ok(ambient.includes("この provider の会話 2 件"));
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
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes("保存済み（未反映）"), "未反映として警告する");
  assert.ok(
    html.includes("カタログに戻ってから登録し直してください"),
    "実行できない再同期ではなく削除と復帰を案内する",
  );
  assert.ok(html.includes("削除"), "managed なので削除は出る");
  assert.equal(html.includes("再同期"), false, "resync API が 400 になる詳細に再同期ボタンを出さない");
});

test("キー登録できない provider は入力欄を出さず、理由を書く", () => {
  const html = render(
    modelSettings({
      settings: { ...SETTINGS, providers: [provider({ provider: "local", name: "Local", canSetApiKey: false })] },
    }),
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes("この画面からは登録できません"));
  assert.equal(html.includes('type="password"'), false);
});

test("カタログ外のメモだけの provider はキーを登録できないがメモは書けると案内する", () => {
  const html = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({ provider: "memo-only", name: "memo-only", orphan: true, canSetApiKey: false, memo: "控え" }),
        ],
      },
      catalog: null,
    }),
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes("キーの登録はできません（メモは保存できます）"), "メモ欄の存在が伝わる文言にする");
  assert.ok(html.includes("控え"), "既存のメモを表示する");
  assert.equal(html.includes('type="password"'), false, "キーの入力欄は出さない");
});

test("カタログの失敗はプロバイダータブでも独立して出す", () => {
  const html = render(
    modelSettings({
      settings: { ...SETTINGS, runtimeAvailable: false },
      catalog: null,
      catalogError: "ランタイムのモデル情報を取得できません",
    }),
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes("APIキーとメモの変更はできません"), "変更できないことを先に伝える");
  assert.ok(html.includes("モデル一覧を取得できませんでした"), "カタログの失敗を独立して出す");
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

test("ページ本体は取得前の初期状態 (読み込み中) を出す", () => {
  // hook が取得を始めるのは mount 後なので、react-dom/server の初期描画は読み込み中になる
  const html = renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ModelSettingsPage, {
        onRefreshHealth: async () => null,
        onBack: () => {},
        sessions: [],
        sessionsLoaded: false,
        modelsSubsection: "models",
        onSelectModelsSubsection: () => {},
      }),
    ),
  );
  assert.ok(html.includes("プロバイダーの認証状態を読み込んでいます。"));
  assert.ok(html.includes('role="tablist"'), "取得前からタブは出す");
  assert.equal(html.includes("未保存の変更はありません"), false, "設定未取得の間は固定バーを出さない");
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

test("取り直しはタブ行の下のツールバーへ出し、本文の枠には置かない", () => {
  const html = render(modelSettings());
  const tabsAt = html.indexOf('role="tablist"');
  assert.ok(tabsAt >= 0, "タブ行を出す");
  for (const label of ["カタログ更新", "再読み込み"]) {
    const at = html.indexOf(label);
    assert.ok(at > tabsAt, `${label} はタブ行より下に出す`);
  }
  assert.ok(html.indexOf("カタログ更新") < html.indexOf("既定モデル"), "ツールバーは本文より上に出す");

  const failed = render(
    modelSettings({
      settings: null,
      note: { text: "モデルの設定を読み込めませんでした。接続できません", error: true },
    }),
  );
  assert.ok(failed.includes(RELOAD_ABOVE_NOTE), "本文の枠には上の導線を案内する");
  assert.equal((failed.match(/>再読み込み<\/button>/g) ?? []).length, 1, "再読み込みはツールバーに 1 つだけ");
});

test("カタログ更新は両タブに出し、更新中・runtime 不可・カタログ取得失敗で無効にする", () => {
  const enabled = render(modelSettings());
  assert.equal((enabled.match(/カタログ更新/g) ?? []).length, 1, "既定タブに 1 つ出す");
  assert.match(
    enabled,
    /<button[^>]*class="btn-quiet"[^>]*>(?:(?!<\/button>)[\s\S])*カタログ更新<\/button>/,
    "再読み込みと同じ寸法の取り直しボタンにする",
  );
  assert.equal(
    /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*カタログ更新<\/button>/.test(enabled),
    false,
    "runtime とカタログが使えるときは押せる",
  );

  const refreshing = render(modelSettings({ refreshing: true }));
  assert.match(
    refreshing,
    /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*更新中<\/button>/,
    "更新中は連打できない",
  );

  const unavailable = render(modelSettings({ settings: { ...SETTINGS, runtimeAvailable: false } }));
  assert.match(
    unavailable,
    /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*カタログ更新<\/button>/,
    "runtime が無いときは押せない",
  );

  const failed = render(modelSettings({ catalogError: "ランタイムのモデル情報を取得できません" }));
  assert.match(
    failed,
    /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*カタログ更新<\/button>/,
    "カタログを取得できていないときは押せない",
  );

  const providers = render(modelSettings(), { modelsSubsection: "providers" });
  assert.ok(providers.includes("カタログ更新"), "プロバイダータブにも出す");
});

test("保存済みのキーを復号できないときは、サーバーの固定文言を詳細に出す", () => {
  const message = "master key（U7AGENT_SECRET_MASTER_KEY）が未設定または不正なため、保存済みのキーを復号できません";
  const html = render(
    modelSettings({
      settings: {
        ...SETTINGS,
        providers: [
          provider({
            managed: true,
            keyAvailable: false,
            keyEvaluated: true,
            keyErrorMessage: message,
            degraded: "apply",
            auth: { configured: true, source: "runtime", environmentVariables: [] },
          }),
          ...SETTINGS.providers.slice(1),
        ],
      },
    }),
    { modelsSubsection: "providers" },
  );
  assert.ok(html.includes(message), "原因は推測せずサーバーの文言をそのまま出す");
  assert.match(html, /role="alert"[^>]*>[^<]*master key/, "注意領域に出す");
});
