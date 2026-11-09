// コンテンツ生成タブの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 未設定 / 設定済み / runtime 不可の出し分けと、タブで選んだ面だけを描くこと・保存済みキーを
// 表示しないことを固定する (タブ行と警告ドットは画面が持つため contentSettingsPage.test.ts が見る)。
// 入力の後始末・選択肢・PUT の本文・確認文は lib/contentSettings の純関数テストが担う。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ContentSettingsTab } from "../src/components/content-settings/ContentSettingsTab";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import type { ContentSavingAction } from "../src/lib/contentSettings";
import type { ContentSubsection } from "../src/lib/settingsNav";
import type { ContentImageSettings, ContentSettingsResponse, ContentSpeechSettings, ContentTrial } from "../src/types";

const MODELS = [
  { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
  { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
];

const SPEECH_MODELS = [
  {
    provider: "openrouter",
    id: "google/gemini-3.8-flash-tts",
    name: "Google: Gemini 3.8 Flash TTS",
    voices: ["Zephyr", "Kore"],
  },
  { provider: "openrouter", id: "fish/audio", name: "Fish Audio" },
];

/** `image` / `speech` の中身を差し替える (provider など設定面の値は render の引数から渡す) */
function settings(
  image: Partial<ContentImageSettings> = {},
  overrides: Partial<ContentSettingsResponse> = {},
  speech: Partial<ContentSpeechSettings> = {},
): ContentSettingsResponse {
  return {
    configured: true,
    provider: "openrouter",
    keyStored: true,
    keyAvailable: true,
    keyEvaluated: true,
    keyErrorMessage: null,
    keyEpoch: 0,
    enabled: true,
    disabledMessage: "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。",
    runtimeAvailable: true,
    bgm: { model: "google/lyria-3-clip-preview", format: "mp3", expectedDurationSeconds: 30 },
    image: {
      model: "openai/gpt-image-2",
      provider: "openrouter",
      auth: { state: "configured", kind: "api_key" },
      models: MODELS,
      catalogSource: "live",
      fetchedAt: null,
      parametersByModel: {},
      ...image,
    },
    speech: {
      model: "google/gemini-3.8-flash-tts",
      voice: "Zephyr",
      models: SPEECH_MODELS,
      catalogSource: "live",
      fetchedAt: null,
      ...speech,
    },
    ...overrides,
  };
}

function render(
  options: {
    image?: Partial<ContentImageSettings>;
    speech?: Partial<ContentSpeechSettings>;
    saving?: ContentSavingAction | null;
    speechSynced?: boolean;
    /** URL が決める面。この component は選択中の面だけを描く (既定は画像生成) */
    subsection?: ContentSubsection;
    /** 試行の一覧と操作の状態 (画像の面だけが使う) */
    trials?: ContentTrial[];
    /** 選択行の全文（未指定は先頭の行） */
    trialDetail?: ContentTrial | null;
    trialHasMore?: boolean;
    trialKeyEpoch?: number;
    trialArtifactUsage?: { count: number; bytes: number };
    trialArtifactWarning?: { thresholdBytes: number; warning: boolean } | null;
    /** 試行の操作の注記（試行の面の中だけに出す） */
    trialNote?: { text: string; error: boolean } | null;
    trialBusy?: boolean;
  } & Omit<Partial<ContentSettingsResponse>, "image" | "speech"> = {},
): string {
  const { image, speech, saving = null, subsection = "image", ...overrides } = options;
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ContentSettingsTab, {
        settings: settings(image, overrides, speech),
        contentSubsection: subsection,
        saving,
        onSetEnabled: async () => true,
        onSaveKey: async () => true,
        onDeleteKey: async () => true,
        onSaveImageProvider: async () => true,
        onSaveSelection: async () => true,
        onRefreshCatalog: async () => true,
        onSaveSpeech: async () => true,
        onRefreshSpeechCatalog: async () => true,
        speechSynced: options.speechSynced ?? true,
        trials: options.trials ?? [],
        trialDetail: options.trialDetail !== undefined ? options.trialDetail : (options.trials?.[0] ?? null),
        trialHasMore: options.trialHasMore ?? false,
        trialLoadingMore: false,
        onSelectTrial: () => {},
        onLoadTrial: async () => options.trials?.[0] ?? null,
        onLoadMoreTrials: async () => true,
        trialKeyEpoch: options.trialKeyEpoch ?? 0,
        trialArtifactUsage: options.trialArtifactUsage ?? { count: 0, bytes: 0 },
        trialArtifactWarning: options.trialArtifactWarning ?? null,
        trialNote: options.trialNote ?? null,
        trialBusy: options.trialBusy ?? false,
        onStartTrial: async () => true,
        onCancelTrial: async () => true,
        onDeleteTrial: async () => true,
        onDeleteAllTrials: async () => true,
      }),
    ),
  );
}

test("設定は要約 1 行を既定にし、変更でキーとモデルを開く", () => {
  const html = render();
  assert.match(html, /aria-expanded="false"/, "既定は畳む");
  assert.ok(html.includes(">設定<"), "設定の見出しを出す");
  assert.ok(html.includes("有効 · キー設定済み · openrouter/openai/gpt-image-2"), "現在値を 1 行にまとめる");
  assert.ok(html.includes(">変更<"), "展開する操作を出す");
  // 開閉は高さの遷移 (Fold) が持ち、中身は閉じている間も残す (inert で外すだけ)
  assert.ok(
    html.includes('class="tree-fold" data-open="false" inert=""'),
    "閉じている間も開閉の入れ物を置く（中身は keepMounted で残る）",
  );
  assert.ok(html.includes('type="password"'), "展開した中にキー入力を残す（inert で外すだけ）");
  assert.ok(html.includes('aria-label="コンテンツ生成のモデル"'), "展開した中にモデル選択を残す");
  assert.ok(html.includes("履歴を見る"), "履歴は専用タブへ案内する");
});

test("履歴タブは設定を持たず、全種別の一覧と詳細を出す", () => {
  const html = render({
    subsection: "history",
    trials: [TRIAL_BASE, SPEECH_TRIAL_BASE, BGM_TRIAL_BASE],
    trialDetail: TRIAL_BASE,
  });
  assert.equal(html.includes('type="password"'), false, "履歴タブにキー入力を出さない");
  assert.equal(html.includes("有効 / 無効"), false, "履歴タブに生成の設定を出さない");
  assert.ok(html.includes("履歴（3 件）"), "件数を出す");
  assert.ok(html.includes("保存済み"), "保存容量を出す");
  assert.ok(html.includes("種別絞り込み"), "種別の絞り込みを出す");
  assert.ok(html.includes("モデル絞り込み"), "モデルの絞り込みを出す");
  assert.ok(html.includes("成功失敗の絞り込み"), "成功 / 失敗の絞り込みを出す");
  assert.ok(html.includes("この内容で編集"), "入力欄へ戻す導線を出す");
  assert.ok(html.includes("もう一度生成"), "再生成の導線を出す");
  assert.ok(html.includes("送ったプロンプトをコピー"), "プロンプトのコピーを出す");
  assert.ok(html.includes(">種別<"), "パラメータの表を出す");
  assert.ok(html.includes(">キー世代<"), "キー世代を出す");
});

test("全文を取得できるまでプロンプトは抜粋と明示し、コピーさせない", () => {
  // 生成タブの静的描画では全文の取得 effect が走らないため、抜粋のままになる
  const latest = render({ trials: [TRIAL_BASE] });
  assert.ok(latest.includes("送ったプロンプト（抜粋）"), "抜粋であることをラベルに出す");
  assert.ok(latest.includes("全文を取得中です。取得できるまでコピーはできません。"), "コピーできない理由を出す");
  assert.equal(latest.includes("送ったプロンプトをコピー"), false, "抜粋をコピーさせない");

  const loading = render({ subsection: "history", trials: [TRIAL_BASE], trialDetail: null });
  assert.ok(loading.includes("送ったプロンプト（抜粋）"), "履歴の詳細も取得中は抜粋と明示する");
  assert.equal(loading.includes("送ったプロンプトをコピー"), false);

  const loaded = render({ subsection: "history", trials: [TRIAL_BASE], trialDetail: TRIAL_BASE });
  assert.ok(loaded.includes("送ったプロンプトをコピー"), "全文を取れたらコピーを出す");
});

