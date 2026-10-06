import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ModelSettings } from "../src/hooks/useModelSettings";
import type { ImageSettings } from "../src/hooks/useImageSettings";
import type { WebSearchSettings } from "../src/hooks/useWebSearchSettings";
import { IMAGE_SETTINGS_NOTE } from "../src/lib/imageSettings";
import { MODEL_SETTINGS_NOTE } from "../src/lib/modelSettings";
import type { ModelsSubsection } from "../src/lib/settingsNav";
import type {
  ModelsSettingsResponse,
  ModelMutationResponse,
  ImageSettingsResponse,
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
    canSetApiKey: true,
    supportsOAuth: false,
    orphan: false,
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
    savingAvailability: false,
    reloading: false,
    reload: async () => {},
    save: async () => true,
    saveMemo: async () => true,
    saveAvailability: async () => SETTINGS,
    remove: async () => true,
    resync: async () => true,
    ...overrides,
  };
}

const IMAGE_SETTINGS: ImageSettingsResponse = {
  configured: true,
  provider: "openrouter",
  model: "openai/gpt-image-2",
  models: [
    { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
    { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
  ],
  catalogSource: "live",
  fetchedAt: null,
  runtimeAvailable: true,
};

function imageSettings(overrides: Partial<ImageSettings> = {}): ImageSettings {
  return {
    settings: IMAGE_SETTINGS,
    note: { text: IMAGE_SETTINGS_NOTE, error: false },
    saving: null,
    reloading: false,
    reload: async () => {},
    saveKey: async () => true,
    removeKey: async () => true,
    saveSelection: async () => true,
    refreshCatalog: async () => true,
    ...overrides,
  };
}

function webSearchSettings(overrides: Partial<WebSearchSettings> = {}): WebSearchSettings {
  return {
    settings: { enabled: true, disabledMessage: "Web 検索は無効化されています。" },
    note: { text: "Web 検索の設定はサーバーに保存され、再起動後も残ります。", error: false },
    saving: false,
    reloading: false,
    reload: async () => {},
    setEnabled: async () => true,
    ...overrides,
  };
}

function render(
  settings: ModelSettings,
  options: {
    modelsSubsection?: ModelsSubsection;
    sessions?: SessionSummary[];
    sessionsLoaded?: boolean;
    imageSettings?: ImageSettings;
    webSearchSettings?: WebSearchSettings;
    onSelectModelsSubsection?: (subsection: ModelsSubsection) => void;
  } = {},
): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ModelSettingsView, {
        modelSettings: settings,
        imageSettings: options.imageSettings ?? imageSettings(),
        webSearchSettings: options.webSearchSettings ?? webSearchSettings(),
        sessions: options.sessions ?? [],
        sessionsLoaded: options.sessionsLoaded ?? false,
        modelsSubsection: options.modelsSubsection ?? "models",
        onSelectModelsSubsection: options.onSelectModelsSubsection ?? (() => {}),
        onBack: () => {},
      }),
    ),
  );
}

test("タブ行は URL が決めるタブを示し、4 つのタブを出す", () => {
  const html = render(modelSettings());
  assert.ok(html.includes('role="tablist"'), "タブ行を出す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4, "タブは 4 つ");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>モデルを選ぶ</, "既定は「モデルを選ぶ」");
  assert.ok(html.includes("プロバイダー"));
  assert.ok(html.includes("画像生成"));
  assert.ok(html.includes("Web 検索"));
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

test("画像生成タブは URL が選んだときにだけ描画し、キー入力を出す", () => {
  const html = render(modelSettings(), { modelsSubsection: "images" });
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>画像生成</);
  assert.ok(html.includes('type="password"'), "画像生成タブのキー入力を出す");
  assert.equal(html.includes("モデル候補を保存"), false, "他のタブの保存バーは出さない");
});

test("Web 検索タブは URL が選んだときにだけ描画し、実行時トグルの状態を出す", () => {
  const html = render(modelSettings(), { modelsSubsection: "web-search" });
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>Web 検索</);
  assert.ok(html.includes('role="switch"'), "有効 / 無効のスイッチを出す");
  assert.ok(html.includes("mcp.exa.ai"), "送信先のホストを出す");
  assert.ok(html.includes("キー登録は不要です"), "keyless であることを書く");
  assert.ok(html.includes("web_search ツールを実行したときだけ"), "実行したときだけ送ることを書く");
  assert.equal(html.includes("モデル候補を保存"), false, "他のタブの保存バーは出さない");

  // 取得前は本文の代わりに再読み込みの導線を出し、hook の注記をそのまま見せる
  const loading = render(modelSettings(), {
    modelsSubsection: "web-search",
    webSearchSettings: webSearchSettings({ settings: null }),
  });
  assert.ok(loading.includes("Web 検索の設定"), "取得前の見出しを出す");
  assert.equal(loading.includes('role="switch"'), false, "取得前はスイッチを出さない");

  // 無効のときは、モデルへ返る固定文言をそのまま出す
  const off = render(modelSettings(), {
    modelsSubsection: "web-search",
    webSearchSettings: webSearchSettings({ settings: { enabled: false, disabledMessage: "無効です（固定文言）" } }),
  });
  assert.ok(off.includes("無効です（固定文言）"));
});

test("モデルを選ぶタブは既定モデル・選択数・候補・保存バーを出し、折りたたみは既定で閉じる", () => {
  const html = render(modelSettings());
  assert.ok(html.includes("既定モデル"), "既定モデルの見出しを出す");
  assert.ok(html.includes("未設定（利用可能なモデルの先頭を使う）"), "既定の未設定を残す");
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
  assert.ok(html.includes("未設定（利用可能なモデルの先頭を使う）"), "未認証を指す既定も未設定へ戻す");
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

test("プロバイダータブは一覧と詳細を分け、平文の注意を上部に常時出す", () => {
  const html = render(modelSettings(), { modelsSubsection: "providers" });
  assert.ok(html.includes("設定済み 3") && html.includes("未設定 2"), "全件を設定済み / 未設定に分けて出す");
  for (const name of ["Anthropic", "OpenAI", "Local", "ghost", "Stale"]) {
    assert.ok(html.includes(name), `${name} を一覧に出す`);
  }
  assert.ok(html.includes("環境変数（ANTHROPIC_API_KEY）"), "詳細の認証バッジを出す");
  assert.ok(html.includes("利用可能 1 / カタログ 2"), "カタログから数えたモデル数を出す");
  assert.ok(html.includes('type="password"'), "キー入力はマスクする");
  assert.ok(html.includes("BFF をインターネットや LAN へ公開しないでください"), "公開しない注意を常時出す");
  assert.ok(html.includes("キーの有効性は保存時に確認しません"));
  assert.ok(html.includes("キーを保存して「モデルを選ぶ」タブに戻ると"));
  assert.ok(html.includes("各項目の保存ボタンでその場で保存されます"), "キー・メモは即時保存だと区別する");
  assert.ok(html.includes("「モデルを選ぶ」タブを開く"));
  assert.ok(html.includes("モデル一覧を表示") === false, "ModelTable は削除した");
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
  assert.ok(html.includes("メモも平文で保存され"), "メモが画面と API 応答に出ることを注記する");
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
