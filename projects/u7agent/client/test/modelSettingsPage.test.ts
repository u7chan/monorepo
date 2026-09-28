// 設定 → モデルの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// タブ・「モデルを選ぶ」の候補と保存バー・「プロバイダー」のマスター詳細を固定する
// (状態遷移・集計・確認の文言は lib/modelSettings の純関数テストが担う)。
// 保存の画面内確認だけは押下後の状態を持つため静的描画では出せない。ソース上でネイティブ confirm を
// 使わないことを固定し、判断は lib の純関数テストで検証する。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ModelSettings } from "../src/hooks/useModelSettings";
import { MODEL_SETTINGS_NOTE } from "../src/lib/modelSettings";
import type { ModelsSubsection } from "../src/lib/settingsNav";
import type {
  ModelsSettingsResponse,
  ModelMutationResponse,
  ProviderAuthSetting,
  RuntimeModelsResponse,
  SessionSummary,
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

function render(
  settings: ModelSettings,
  options: {
    modelsSubsection?: ModelsSubsection;
    sessions?: SessionSummary[];
    sessionsLoaded?: boolean;
    onSelectModelsSubsection?: (subsection: ModelsSubsection) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ModelSettingsView, {
      modelSettings: settings,
      sessions: options.sessions ?? [],
      sessionsLoaded: options.sessionsLoaded ?? false,
      modelsSubsection: options.modelsSubsection ?? "models",
      onSelectModelsSubsection: options.onSelectModelsSubsection ?? (() => {}),
      onBack: () => {},
    }),
  );
}