test("履歴が 0 件でも容量を出し、条件に合う行が無いことを伝える", () => {
  const html = render({ subsection: "history", trials: [], trialArtifactUsage: { count: 2, bytes: 4_096 } });
  assert.ok(html.includes("保存済み 2 件 · 4.0 KiB"), "容量は履歴が無くても出す");
  assert.ok(html.includes("条件に合う履歴はありません。"), "空の案内を出す");
});

test("未設定ではキー入力だけを出し、モデル選択と削除は出さない", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.ok(html.includes('type="password"'), "キー入力を出す");
  assert.match(html, /<input[^>]*(?:autoComplete|autocomplete)="off"/, "再表示しない前提なので autocomplete を切る");
  assert.ok(
    html.includes("OpenRouter のコンテンツ生成（画像 / 音声 / BGM）で共有するキーです"),
    "どの provider のキーかと、別管理であることを出す",
  );
  assert.equal(html.includes("画像生成専用のキー"), false, "音声と共有するため画像専用とは書かない");
  assert.ok(html.includes(">未設定<"), "未設定バッジを出す");
  assert.equal(html.includes("設定済み"), false, "未設定では設定済みと言わない");
  assert.equal(html.includes("<select"), false, "モデル選択はキー保存後にだけ出す");
  assert.equal(html.includes(">削除</button>"), false, "削除もキー保存後にだけ出す");
  assert.equal(html.includes(">カタログ更新</button>"), false, "カタログ更新もモデル欄と同じくキー保存後にだけ出す");
  assert.equal(html.includes("出力形式は選ばず"), false, "音声の保存欄もキー保存後にだけ出す");
});

test("有効 / 無効はタブの外に 1 つだけ出し、画像・音声・BGM 共通だと伝える", () => {
  for (const subsection of ["image", "speech", "bgm"] as const) {
    const html = render({ subsection });
    assert.ok(html.includes("有効 / 無効"), `${subsection} でも同じトグルを出す`);
    assert.equal(html.split("有効 / 無効").length - 1, 1, "面ごとに複製しない");
    assert.ok(html.includes("アプリ全体の生成を止めます（画像・音声・BGM で共通）"));
    assert.ok(html.includes(">有効<"), "現在値のラベルを出す");
    assert.ok(html.includes("既存のセッション"), "会話を作り直さなくても効くことを伝える");
    assert.ok(html.includes("キーと選択は残ります"), "削除との違いを伝える");
    assert.ok(html.includes("OFF の間に作った会話にはツールが無い"), "ON で既存の会話すべてが使えると誤解させない");
  }
});

test("無効のときは固定文言と警告色を出し、未設定ではトグル自体を出さない", () => {
  const disabled = render({ enabled: false });
  assert.ok(disabled.includes(">無効<"));
  assert.ok(disabled.includes("コンテンツ生成は無効化されています"));
  assert.match(disabled, /border-warn\/50 bg-raised/, "止まっていることが見た目で分かる");

  const unset = render({
    configured: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.equal(unset.includes("有効 / 無効"), false, "キーが無ければ止める対象が無いので出さない");
});

test("見出しに provider のロゴ・名前・id とキーの登録状態を出す", () => {
  const html = render();
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/, "ロゴを出す (プロバイダータブと同じ対応表を引く)");
  assert.ok(html.includes(">OpenRouter</h2>"), "provider の表示名を出す");
  assert.ok(html.includes(">openrouter</code>"), "モデル欄の id 表記と結び付くように provider id も出す");
  assert.ok(html.includes(">設定済み<"), "登録状態を provider の見出しへ出す");
  assert.ok(
    html.includes('rounded border px-1.5 py-0.5 text-2xs whitespace-nowrap border-line text-ink-muted">画像 2<'),
    "カタログの件数もプロバイダータブと同じチップで出す",
  );
  assert.ok(
    html.includes('rounded border px-1.5 py-0.5 text-2xs whitespace-nowrap border-line text-ink-muted">音声 2<'),
    "音声カタログの件数も同じチップで出す",
  );
});

test("未設定でも、これから登録するキーの provider の見出しは出す", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/, "この画面で登録するキーの provider のロゴを出す");
  assert.ok(html.includes(">OpenRouter</h2>"), "未設定でも同じ provider の名前を出す");
  assert.ok(html.includes(">未設定<"), "登録状態は未設定のまま出す");
});

test("対応表に無い provider の見出しは頭文字のタイルへ落とす", () => {
  const html = render({ provider: "faux-image" });
  assert.ok(html.includes(">FI<"), "ロゴが無い provider も名前の頭文字で見分けられる");
  assert.ok(html.includes(">faux-image</h2>"), "知らない provider は id のまま出す");
});

test("設定済みでは上書き保存・削除・モデル選択を出し、保存済みキーを入力欄へ戻さない", () => {
  const html = render();
  assert.ok(html.includes("上書き保存"));
  assert.ok(html.includes(">設定済み<"), "設定済みバッジを出す");
  assert.ok(html.includes(">削除</button>"));
  assert.ok(html.includes("<select"), "モデル選択を出す");
  assert.ok(html.includes('value="openrouter/openai/gpt-image-2"'), "保存済みモデルを選択した状態で出す");
  assert.ok(html.includes("GPT Image 2"));
  assert.ok(html.includes("モデル一覧は OpenRouter から取得しました"), "一覧の出どころを出す");
  assert.ok(
    html.includes(
      'rounded border px-1.5 py-0.5 text-2xs inline-block max-w-full leading-relaxed whitespace-normal border-line text-ink-muted">モデル一覧は OpenRouter から取得しました',
    ),
    "出どころもプロバイダータブと同じチップで出し、狭い幅でも 1 つの枠のまま折り返す",
  );
  assert.match(
    html,
    /<p[^>]*><span class="rounded border[^"]*">モデル一覧は OpenRouter から取得しました/,
    "文をチップにしても段落のセマンティクスを残す",
  );
  assert.ok(
    html.includes(
      "このモデルは生成パラメータを宣言していないため、サイズ・品質・出力形式は provider の既定で生成します",
    ),
    "宣言が無いモデルでは provider の既定で生成することを出す",
  );
  assert.equal(html.includes("プロバイダー: OpenRouter"), false, "見出しと重複する provider 名を本文で繰り返さない");
  assert.ok(html.includes(">カタログ更新</button>"));
  const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(input.includes('value=""'), "保存済みのキーは入力欄へ戻さない");
});

