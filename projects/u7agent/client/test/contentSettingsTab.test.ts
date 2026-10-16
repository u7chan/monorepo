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
import type { ContentImageSettings, ContentSettingsResponse, ContentSpeechSettings } from "../src/types";

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
    runtimeAvailable: true,
    image: { model: "openai/gpt-image-2", models: MODELS, catalogSource: "live", fetchedAt: null, ...image },
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
        onSaveKey: async () => true,
        onDeleteKey: async () => true,
        onSaveSelection: async () => true,
        onRefreshCatalog: async () => true,
        onSaveSpeech: async () => true,
        onRefreshSpeechCatalog: async () => true,
        onPreviewSpeech: async () => ({ blob: new Blob(), format: "mp3" as const }),
        speechSynced: options.speechSynced ?? true,
      }),
    ),
  );
}

test("未設定ではキー入力だけを出し、モデル選択と削除は出さない", () => {
  const html = render({
    configured: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.ok(html.includes('type="password"'), "キー入力を出す");
  assert.match(html, /<input[^>]*(?:autoComplete|autocomplete)="off"/, "再表示しない前提なので autocomplete を切る");
  assert.ok(
    html.includes("OpenRouter のコンテンツ生成（画像 / 音声）で共有するキーです"),
    "どの provider のキーかと、別管理であることを出す",
  );
  assert.equal(html.includes("画像生成専用のキー"), false, "音声と共有するため画像専用とは書かない");
  assert.ok(html.includes(">未設定<"), "未設定バッジを出す");
  assert.equal(html.includes("設定済み"), false, "未設定では設定済みと言わない");
  assert.equal(html.includes("<select"), false, "モデル選択はキー保存後にだけ出す");
  assert.equal(html.includes(">削除</button>"), false, "削除もキー保存後にだけ出す");
  assert.equal(html.includes(">カタログ更新</button>"), false, "カタログ更新もモデル欄と同じくキー保存後にだけ出す");
  assert.equal(html.includes("音声（TTS）"), false, "音声の欄もキー保存後にだけ出す");
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
  assert.ok(html.includes("サイズ・品質・出力形式は provider の既定を使います"), "設定できる範囲の説明を残す");
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
  assert.equal(image.includes("音声（TTS）"), false, "音声（TTS）の小見出しは出さない");
  assert.equal(image.includes('aria-label="音声生成のモデル"'), false, "音声のモデル欄は出さない");
  assert.equal(image.includes("お試し再生"), false, "お試し再生も音声タブの中だけに出す");

  const speech = render({ subsection: "speech" });
  assert.ok(speech.includes("音声（TTS）"), "音声の小見出しを出す");
  assert.ok(speech.includes('aria-label="音声生成のモデル"'), "音声の面のモデル選択を出す");
  assert.equal(speech.includes('aria-label="コンテンツ生成のモデル"'), false, "画像のモデル欄は出さない");
  assert.equal(speech.includes("サイズ・品質・出力形式は provider の既定を使います"), false, "画像の説明も出さない");
});

test("設定済みでは音声のモデルとボイスを出し、宣言のあるボイスを選択肢にする", () => {
  const html = render({ subsection: "speech" });
  assert.ok(html.includes("音声（TTS）"), "音声のセクションを出す");
  assert.ok(html.includes('aria-label="音声生成のモデル"'), "音声モデルの選択を出す");
  assert.ok(html.includes('aria-label="音声生成のボイス"'), "ボイスの選択を出す");
  assert.ok(html.includes('value="google/gemini-3.8-flash-tts"'), "保存済みモデルを選択した状態で出す");
  assert.ok(html.includes('value="Zephyr"'), "保存済みボイスを選択した状態で出す");
  assert.ok(html.includes("Kore（Firm）</option>"), "宣言されている他のボイスも候補に出す");
  assert.ok(html.includes("音声モデル一覧は OpenRouter から取得しました"), "一覧の出どころを出す");
  assert.ok(
    html.includes("出力形式はモデルに合わせて mp3 / wav で保存します"),
    "出力形式と演技指示を書かせない方針を出す",
  );
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
  assert.ok(
    html.includes("こんにちは、stale/ttsです！よろしくお願いします。"),
    "名前が無いモデルは id をテンプレへ入れる",
  );
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
    /<summary[^>]*>[\s\S]*キーは平文で保存されます。ログインがないため公開しないでください。[\s\S]*<\/summary>/,
    "畳んだ 1 行にキーの保存と公開の注意を出す",
  );
  assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:[\s=>])/, "既定は畳む");
  assert.ok(html.includes("登録したキーはアプリのデータベース（SQLite）へ平文で保存され"), "展開で元の本文を読める");
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

test("音声セクションの下部にお試し再生を出し、未設定では出さない", () => {
  const html = render({ subsection: "speech" });
  assert.ok(html.includes("お試し再生"), "設定済みでは常に出す");
  assert.match(html, /<textarea[^>]*aria-label="お試し再生の本文"/, "本文から試せる");
  assert.ok(
    html.includes("こんにちは、Gemini 3.8 Flash TTSです！よろしくお願いします。"),
    "本文の初期値に、保存済みモデル名（接頭辞を落としたもの）入りのテンプレを入れる",
  );
  assert.match(html, /<button[^>]*>音声を生成<\/button>/, "その場で鳴らす操作を出す");

  const unset = render({
    configured: false,
    provider: null,
    image: { model: null, catalogSource: "sdk", fetchedAt: null },
  });
  assert.equal(unset.includes("お試し再生"), false, "キー保存前は出さない");
});

test("音声の同期が取れていない間もお試し再生は使える", () => {
  const html = render({ subsection: "speech", speechSynced: false });
  assert.match(html, /<button[^>]*>音声を生成<\/button>/, "保存のゲートを持ち込まない");
  // class に `disabled:` が含まれるため、属性としての disabled だけを否定する
  assert.match(html, /<textarea[^>]*aria-label="お試し再生の本文"(?![^>]*\sdisabled=)/, "本文も触れる");
  assert.match(html, /<select[^>]*aria-label="お試し再生のモデル"(?![^>]*\sdisabled=)/, "モデルも選べる");
});

test("runtimeAvailable: false ではお試し再生の主ボタンも無効にする", () => {
  const html = render({ runtimeAvailable: false, subsection: "speech" });
  assert.match(html, /<button[^>]*\sdisabled=""[^>]*>音声を生成<\/button>/, "実行できない preview API を呼ばせない");
  assert.ok(html.includes("ランタイムが利用できないため、お試し再生はできません"), "押せない理由を出す");
  // ランタイムがあれば、音声の同期が取れていない間も押せる（別のゲート）
  assert.match(render({ subsection: "speech" }), /<button(?![^>]*\sdisabled=)[^>]*>音声を生成<\/button>/);
  assert.match(
    render({ subsection: "speech", speechSynced: false }),
    /<button(?![^>]*\sdisabled=)[^>]*>音声を生成<\/button>/,
  );
});