test("タブ行は URL が決めるタブを示し、両方のタブを出す", () => {
  const html = render(modelSettings());
  assert.ok(html.includes('role="tablist"'), "タブ行を出す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2, "タブは 2 つ");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>モデルを選ぶ</, "既定は「モデルを選ぶ」");
  assert.ok(html.includes("プロバイダー"));
  // タブの切替は URL 経由で親へ渡す
  const calls: ModelsSubsection[] = [];
  render(modelSettings(), { onSelectModelsSubsection: (subsection) => calls.push(subsection) });
  assert.deepEqual(calls, [], "描画だけでは切替を要求しない");

  const providersHtml = render(modelSettings(), { modelsSubsection: "providers" });
  assert.match(providersHtml, /<button[^>]*aria-selected="true"[^>]*>プロバイダー</);
  assert.equal(providersHtml.includes("モデル候補を保存"), false, "プロバイダータブに候補の保存バーは出さない");
  assert.ok(providersHtml.includes("provider 名 / ID で絞り込み"));
});

test("モデルを選ぶタブは既定モデル・選択数・候補・保存バーを出す", () => {
  const html = render(modelSettings());
  assert.ok(html.includes("既定モデル"), "既定モデルの見出しを出す");
  assert.ok(html.includes("未設定（利用可能なモデルの先頭を使う）"), "既定の未設定を残す");
  assert.ok(html.includes("選択 1 / 利用可能 1"), "選択数と利用可能数を出す");
  assert.ok(html.includes("チェックしたモデルだけが候補になります"));
  assert.ok(html.includes("Claude Sonnet") && html.includes("Claude Haiku"), "先頭の provider のカタログ全件を出す");
  assert.ok(html.includes("利用可能 1/2 ・ 選択 1"), "provider 行に a/b と選択数を出す");
  assert.ok(html.includes("すべて選択") && html.includes("すべて解除"), "provider ごとの一括操作を出す");
  assert.ok(html.includes("min-h-9") && html.includes("size-4 shrink-0 accent-focus"), "チェック行の寸法");
  assert.ok(html.includes("min-h-11"), "選択済みのみのチェックはタッチ向けの高さを保つ");
  assert.ok(html.includes("開いている会話のモデルは切り替えません"), "live の会話へ効かないことを注記する");
  assert.ok(html.includes("モデル一覧を表示") === false, "ModelTable は出さない");
  // 下部の固定アクション行は変更なしを示し、ボタンは無効
  assert.ok(html.includes("未保存の変更はありません"));
  assert.ok(html.includes('class="btn-primary" disabled=""'));
  assert.ok(html.includes("モデル候補を保存"));
});

test("既存の null（制限なし）は利用可能な全モデルを選択済みとして表示する", () => {
  const html = render(modelSettings({ settings: { ...SETTINGS, allowedModels: null } }));
  assert.ok(html.includes("選択 1 / 利用可能 1"));
  assert.equal((html.match(/checked=""/g) ?? []).length, 1, "利用可能な Claude Sonnet だけがチェック済み");
  const sonnetRow = /<label[^>]*title="anthropic\/claude-sonnet"[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? "";
  assert.ok(sonnetRow.includes('checked=""'), "利用可能なモデルの行がチェック済み");
});

test("未認証 provider に残った選択は警告付きで表示し、外せる", () => {
  const html = render(
    modelSettings({ settings: { ...SETTINGS, allowedModels: ["local/local-a"], defaultModel: null } }),
  );
  assert.ok(html.includes("認証が設定されていない provider です。保存済みの選択だけを表示しています。"));
  assert.ok(html.includes("Local A"), "保存済みの残存エントリを行に出す");
  assert.ok(html.includes("すべて解除"), "外せるようにする");
  assert.equal(
    (html.match(/すべて選択/g) ?? []).length,
    1,
    "すべて選択は認証済み provider にだけ出し、見えない行を一括選択させない",
  );
  assert.ok(html.includes("選択 1 / 利用可能 1"), "選択数と、表示集合の利用可能数を分けて数える");
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
});

test("選択 0 件は保存できず、空を送らない理由を出す", () => {
  const html = render(modelSettings({ settings: { ...SETTINGS, allowedModels: [], defaultModel: null } }));
  assert.ok(html.includes("選択したモデルが 0 件のため保存できません"));
  assert.ok(html.includes("空の選択は API で「制限なし（全モデル）」へ正規化される"));
  assert.ok(html.includes("「モデル候補」から 1 つ以上選ぶと既定モデルを選べます"));
  assert.ok(html.includes('class="btn-primary" disabled=""'));
});

test("カタログを取得できないときは候補を編集させず、保存もできない", () => {
  const html = render(modelSettings({ catalog: null, catalogError: "ランタイムのモデル情報を取得できません" }));
  assert.ok(html.includes("モデル一覧を取得できないため、モデル候補は編集できません"));
  assert.ok(html.includes("ランタイムのモデル情報を取得できません"));
  assert.equal(html.includes("モデル一覧を読み込んでいます"), false, "取得失敗と読み込み中を混同しない");
  assert.ok(html.includes('class="btn-primary" disabled=""'));
});

test("カタログの読み込み中は編集不可と出さず、保存も押せない", () => {
  const html = render(modelSettings({ catalog: null, catalogError: null }));
  assert.ok(html.includes("モデル一覧を読み込んでいます"));
  assert.equal(html.includes("モデル一覧を取得できないため"), false);
  assert.ok(html.includes('class="btn-primary" disabled=""'));
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
    createElement(ModelSettingsPage, {
      onRefreshHealth: async () => null,
      onBack: () => {},
      sessions: [],
      sessionsLoaded: false,
      modelsSubsection: "models",
      onSelectModelsSubsection: () => {},
    }),
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

test("モデル候補の保存確認は window.confirm を使わず、純関数の文言で画面内に出す", () => {
  const modelsTab = readFileSync(
    fileURLToPath(new URL("../src/components/model-settings/ModelsTab.tsx", import.meta.url)),
    "utf8",
  );
  assert.equal(modelsTab.includes("window.confirm"), false, "ネイティブ confirm を使わない");
  assert.match(modelsTab, /availabilitySaveConfirmMessage\(/, "確認の文言は純関数から取る");
  assert.match(modelsTab, /role="alert"/, "確認は画面内に出す");
  assert.match(modelsTab, /保存する/, "同意ボタンを出す");
  assert.match(modelsTab, /キャンセル/, "取り消しできるボタンを出す");
  assert.match(modelsTab, /normalizeAllowedModels\(draft\.allowed\)/, "全選択でも明示リストを送る");
  assert.match(modelsTab, /noSelection/, "選択 0 件では保存を押させない");

  const providersTab = readFileSync(
    fileURLToPath(new URL("../src/components/model-settings/ProvidersTab.tsx", import.meta.url)),
    "utf8",
  );
  // キー削除の確認は従来どおりネイティブ confirm のまま (この指摘の対象外)
  assert.equal(providersTab.includes("window.confirm"), true);
  assert.equal(providersTab.includes("ModelTable"), false, "モデル一覧の3重表示を消す");
});

test("下書きの作り直しは保存値と初回の null 展開に限り、provider の入力は親が保つ", () => {
  const page = readFileSync(fileURLToPath(new URL("../src/components/ModelSettingsPage.tsx", import.meta.url)), "utf8");
  // カタログの更新 (キー操作での再取得・取得失敗) では下書きを作り直さない。判定は lib の純関数が持つ
  assert.match(page, /availabilityDraftState\(/, "比較基準の作り直しは純関数に任せる");
  assert.match(page, /appliedDraft\.current/);
  assert.match(page, /providerDrafts/, "provider の下書きも両タブの親が持つ");
  assert.match(page, /withProviderDraft\(/);

  const providersTab = readFileSync(
    fileURLToPath(new URL("../src/components/model-settings/ProvidersTab.tsx", import.meta.url)),
    "utf8",
  );
  // apiKey / memo のローカル state を持たない (再マウントで保存値に戻らない)
  assert.equal(providersTab.includes("const [apiKey, setApiKey]"), false);
  assert.equal(providersTab.includes("const [memo, setMemo]"), false);
  assert.match(providersTab, /providerDraftOf\(/, "入力値は親の下書きから取る");
  assert.match(providersTab, /onChangeDraft\(/, "編集は親の下書きを更新する");
  // 保存完了と保存値の同期は保存対象のフィールドだけを更新する (await 中に入力された他方を古い値で上書きしない)
  assert.match(providersTab, /onChangeDraft\(provider\.provider, \{ apiKey: "" \}\)/, "キー保存後は apiKey だけ消す");
  assert.match(providersTab, /onChangeDraft\(provider\.provider, \{ memo: trimmed \}\)/, "メモ保存後は memo だけ戻す");
  assert.match(
    providersTab,
    /onChangeDraft\(provider\.provider, \{ memo: savedMemo \}\)/,
    "外部変化の同期も memo だけ",
  );
});