test("取得できていないときは一覧の出どころを警告色のチップで出す", () => {
  const stored = render({ image: { catalogSource: "stored", fetchedAt: 0 } });
  assert.ok(stored.includes("OpenRouter から取得できなかったため、前回の一覧を表示しています"));
  assert.match(stored, /border-warn\/40 text-warn"[^>]*>OpenRouter から取得できなかった/);
  const sdk = render({ image: { catalogSource: "sdk", fetchedAt: null } });
  assert.ok(sdk.includes("SDK の組み込み一覧を表示しています"));
});

test("カタログ更新中はボタンを更新中にする", () => {
  const html = render({ saving: "catalog" });
  assert.ok(html.includes("更新中"), "進行中を出す");
  assert.match(html, /<button[^>]*class="btn-quiet"[^>]*disabled=""[^>]*><[^>]*>.*更新中/s, "連打できないようにする");
});

test("カタログ外の保存済みモデルも選択肢に残す", () => {
  const html = render({ image: { model: "stale/model" } });
  assert.ok(html.includes("stale/model（カタログ外）"), "現在の保存値を選択肢に出す");
  assert.ok(html.includes('value="openrouter/stale/model"'));
  assert.ok(html.includes("Gemini Image"), "カタログの他の候補も失わない");
});

test("選択中の面だけを出し、もう一方の面は描かない", () => {
  const image = render();
  assert.ok(image.includes('aria-label="コンテンツ生成のモデル"'), "画像の面のモデル選択を出す");
  assert.equal(image.includes("読み上げる文章"), false, "音声の保存欄と試行の入力は出さない");
  assert.equal(image.includes('aria-label="音声生成のモデル"'), false, "音声のモデル欄は出さない");
  assert.equal(image.includes("設定に反映しない試行"), true, "画像の試行は画像タブに出す");
  assert.equal(image.includes('aria-label="試行の本文"'), false, "音声の試行の入力は音声タブだけに出す");

  const speech = render({ subsection: "speech" });
  assert.ok(speech.includes("保存される設定"), "音声の保存見出しを出す");
  assert.ok(speech.includes('aria-label="音声生成のモデル"'), "音声の面のモデル選択を出す");
  assert.equal(speech.includes('aria-label="コンテンツ生成のモデル"'), false, "画像のモデル欄は出さない");
  assert.equal(speech.includes("このモデルは生成パラメータを宣言していないため"), false, "画像の説明も出さない");
});

test("設定済みでは音声のモデルとボイスを出し、宣言のあるボイスを選択肢にする", () => {
  const html = render({ subsection: "speech" });
  assert.ok(html.includes("保存される設定"), "音声のセクションを出す");
  assert.ok(html.includes('aria-label="音声生成のモデル"'), "音声モデルの選択を出す");
  assert.ok(html.includes('aria-label="音声生成のボイス"'), "ボイスの選択を出す");
  assert.ok(html.includes('value="google/gemini-3.8-flash-tts"'), "保存済みモデルを選択した状態で出す");
  assert.ok(html.includes('value="Zephyr"'), "保存済みボイスを選択した状態で出す");
  assert.ok(html.includes("Kore（Firm）</option>"), "宣言されている他のボイスも候補に出す");
  assert.ok(html.includes("音声モデル一覧は OpenRouter から取得しました"), "一覧の出どころを出す");
  assert.ok(
    html.includes("出力形式は選ばず、provider が返した形式（mp3 / wav）で保存します"),
    "出力形式の選択を持たない方針を出す",
  );
  assert.ok(html.includes("この画面での成功: 未確認"), "モデル選択の直下に証拠を出す");
});

test("google のモデルでも属性を引ける声が無ければグループを出さない", () => {
  const models = [
    {
      provider: "openrouter",
      id: "google/gemini-3.8-flash-tts",
      name: "Google: Gemini 3.8 Flash TTS",
      voices: ["Ghost"],
    },
  ];
  const html = render({ subsection: "speech", speech: { models, voice: "Ghost" } });
  assert.equal(html.includes("<optgroup"), false, "並べ替える根拠が無い一覧に空のグループを出さない");
  assert.ok(html.includes(">Ghost</option>"), "宣言そのものは選択肢に残す");
});

test("Object.prototype の名前のボイスでも描画を壊さず、未知の声として残す", () => {
  const models = [
    {
      provider: "openrouter",
      id: "google/gemini-3.8-flash-tts",
      name: "Google: Gemini 3.8 Flash TTS",
      voices: ["constructor", "Kore"],
    },
  ];
  const html = render({ subsection: "speech", speech: { models, voice: "Kore" } });
  assert.match(html, /<optgroup label="女性">/, "引ける声だけを正しいグループへ入れる");
  assert.equal(html.includes('<optgroup label="男性">'), false, "空のグループは出さない");
  assert.ok(html.includes("Kore（Firm）</option>"), "引ける声はラベル付きで残す");
  assert.ok(html.includes(">constructor</option>"), "継承プロパティの名前は未知の声として出す");
});

test("宣言が無い音声モデルはボイスを自由記述にし、空欄を許す", () => {
  const html = render({ subsection: "speech", speech: { model: "fish/audio", voice: "my-voice" } });
  assert.ok(html.includes('value="fish/audio"'), "保存済みモデルを選択した状態で出す");
  assert.match(html, /<input[^>]*aria-label="音声生成のボイス"[^>]*value="my-voice"/, "自由記述の入力欄へ切り替える");
  assert.ok(html.includes("モデル既定（空欄のまま送ります）"), "空欄の意味を出す");
});

test("音声カタログ外の保存済みモデルも選択肢に残す", () => {
  const html = render({ subsection: "speech", speech: { model: "stale/tts", voice: "Zephyr" } });
  assert.ok(html.includes("stale/tts（カタログ外）"));
  assert.ok(html.includes('value="stale/tts"'));
});

test("音声カタログも取得できていないときは警告色のチップで出す", () => {
  const html = render({ subsection: "speech", speech: { catalogSource: "default", fetchedAt: null } });
  assert.ok(html.includes("OpenRouter から取得できていないため、同梱の既定の音声モデルを表示しています"));
  assert.match(html, /border-warn\/40 text-warn"[^>]*>OpenRouter から取得できていない/);
});

test("現在の設定を確認できないときは音声を「（未確認）」にして保存させない", () => {
  const html = render({ subsection: "speech", speechSynced: false });
  assert.equal(html.match(/（未確認）/g)?.length, 2, "モデルとボイスの両方を未確認として出す");
  assert.ok(
    html.includes("サーバーから現在の設定を取得できなかったため、表示しているモデルとボイスが最新とは限りません"),
    "同期できていないことを知らせる",
  );
  assert.match(html, /aria-label="音声生成のモデル"[^>]*disabled=""/, "モデルを触らせない");
  assert.match(html, /aria-label="音声生成のボイス"[^>]*disabled=""/, "ボイスを触らせない");
  // 同期できたら未確認の表示は出さない
  const synced = render({ subsection: "speech" });
  assert.equal(synced.includes("（未確認）"), false);
});

test("音声カタログの更新中は音声側のボタンだけを更新中にする", () => {
  const html = render({ subsection: "speech", saving: "speech-catalog" });
  assert.equal(html.match(/更新中/g)?.length, 1, "音声側の 1 つだけを更新中にする");
});

test("平文の注意は既定で畳み、1 行の要点を出す", () => {
  const html = render();
  assert.match(
    html,
    /<summary[^>]*>[\s\S]*キーは暗号化して保存されます。ログインがないため公開しないでください。[\s\S]*<\/summary>/,
    "畳んだ 1 行にキーの保存と公開の注意を出す",
  );
  assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:[\s=>])/, "既定は畳む");
  assert.ok(
    html.includes("登録したキーは暗号化してアプリのデータベース（SQLite）へ保存され"),
    "展開で元の本文を読める",
  );
});

test("runtimeAvailable: false ではキー操作だけを無効化し、モデル変更は残す", () => {
  const html = render({ runtimeAvailable: false });
  assert.ok(html.includes("ランタイムが利用できないため"), "変更できないことを先に伝える");
  assert.match(html, /<input[^>]*type="password"[^>]*disabled=""/, "キー入力を disable する");
  assert.match(html, /<button[^>]*class="btn-quiet"[^>]*disabled=""/, "削除を disable する");
  // モデルの変更は SDK に触れないため、runtime が無くてもサーバーは受け付ける
  assert.doesNotMatch(html, /<select[^>]*disabled=""/, "モデル選択は disable しない");
});

test("runtimeAvailable: false でも音声の選択は残す", () => {
  const html = render({ runtimeAvailable: false, subsection: "speech" });
  assert.ok(html.includes('aria-label="音声生成のモデル"'));
  assert.ok(html.includes('aria-label="音声生成のボイス"'));
});

test("音声セクションの下部に試行の入力を出し、未設定では出さない", () => {
  const html = render({ subsection: "speech" });
  assert.ok(html.includes("設定に反映しない試行"), "設定済みでは常に出す");
  assert.match(html, /<textarea[^>]*aria-label="試行の本文"/, "本文から試せる");
  assert.match(html, /<input[^>]*aria-label="試行の演技指示"/, "演技指示も試せる");
  assert.match(html, /<input[^>]*aria-label="試行の話速"/, "話速も試せる");
  assert.ok(html.includes("試行する"), "試行 API で開始する操作を出す");
  assert.equal(html.includes("お試し再生"), false, "退役したお試し再生の文言は出さない");
  // 保存される設定と試行の入力は別の見出しで分ける
  assert.ok(html.includes("保存される設定"), "保存する側の見出し");
  assert.ok(html.includes("設定に反映しない試行"), "試行の見出し");

  // 未設定でも試行の面は出す（履歴が無くても、画像タブと同じ位置に理由と履歴を出す）
  const unset = render({
    subsection: "speech",
    configured: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.ok(unset.includes("設定に反映しない試行"), "キー保存前も試行の面を出す");
  assert.ok(unset.includes("APIキーが未設定です"), "履歴だけを表示していることを伝える");
});

test("音声の同期が取れていない間も試行は使える（保存のゲートを持ち込まない）", () => {
  const html = render({ subsection: "speech", speechSynced: false });
  // class に `disabled:` が含まれるため、属性としての disabled だけを否定する
  assert.match(html, /<textarea[^>]*aria-label="試行の本文"(?![^>]*\sdisabled=)/, "本文も触れる");
  assert.match(html, /<input[^>]*aria-label="試行の演技指示"(?![^>]*\sdisabled=)/, "演技指示も触れる");
  // 未同期は保存だけを止める。試行の開始を理由にしない（本文が空なので主ボタンは本文の理由で無効）
  assert.equal(html.includes("ランタイムが利用できないため試行できません"), false);
  assert.equal(html.includes("現在の設定を取得できなかった"), true, "未同期はバナーで知らせる");
});

test("runtimeAvailable: false では音声の試行の主ボタンも無効にする", () => {
  const html = render({ runtimeAvailable: false, subsection: "speech" });
  assert.match(
    html,
    /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?試行する/,
    "実行できない試行 API を呼ばせない",
  );
  assert.ok(html.includes("ランタイムが利用できないため試行できません"), "押せない理由を出す");
  // ランタイムがあれば、この理由では止めない（本文が空の理由だけが残る）
  const available = render({ subsection: "speech" });
  assert.equal(available.includes("ランタイムが利用できないため試行できません"), false);
  assert.match(available, /（本文を入力してください）/);
});

test("保存済みでも復号できないキーは、利用不可として理由と削除・再入力を出す", () => {
  const html = render({
    keyStored: true,
    keyAvailable: false,
    keyEvaluated: false,
    keyErrorMessage: "保存済みのキーを復号できるかまだ確認できていません",
  });
  assert.ok(html.includes(">利用不可<"), "復号できないキーを設定済みと出さない");
  assert.ok(html.includes("保存済みのキーを復号できるかまだ確認できていません"), "固定文言をそのまま出す");
  assert.ok(html.includes("上書き保存"), "再入力の導線を残す");
  assert.ok(html.includes(">削除</button>"), "削除の導線を残す");
});

// --- 試行ジョブ（画像） ---

const TRIAL_BASE: ContentTrial = {
  id: "trial-1",
  kind: "image",
  model: "openrouter/openai/gpt-image-2",
  promptPreview: "a cat on a sofa",
  prompt: "a cat on a sofa",
  voice: null,
  instructions: null,
  speed: null,
  parameters: null,
  state: "succeeded",
  keyEpoch: 0,
  artifactState: "stored",
  artifact: { format: "png", bytes: 2_048, width: 1024, height: 1024 },
  charged: true,
  failureCode: null,
  failureMessage: null,
  startedAt: 1_000,
  finishedAt: 12_000,
  durationMs: 11_000,
  recorded: true,
};

test("キー未設定では、結果カードから既定へ保存する導線も押せない", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    trials: [TRIAL_BASE],
  });
  assert.equal(html.includes("保存される設定"), false, "保存フォームは出さない（既存の意図）");
  assert.match(
    html,
    /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?このモデルと設定を既定にする/,
    "保存できないので導線を押せなくする",
  );
  assert.ok(html.includes("APIキーが未設定のため保存できません。"), "押せない理由をその場に出す");
  assert.ok(html.includes("a cat on a sofa"), "履歴と結果の閲覧は残す");
});

test("未設定でも試行の履歴と証拠を出し、新規生成だけを止める", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    trials: [TRIAL_BASE],
  });
  assert.ok(html.includes("設定に反映しない試行"), "試行の面を出す");
  assert.ok(html.includes("a cat on a sofa"), "保存済みの履歴を出す");
  assert.ok(html.includes("APIキーを登録すると試行できます"), "開始できない理由を出す");
  assert.match(html, /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?試行する/, "主ボタンを無効にする");
  assert.equal(html.includes("保存される設定"), false, "未設定では保存される設定を出さない");
  // 証拠はモデル選択の直下に置くため、モデルを選べない未設定では出さない
  assert.equal(html.includes("この画面での最終成功"), false);
});

test("実行中は主ボタンを無効にして中断を出し、証拠と履歴にキー世代を出す", () => {
  const html = render({
    trials: [{ ...TRIAL_BASE, state: "running", finishedAt: null, durationMs: null, keyEpoch: 0 }],
    trialKeyEpoch: 1,
  });
  assert.match(
    html,
    /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?生成中…/,
    "実行中は主ボタンを無効にする",
  );
  assert.match(html, />中断<\/button>/, "中断の導線を出す");
  assert.ok(html.includes("実行中です。完了するか中断してください"), "状態を出す");
  assert.ok(html.includes("旧キー（世代 0）"), "現在のキー世代と混ぜない");
});

test("失敗は分類とマスク済みの文言を出し、全体 OFF でも履歴は残す", () => {
  const html = render({
    enabled: false,
    trials: [
      {
        ...TRIAL_BASE,
        state: "failed",
        failureCode: "invalid_key",
        failureMessage: "画像APIキーが無効です",
      },
    ],
  });
  assert.ok(html.includes("失敗の分類: APIキーが無効"), "分類を出す");
  assert.ok(html.includes("画像APIキーが無効です"), "サーバーの文言をそのまま出す");
  assert.ok(html.includes("全体が OFF のため試行できません（履歴は残ります）"), "理由を出す");
  assert.ok(html.includes("a cat on a sofa"), "OFF でも履歴を読める");
});

test("成功した実績はモデル選択の直下に最終成功として出す", () => {
  const now = Date.now();
  const html = render({
    trials: [{ ...TRIAL_BASE, startedAt: now - 72_400, finishedAt: now - 60_000, durationMs: 12_400 }],
  });
  assert.ok(html.includes("この画面での最終成功: 1 分前（12.4s）"));
  assert.ok(html.includes("チャットの生成は含めません"), "証拠の範囲を書く");
});

test("「保存される設定」と「設定に反映しない試行」は同じ見出しの段と見た目で並ぶ", () => {
  const html = render({ trials: [TRIAL_BASE] });
  const headingClass = (label: string): string => {
    const match = new RegExp(`<h3 class="([^"]*)"[^>]*>${label}</h3>`).exec(html);
    assert.ok(match, `${label} を h3 で出す`);
    return match[1];
  };
  assert.equal(headingClass("保存される設定"), headingClass("設定に反映しない試行"), "見出しの見た目を揃える");
});

test("中止した試行は「中止」と出し、失敗の分類として見せない", () => {
  const html = render({ trials: [{ ...TRIAL_BASE, state: "canceled", failureCode: "aborted" }] });
  assert.match(html, />中止</, "状態は中止");
  assert.equal(html.includes("失敗の分類"), false, "利用者の中止を失敗の分類にしない");
});

test("直近の結果はプレビュー・実寸・形式・サイズ・導線を出し、履歴は専用タブへ案内する", () => {
  const html = render({
    trials: [TRIAL_BASE],
    trialArtifactUsage: { count: 1, bytes: 2_048 },
  });
  // プレビューは trial id の同 origin ルート（blob URL ではない）
  assert.ok(html.includes('src="/api/settings/content/trials/trial-1/raw"'), "プレビューの URL");
  assert.ok(html.includes("PNG · 1024 × 1024 · 2.0 KiB"), "形式・実寸・サイズ");
  assert.ok(html.includes("試行の結果 を拡大表示"), "拡大の導線");
  assert.ok(
    html.includes('href="/api/settings/content/trials/trial-1/raw?download=1"'),
    "ダウンロードは同じ trial id のルート",
  );
  assert.ok(html.includes("履歴を見る"), "履歴は専用タブへ案内する");
  assert.equal(html.includes("入力欄に戻す"), false, "生成タブに入力欄へ戻す導線は置かない");
  assert.equal(html.includes("別のテイクを生成"), false, "生成タブに別テイクの導線は置かない");
  assert.equal(html.includes("モデル絞り込み"), false, "履歴の絞り込みは生成タブに出さない");
});
test("結果を保存していない行（段階 1 の none）は記録のみと出し、ダウンロードを出さない", () => {
  const html = render({
    trials: [{ ...TRIAL_BASE, artifactState: "none", artifact: null, charged: false }],
  });
  assert.ok(html.includes("結果は保存されていません（記録のみ）"), "記録のみを明示する");
  assert.equal(html.includes("/raw"), false, "配信 URL を出さない");
  assert.equal(html.includes(">ダウンロード</a>"), false, "ダウンロードを出さない");
});

test("保存できなかった成功は課金済みを明示し、成功として見せない", () => {
  const html = render({
    trials: [
      {
        ...TRIAL_BASE,
        state: "failed",
        failureCode: "storage",
        failureMessage:
          "生成は完了しましたが、結果を保存できませんでした（課金済み）。もう一度生成すると再課金されます",
        artifactState: "none",
        artifact: null,
        charged: true,
      },
    ],
  });
  assert.ok(html.includes(">失敗<"), "成功として見せない");
  assert.ok(html.includes("失敗の分類: 結果を保存できない"), "storage の分類を出す");
  assert.ok(html.includes("生成は課金されています。もう一度生成すると再課金されます。"), "課金済みを明示する");
  assert.equal(html.includes("/raw"), false);
});

test("履歴の詳細は「もう一度生成」を出し、確認のうえ課金されることを添える", () => {
  const html = render({ subsection: "history", trials: [TRIAL_BASE] });
  assert.ok(html.includes("もう一度生成"), "履歴からは新しい試行を始められる");
  assert.ok(html.includes("もう一度生成は確認のうえ新しい試行として課金されます。"), "課金の注記");
  assert.ok(html.includes("この内容で編集"), "入力欄へ戻す導線");
  // 保存済みが無い（失敗した）行も同じ
  const fresh = render({
    subsection: "history",
    trials: [{ ...TRIAL_BASE, state: "failed", failureCode: "timeout", artifactState: "none", artifact: null }],
  });
  assert.ok(fresh.includes("もう一度生成は確認のうえ新しい試行として課金されます。"));
});
test("結果のモデルが保存値と違うときだけ、このモデルと設定を既定にする導線を出す", () => {
  const button = "このモデルと設定を既定にする";
  const other = render({ trials: [{ ...TRIAL_BASE, model: "openrouter/google/gemini-image" }] });
  assert.ok(other.includes(button), "別モデルで試した結果からは既定にできる");

  const same = render({ trials: [TRIAL_BASE] });
  assert.equal(same.includes(button), false, "保存値と同じモデルでは出さない");

  // 保存後は保存値が試行のモデルになり、下書きを捨てた状態（初期値）では未保存も出ない
  const saved = render({
    image: { model: "google/gemini-image" },
    trials: [{ ...TRIAL_BASE, model: "openrouter/google/gemini-image" }],
  });
  assert.equal(saved.includes(button), false, "保存できたら導線を消す");
  assert.equal(saved.includes("未保存"), false, "未保存扱いを残さない");

  const outside = render({ trials: [{ ...TRIAL_BASE, model: "openrouter/unknown/image" }] });
  assert.equal(outside.includes(button), false, "保存の本文を作れないモデルでは出さない");
});

test("実行中の行は送信時のプロンプトを表示し、入力欄の下書きとは混ぜない", () => {
  const html = render({
    trials: [
      {
        ...TRIAL_BASE,
        state: "running",
        prompt: "submitted prompt",
        promptPreview: "submitted prompt",
        finishedAt: null,
        durationMs: null,
        artifactState: "none",
        artifact: null,
        charged: false,
      },
    ],
  });
  assert.ok(html.includes("submitted prompt"), "送信時のプロンプトを結果に出す");
  assert.ok(html.includes("生成中です。送信したプロンプトを表示しています"), "スナップショットであることを書く");
  assert.equal(html.includes("/raw"), false, "実行中はプレビューを出さない");
});

test("試行の注記は試行の面の中に出す（設定の注記行とは別）", () => {
  const html = render({ trials: [TRIAL_BASE], trialNote: { text: "試行の履歴を削除しました。", error: false } });
  assert.ok(html.includes("試行の履歴を削除しました。"), "試行の注記を出す");
  const error = render({
    trials: [TRIAL_BASE],
    trialNote: { text: "試行の履歴を取得できませんでした。", error: true },
  });
  assert.ok(error.includes("試行の履歴を取得できませんでした。"), "取得失敗も同じ行に出す");
  // 注記が無ければ空行を作らない
  const none = render({ trials: [TRIAL_BASE] });
  assert.equal(none.includes("試行の履歴を削除しました。"), false);
});

// --- 試行ジョブ（音声） ---

const SPEECH_TRIAL_BASE: ContentTrial = {
  id: "trial-speech-1",
  kind: "speech",
  model: "google/gemini-3.8-flash-tts",
  promptPreview: "おはようございます",
  prompt: "おはようございます",
  voice: "Aoede",
  instructions: "落ち着いた声で",
  speed: 1.1,
  parameters: null,
  state: "succeeded",
  keyEpoch: 0,
  artifactState: "stored",
  artifact: { format: "mp3", bytes: 4_096, width: null, height: null },
  charged: true,
  failureCode: null,
  failureMessage: null,
  startedAt: 1_000,
  finishedAt: 12_000,
  durationMs: 11_000,
  recorded: true,
};

test("音声の直近の結果はプレイヤー・snapshot・ボイスを出す", () => {
  const html = render({ subsection: "speech", trials: [SPEECH_TRIAL_BASE] });
  // 再生は trial id の同 origin ルート（blob URL ではない）
  assert.match(html, /<audio[^>]*src="\/api\/settings\/content\/trials\/trial-speech-1\/raw"/);
  assert.ok(html.includes("おはようございます"), "送った本文を出す");
  assert.ok(html.includes("演技指示: 読み込み中… · 話速: 1.1 倍"), "全文を取れるまでは送信時の話速を出す");
  assert.ok(html.includes("ボイス: Aoede"), "送ったボイスを出す");
  assert.ok(html.includes("MP3 · 4.0 KiB"), "形式とサイズを出す");
  assert.ok(
    html.includes('href="/api/settings/content/trials/trial-speech-1/raw?download=1"'),
    "ダウンロードは同じルート",
  );
  assert.ok(html.includes("履歴を見る"), "履歴は専用タブへ案内する");
  assert.equal(html.includes("入力欄に戻す"), false, "生成タブに入力欄へ戻す導線は置かない");
  assert.equal(html.includes("別のテイクを生成"), false, "生成タブに別テイクの導線は置かない");
});
test("音声は結果のモデルとボイスが保存値と違うときだけ、このモデルとボイスを既定にする導線を出す", () => {
  const button = "このモデルとボイスを既定にする";
  // 保存値は Zephyr、試行は Aoede
  const voiceDiff = render({ subsection: "speech", trials: [SPEECH_TRIAL_BASE] });
  assert.ok(voiceDiff.includes(button), "ボイスだけ違っても既定にできる");

  const same = render({ subsection: "speech", speech: { voice: "Aoede" }, trials: [SPEECH_TRIAL_BASE] });
  assert.equal(same.includes(button), false, "モデルもボイスも同じなら出さない");

  const saved = render({
    subsection: "speech",
    speech: { model: "google/gemini-3.8-flash-tts", voice: "Aoede" },
    trials: [SPEECH_TRIAL_BASE],
  });
  assert.equal(saved.includes(button), false, "保存できたら導線を消す");
  assert.equal(saved.includes("未保存"), false, "未保存扱いを残さない");

  const modelDiff = render({
    subsection: "speech",
    speech: { model: "fish/audio", voice: "Aoede" },
    trials: [SPEECH_TRIAL_BASE],
  });
  assert.ok(modelDiff.includes(button), "モデルが違えば既定にできる");
});

test("音声の設定を確認できない間は、結果カードからの既定の保存も止めて理由を出す", () => {
  const blocked = render({ subsection: "speech", speechSynced: false, trials: [SPEECH_TRIAL_BASE] });
  assert.match(
    blocked,
    /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?このモデルとボイスを既定にする/,
    "保存フォームと同じく押せなくする",
  );
  assert.ok(
    blocked.includes("サーバーの現在の設定を確認できていないため、再読み込みするまで保存できません。"),
    "押せない理由を出す",
  );

  const allowed = render({ subsection: "speech", trials: [SPEECH_TRIAL_BASE] });
  assert.equal(allowed.includes("サーバーの現在の設定を確認できていないため"), false, "同期できていれば理由を出さない");
  assert.equal(
    allowed.includes("APIキーが未設定のため保存できません。"),
    false,
    "設定済みではキー未設定の理由を出さない",
  );
});

test("音声の実行中はプレイヤーを出さず、状態だけを示す", () => {
  const html = render({
    subsection: "speech",
    trials: [
      {
        ...SPEECH_TRIAL_BASE,
        state: "running",
        finishedAt: null,
        durationMs: null,
        artifactState: "none",
        artifact: null,
        charged: false,
      },
    ],
  });
  assert.equal(html.includes("/raw"), false, "実行中は再生を出さない");
  assert.ok(html.includes("生成中です。送信した本文を表示しています"));
  assert.match(html, /<button[^>]*>中断<\/button>/, "実行中は中断を出す");
});

test("音声の保存に失敗した成功は課金済みとして出し、記録のみの行は再生させない", () => {
  const failed = render({
    subsection: "speech",
    trials: [
      {
        ...SPEECH_TRIAL_BASE,
        state: "failed",
        artifactState: "none",
        artifact: null,
        charged: true,
        failureCode: "storage",
        failureMessage: "生成は完了しましたが、結果を保存できませんでした（課金済み）。",
      },
    ],
  });
  assert.ok(failed.includes("結果を保存できない"));
  assert.ok(failed.includes("生成は課金されています"));
  assert.equal(failed.includes("<audio"), false, "成果物の無い行は再生しない");
});

test("画像と音声の履歴は互いの面に出さない", () => {
  const image = render({ trials: [SPEECH_TRIAL_BASE] });
  assert.equal(image.includes("おはようございます"), false, "音声の履歴は画像タブに混ぜない");
  const speech = render({ subsection: "speech", trials: [TRIAL_BASE] });
  assert.equal(speech.includes("a cat on a sofa"), false, "画像の履歴は音声タブに混ぜない");
});

// --- 試行ジョブ（画像の生成パラメータ） ---
// 入力から要求への変換（宣言外の値の除去・seed の検証）と、履歴から下書きへの復元は
// lib/contentTrials の純関数テスト（contentTrials.test.ts）が見る。ここは描画の出し分けだけを固定する。

/** 宣言を持つ画像モデル。入力欄・チップ・履歴の行を出す条件を作る */
const DECLARING_MODELS: ContentImageSettings["models"] = [
  {
    provider: "openrouter",
    id: "openai/gpt-image-2",
    name: "GPT Image 2",
    parameters: {
      aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
      seed: { type: "range", min: 0, max: 1_000 },
    },
  },
];

test("画像の試行の入力はモデルの宣言に応じて出し、宣言が無いパラメータは欄にしない", () => {
  const declared = render({ image: { models: DECLARING_MODELS } });
  assert.match(declared, /aria-label="試行の aspect_ratio"/, "enum は選択欄にする");
  assert.ok(declared.includes(">16:9</option>"), "宣言された値を候補にする");
  assert.match(declared, /<input[^>]*type="number"[^>]*aria-label="試行の seed"/, "seed は整数入力にする");
  assert.ok(declared.includes("モデル既定（provider）"), "先頭の選択肢と入力の案内に未指定を出す");
  assert.equal(declared.includes('aria-label="試行の quality"'), false, "宣言の無いパラメータは欄にしない");
  assert.ok(declared.includes("指定できるパラメータ: aspect_ratio / seed"), "宣言に応じた説明を出す");

  // 宣言が読めないモデル（SDK 同梱・旧キャッシュ）では欄を出さず、不明を既定として見せない
  const undeclared = render();
  assert.equal(undeclared.includes('aria-label="試行の aspect_ratio"'), false);
  assert.equal(undeclared.includes('aria-label="試行の seed"'), false);
});

test("画像のモデルの下に、宣言に応じた既定のパラメータを出し、保存済みの値を選んだ状態にする", () => {
  const html = render({
    image: { models: DECLARING_MODELS, parametersByModel: { "openai/gpt-image-2": { aspect_ratio: "1:1", seed: 7 } } },
  });
  assert.match(html, /aria-label="既定の aspect_ratio"/, "enum は選択欄にする");
  assert.ok(html.includes("既定なし（provider 既定）"), "未指定の選択肢を出す");
  assert.match(html, /<input[^>]*type="number"[^>]*aria-label="既定の seed"[^>]*value="7"/, "保存済みの seed を出す");
  assert.ok(html.includes(">1:1</option>"), "保存済みの enum を候補にする");
  assert.ok(html.includes("既定を解除"), "既定の解除の導線を出す");
  assert.ok(html.includes("generate_image の引数を省略したときに使います"), "保存した既定がいつ使われるかを書く");

  // 宣言が読めないモデル（SDK 同梱・旧キャッシュ）では欄を出さず、不明を既定として見せない
  const undeclared = render();
  assert.equal(undeclared.includes('aria-label="既定の aspect_ratio"'), false);
  assert.equal(undeclared.includes('aria-label="既定の seed"'), false);
});

test("[既定を解除] は保存済みの既定が無ければ押せず、あるときだけ押せる", () => {
  const none = render({ image: { models: DECLARING_MODELS } });
  assert.match(none, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?既定を解除/, "消す既定が無ければ押せない");
  const saved = render({
    image: { models: DECLARING_MODELS, parametersByModel: { "openai/gpt-image-2": { seed: 7 } } },
  });
  assert.match(saved, /<button[^>]*(?<!disabled="")>(?:(?!<\/button>)[\s\S])*?既定を解除/, "保存済みなら押せる");
});

test("保存していない既定の変更が無ければ [保存] は押せない（モデルと同じ差分だけで見ない判定を揃える）", () => {
  const html = render({
    image: { models: DECLARING_MODELS, parametersByModel: { "openai/gpt-image-2": { seed: 7 } } },
  });
  assert.match(
    html,
    /<button[^>]*class="btn-primary"[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?保存/,
    "差が無ければ押せない",
  );
  assert.equal(html.includes("未保存"), false, "保存値のままなら未保存を出さない");
});

test("結果カードのチップは要約のパラメータの明示値だけで、未指定は出さない", () => {
  const declared = render({
    image: { models: DECLARING_MODELS },
    trials: [{ ...TRIAL_BASE, parameters: { aspect_ratio: "16:9" } }],
  });
  assert.ok(declared.includes("aspect_ratio=16:9"), "明示した値だけをチップにする");
  assert.equal(declared.includes("seed="), false, "未指定はチップにしない");

  const none = render({ image: { models: DECLARING_MODELS }, trials: [TRIAL_BASE] });
  assert.equal(none.includes("aspect_ratio="), false, "未指定の行はチップを出さない");
});

test("履歴の詳細は宣言に応じた全行を出し、未指定はモデル既定（provider）と表示する", () => {
  const html = render({
    subsection: "history",
    image: { models: DECLARING_MODELS },
    trials: [{ ...TRIAL_BASE, parameters: { seed: 7 } }],
  });
  assert.ok(html.includes(">aspect_ratio<"), "宣言にあるキーの行を出す");
  assert.ok(html.includes(">seed<"), "送った値のあるキーの行を出す");
  assert.ok(html.includes(">7<"), "送った値はスナップショットをそのまま出す");
  assert.ok(html.includes("モデル既定（provider）"), "未指定はモデル既定として書く");
  assert.equal(html.includes(">quality<"), false, "宣言に無いキーの行は出さない");
});

test("キー未設定では、音声の結果カードから既定へ保存する導線も押せない", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    subsection: "speech",
    trials: [SPEECH_TRIAL_BASE],
  });
  assert.match(
    html,
    /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?このモデルとボイスを既定にする/,
    "保存できないので導線を押せなくする",
  );
  assert.ok(html.includes("APIキーが未設定のため保存できません。"), "押せない理由をその場に出す");
  assert.match(html, /<audio[^>]*src="\/api\/settings\/content\/trials\/trial-speech-1\/raw"/, "再生は未設定でも残す");
});

test("キー未設定でも音声の試行の履歴と再生を出し、新規生成だけを止める", () => {
  const html = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    subsection: "speech",
    trials: [SPEECH_TRIAL_BASE],
  });
  assert.ok(html.includes("設定に反映しない試行"), "試行の面は未設定でも出す");
  assert.ok(html.includes("おはようございます"), "保存済みの履歴を出す");
  assert.ok(html.includes("ボイス: Aoede"), "履歴の行にボイスを出す");
  assert.match(
    html,
    /<audio[^>]*src="\/api\/settings\/content\/trials\/trial-speech-1\/raw"/,
    "再生（raw 配信）も未設定で使える",
  );
  assert.ok(html.includes("APIキーを登録すると試行できます"), "開始できない理由を出す");
  assert.equal(html.includes('aria-label="音声生成のモデル"'), false, "保存される設定は出さない");
  assert.equal(html.includes('aria-label="音声生成のボイス"'), false, "保存されるボイス欄も出さない");
});

const BGM_TRIAL_BASE: ContentTrial = {
  id: "trial-bgm-1",
  kind: "bgm",
  model: "google/lyria-3-clip-preview",
  promptPreview: "夜の高速道路を走る軽快なシンセポップ",
  prompt: "夜の高速道路を走る軽快なシンセポップ",
  voice: null,
  instructions: null,
  speed: null,
  parameters: null,
  state: "succeeded",
  keyEpoch: 0,
  artifactState: "stored",
  artifact: { format: "mp3", bytes: 6_144, width: null, height: null },
  charged: true,
  failureCode: null,
  failureMessage: null,
  startedAt: 1_000,
  finishedAt: 12_000,
  durationMs: 11_000,
  recorded: true,
};

test("BGM の面は固定モデルと試行の入力・再生を出し、モデル選択と長さの指定は出さない", () => {
  const html = render({ subsection: "bgm", trials: [BGM_TRIAL_BASE] });
  // 保存される設定はモデルの読取専用 1 行だけ（Issue の非ゴール: モデル選択を持たない）
  assert.match(html, /aria-label="BGM生成の固定モデル"[^>]*readOnly=""/);
  assert.equal((html.match(/<select/g) ?? []).length, 0, "生成タブに履歴の絞り込みを出さない");
  // 尺・BPM・ループの入力は持たない（注記で「保証しない」と伝えるだけ）
  assert.equal(/aria-label="[^"]*(BPM|ループ|尺|長さ)/.test(html), false, "長さの指定は出さない");
  assert.ok(html.includes("正確なBPMや尺・シームレスループは保証しません"), "保証しない旨は残す");
  // 試行の面
  assert.match(html, /<textarea[^>]*aria-label="試行のプロンプト"/, "プロンプトから試せる");
  assert.ok(html.includes("課金される可能性"), "失敗しても課金される旨を残す");
  assert.ok(html.includes("試行する"));
  // 結果ビューポート（プレイヤー・固定モデル・目安尺・実測尺・導線）
  assert.match(html, /<audio[^>]*src="\/api\/settings\/content\/trials\/trial-bgm-1\/raw"/);
  assert.ok(html.includes("google/lyria-3-clip-preview"), "固定モデルを出す");
  assert.ok(html.includes("モデル仕様の目安: 30 秒"), "目安尺を出す");
  assert.ok(html.includes("実測: —"), "実測尺はブラウザーが読むまで出さない");
  assert.ok(html.includes("MP3 · 6.0 KiB"));
  assert.ok(html.includes('href="/api/settings/content/trials/trial-bgm-1/raw?download=1"'));
  assert.ok(html.includes("履歴を見る"), "履歴は専用タブへ案内する");
  assert.equal(html.includes("入力欄に戻す"), false, "生成タブに入力欄へ戻す導線は置かない");
  assert.equal(html.includes("別のテイクを生成"), false, "生成タブに別テイクの導線は置かない");
});
test("履歴の詳細は BGM も同じプロンプトで再生成できる", () => {
  const html = render({ subsection: "history", trials: [BGM_TRIAL_BASE] });
  assert.ok(html.includes("もう一度生成"), "履歴の詳細に再生成を出す");
  assert.ok(html.includes("夜の高速道路を走る軽快なシンセポップ"), "送ったプロンプトを出す");
  // 実行中の行は再生成も削除もできない（種別ごとに同時 1 本）
  const running = render({
    subsection: "history",
    trials: [{ ...BGM_TRIAL_BASE, state: "running", artifactState: "none", artifact: null, charged: false }],
  });
  assert.match(running, /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?もう一度生成/);
  assert.ok(running.includes("生成中です。送信したプロンプトを表示しています"));
});
test("BGM の面はキー未設定・全体 OFF でも履歴と再生を残し、新規生成だけを止める", () => {
  for (const overrides of [
    { configured: false, keyStored: false, keyAvailable: false, provider: null, image: { model: null } },
    { enabled: false },
  ]) {
    const html = render({ ...overrides, subsection: "bgm", trials: [BGM_TRIAL_BASE] });
    assert.ok(html.includes("設定に反映しない試行"), "試行の面は残す");
    assert.match(html, /<audio[^>]*src="\/api\/settings\/content\/trials\/trial-bgm-1\/raw"/, "再生も残す");
    assert.match(html, /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?試行する/, "新規生成は止める");
  }
  const unset = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    subsection: "bgm",
  });
  assert.ok(unset.includes("APIキーが未設定です"), "未設定では履歴だけを見ていることを伝える");
  assert.equal(unset.includes('aria-label="BGM生成の固定モデル"'), false, "保存される設定は出さない");
});

test("履歴タブは画像・音声・BGM を 1 本の一覧にまとめて出す", () => {
  const html = render({ subsection: "history", trials: [TRIAL_BASE, SPEECH_TRIAL_BASE, BGM_TRIAL_BASE] });
  assert.ok(html.includes("a cat on a sofa"), "画像の履歴を出す");
  assert.ok(html.includes("おはようございます"), "音声の履歴を出す");
  assert.ok(html.includes("夜の高速道路を走る軽快なシンセポップ"), "BGM の履歴を出す");
  assert.ok(html.includes(">画像<"), "種別の列を出す");
  assert.ok(html.includes(">音声<"), "種別の列を出す");
  assert.ok(html.includes(">BGM<"), "種別の列を出す");
  // 生成タブは自分の種別だけを出す
  const image = render({ trials: [BGM_TRIAL_BASE] });
  assert.equal(image.includes("夜の高速道路を走る軽快なシンセポップ"), false, "BGM の履歴を画像タブに混ぜない");
});
test("保存見出し・試行の見出し・保存容量・課金の注記は 3 タブで同じ文言にする", () => {
  // 音声だけ見出しが `div` の「音声（TTS）」で、保存容量の注記と中断課金の注記もタブごとに違っていた
  const cases = [
    { subsection: "image" as const, trial: TRIAL_BASE, bytes: 2_048, size: "2.0 KiB" },
    { subsection: "speech" as const, trial: SPEECH_TRIAL_BASE, bytes: 4_096, size: "4.0 KiB" },
    { subsection: "bgm" as const, trial: BGM_TRIAL_BASE, bytes: 6_144, size: "6.0 KiB" },
  ];
  for (const { subsection, trial, bytes, size } of cases) {
    const html = render({ subsection, trials: [trial], trialArtifactUsage: { count: 1, bytes } });
    assert.match(html, /<h3[^>]*>保存される設定<\/h3>/, `${subsection}: 保存する側は h3 の「保存される設定」`);
    assert.match(html, /<h3[^>]*>設定に反映しない試行<\/h3>/, `${subsection}: 試行は h3 の「設定に反映しない試行」`);
    assert.ok(
      html.includes(`保存容量: 保存済みの成果物 1 件 · ${size}（履歴の件数ではありません。画像・音声・BGM で共通）`),
      `${subsection}: 容量は 3 タブの合計で、件数が履歴の件数ではないと書く`,
    );
    assert.ok(
      html.includes("失敗・中断・タイムアウトでも課金される可能性があります（自動では再生成しません）。"),
      `${subsection}: 中断・タイムアウトの課金を面ごとに省かない`,
    );
  }
});

test("履歴が 0 件でも 3 タブに保存容量を出し、履歴の見出しと絞り込みは出さない", () => {
  // 容量は 3 タブの合計で、履歴の有無とは別に読める必要がある（新規ストアでは 0 件から始まる）
  for (const subsection of ["image", "speech", "bgm"] as const) {
    const html = render({ subsection, trials: [] });
    assert.ok(
      html.includes("保存容量: 保存済みの成果物 0 件 · 0 B（履歴の件数ではありません。画像・音声・BGM で共通）"),
      `${subsection}: 0 件でも容量を出す`,
    );
    assert.equal(html.includes("保存容量が目安"), false, `${subsection}: 警告が無ければ容量の警告を出さない`);
    assert.ok(html.includes("まだ試行の履歴はありません。"), `${subsection}: 空の案内と重ねて出す`);
    assert.equal(html.includes("履歴（"), false, `${subsection}: 履歴が無ければ件数の見出しは出さない`);
    assert.equal(html.includes("履歴の成功失敗の絞り込み"), false, `${subsection}: 絞り込みも出さない`);
  }
});

test("保存容量の警告は 3 タブ同じ文言で出し、しきい値は一覧の応答の値を使う", () => {
  const warning = { thresholdBytes: 1024 ** 3, warning: true };
  for (const subsection of ["image", "speech", "bgm"] as const) {
    const html = render({ subsection, trials: [], trialArtifactWarning: warning });
    assert.ok(
      html.includes("保存容量が目安（1.0 GiB）を超えています。"),
      `${subsection}: 警告の文言と色を面ごとに書き分けない`,
    );
    // しきい値は server の定数が正で、画面は応答の値をそのまま出す
    assert.ok(
      render({
        subsection,
        trials: [],
        trialArtifactWarning: { thresholdBytes: 512 * 1024 ** 2, warning: true },
      }).includes("512.0 MiB"),
      `${subsection}: 応答のしきい値を出す`,
    );
  }
});

test("BGM の試行の面には実 API 受入済みのため「試験的」を出さない", () => {
  const bgm = render({ subsection: "bgm", trials: [BGM_TRIAL_BASE] });
  assert.equal(bgm.includes("試験的"), false, "受入済みなので試験的を出さない");
  assert.equal(bgm.includes("実プロバイダー（Lyria）での受入が済んでいません"), false);

  const unset = render({
    configured: false,
    keyStored: false,
    keyAvailable: false,
    provider: null,
    image: { model: null },
    subsection: "bgm",
  });
  assert.equal(unset.includes("試験的"), false, "未設定の履歴表示でも出さない");
});

test("履歴の一覧は本文の抜粋を出し、詳細は全文を出す", () => {
  const short: ContentTrial = { ...TRIAL_BASE, promptPreview: "a cat on a sofa…" };
  const long: ContentTrial = { ...short, prompt: "a cat on a sofa with a long tail and a red collar" };
  // 全文を取得できていない間は抜粋だけを出す（全文を捏造しない）
  const loading = render({ subsection: "history", trials: [short], trialDetail: null });
  assert.ok(loading.includes("a cat on a sofa…"));
  assert.equal(loading.includes("with a long tail"), false);
  // 全文を取得できたら、詳細は全文を出す
  const loaded = render({ subsection: "history", trials: [short], trialDetail: long });
  assert.ok(loaded.includes("with a long tail"), "全文を出す");
});
test("履歴に続きのページがあるときだけ「さらに読み込む」を出す", () => {
  const without = render({ subsection: "history", trials: [TRIAL_BASE] });
  assert.equal(without.includes("さらに読み込む"), false);
  const withMore = render({ subsection: "history", trials: [TRIAL_BASE], trialHasMore: true });
  assert.ok(withMore.includes("さらに読み込む"), "続きがあることを出す");
});

// --- 画像の生成元（OpenRouter / Codex） ---

test("生成元の radio を出し、Codex ではAPIキー欄とモデル一覧を出さない", () => {
  const codex = render({
    image: { provider: "codex", auth: { state: "configured", kind: "oauth" }, models: [] },
  });
  assert.match(codex, /画像の生成元/, "生成元の見出しを出す");
  assert.match(codex, /<input type="radio"[^>]*checked=""[^>]*value="codex"/, "Codex を選択済みで出す");
  assert.match(codex, /type="radio"[^>]*value="openrouter"/, "OpenRouter も選べる");
  assert.equal(codex.includes('type="password"'), false, "Codex ではAPIキー欄を出さない");
  assert.equal(codex.includes('aria-label="コンテンツ生成のモデル"'), false, "Codex ではモデル一覧を出さない");
  assert.ok(codex.includes("Codex（画像モデル不明）"), "画像モデルを偽らない");
  assert.ok(codex.includes("音声 / BGM は OpenRouter のAPIキーで生成します"), "音声 / BGM の前提を明示する");

  const openrouter = render();
  assert.ok(openrouter.includes('type="password"'), "OpenRouter ではAPIキー欄を出す");
  assert.ok(openrouter.includes('aria-label="コンテンツ生成のモデル"'), "OpenRouter ではモデル一覧を出す");
});

test("Codex のサインインが無いときは案内を出し、試行は押せない理由として出す", () => {
  const html = render({
    image: { provider: "codex", auth: { state: "missing", kind: null }, models: [] },
  });
  assert.ok(html.includes("openai-codex にサインイン"), "サインインの案内を出す");
  assert.ok(html.includes("APIキーは不要"), "キー登録を促さない");
  assert.ok(html.includes("Codex はチャットからのみ生成できます"), "試行が使えない理由を出す");
  // 未設定（キーの行が無い）でも生成元は選べる
  const unconfigured = render({ configured: false });
  assert.match(unconfigured, /画像の生成元/, "キー未設定でも生成元を選べる");
});

test("Codex の認証が切れているときは再サインインを案内する", () => {
  const html = render({
    image: { provider: "codex", auth: { state: "expired", kind: "oauth" }, models: [] },
  });
  assert.ok(html.includes("期限が切れています"));
  assert.ok(html.includes("/settings/models"));
});

test("画像タブで Codex を選んでも「保存される設定」に BGM の固定モデルを出さない", () => {
  // 画像タブの分岐が else で BGM の面へ落ちると、画像の生成元が Codex のときだけ BGM の欄が出ていた
  const codex = render({
    image: { provider: "codex", auth: { state: "configured", kind: "oauth" }, models: [] },
  });
  assert.equal(codex.includes('aria-label="BGM生成の固定モデル"'), false, "画像タブに BGM の保存される設定を出さない");
  assert.equal(codex.includes('aria-label="音声生成のモデル"'), false, "画像タブに音声の設定を出さない");
  // 画像の設定そのものは OpenRouter のときだけ出る（Codex では何も出さない）
  assert.equal(codex.includes('aria-label="コンテンツ生成のモデル"'), false);
  assert.ok(render().includes('aria-label="コンテンツ生成のモデル"'), "OpenRouter では画像モデルを出す");
  // 音声 / BGM のタブは従来どおりそれぞれの設定を出す
  assert.ok(render({ subsection: "bgm" }).includes('aria-label="BGM生成の固定モデル"'));
  assert.match(render({ subsection: "speech" }), /aria-label="音声生成のモデル"/);
});
