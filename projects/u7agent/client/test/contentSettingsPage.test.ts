// 設定 → コンテンツ生成のページ描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// タブ行の出し分け（取得前 / 未設定 / 設定済み）、選んだ面の URL との対応、この画面だけの再読み込みを
// 固定する (本文の詳細は contentSettingsTab.test.ts)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ContentSettings } from "../src/hooks/useContentSettings";
import { CONTENT_SETTINGS_NOTE } from "../src/lib/contentSettings";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import type { ContentSubsection } from "../src/lib/settingsNav";
import type { ContentTrials } from "../src/hooks/useContentTrials";
import type { ContentSettingsResponse, ContentTrial } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ContentSettingsView } = await import("../src/components/ContentSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const CONTENT_SETTINGS: ContentSettingsResponse = {
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
    setEnabled: async () => true,
    saveKey: async () => true,
    removeKey: async () => true,
    saveImageProvider: async () => true,
    saveSelection: async () => true,
    saveSpeech: async () => true,
    refreshCatalog: async () => true,
    refreshSpeechCatalog: async () => true,
    speechSynced: true,
    ...overrides,
  };
}

/** `useContentTrials` の戻り値のうち、描画が読む部分だけを組み立てる */
function contentTrials(
  trials: ContentTrial[] | null = null,
  note: { text: string; error: boolean } | null = null,
  newResults: ContentSubsection[] = [],
): ContentTrials {
  return {
    trials,
    keyEpoch: 0,
    artifactUsage: { count: 0, bytes: 0 },
    artifactWarning: null,
    note,
    busy: false,
    newResults,
    running: (trials ?? []).some((trial) => trial.state === "running"),
    hasMore: false,
    loadingMore: false,
    detail: null,
    reload: async () => true,
    loadMore: async () => true,
    selectTrial: () => {},
    loadTrialDetail: async () => null,
    start: async () => true,
    cancel: async () => true,
    remove: async () => true,
    removeAll: async () => true,
  } satisfies ContentTrials;
}

function render(
  settings: ContentSettings,
  options: {
    contentSubsection?: ContentSubsection;
    onSelectContentSubsection?: (value: ContentSubsection) => void;
    trials?: ContentTrial[] | null;
    /** 試行の操作の注記。設定の注記とは別の行に出る */
    trialNote?: { text: string; error: boolean } | null;
    /** 別のタブで終端した試行の種別（タブの warn の点） */
    newResults?: ContentSubsection[];
  } = {},
): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ContentSettingsView, {
        contentSettings: settings,
        contentTrials: contentTrials(options.trials, options.trialNote, options.newResults),
        contentSubsection: options.contentSubsection,
        onSelectContentSubsection: options.onSelectContentSubsection,
        onBack: () => {},
      }),
    ),
  );
}

test("設定済みでは画像・TTS・BGM・履歴のタブを出し、既定は画像生成", () => {
  const html = render(contentSettings());
  assert.ok(html.includes("CONTENT"), "eyebrow は CONTENT");
  assert.ok(html.includes("コンテンツ生成"), "セクション名を見出しに出す");
  assert.ok(html.includes('role="tablist"'), "タブ行を出す");
  assert.ok(html.includes('aria-label="コンテンツ生成の設定"'), "タブ行のラベルを渡す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4, "画像・TTS・BGM・履歴");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>画像生成/, "既定は「画像生成」");
  assert.ok(html.includes("音声（TTS）"), "音声のタブを出す");
  assert.ok(html.includes("音楽（BGM）"), "BGMのタブを出す");
  assert.ok(html.includes("履歴"), "履歴のタブを出す");
  assert.ok(html.includes('aria-label="コンテンツ生成のモデル"'), "本文は画像の面を出す");
  assert.equal(html.includes("試行の本文"), false, "もう一方の面は出さない");
  assert.ok(html.includes('type="password"'), "APIキーの入力を出す");
  assert.equal(html.includes("モデル候補を保存"), false, "モデルの保存バーは出さない");
  // タブの切替は URL 経由で親へ渡す
  const calls: ContentSubsection[] = [];
  render(contentSettings(), { onSelectContentSubsection: (value) => calls.push(value) });
  assert.deepEqual(calls, [], "描画だけでは切替を要求しない");
});

test("URLがBGMを指すと固定モデルの読取専用面と試行の面を出し、モデル選択は出さない", () => {
  const html = render(contentSettings(), { contentSubsection: "bgm" });
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>音楽（BGM）/);
  assert.match(
    html,
    /<input[^>]*aria-label="BGM生成の固定モデル"[^>]*readOnly=""[^>]*value="google\/lyria-3-clip-preview"/i,
  );
  assert.match(html, /30秒のクリップ/);
  assert.match(html, /課金対象/);
  assert.match(html, /外部送信/);
  assert.match(html, /ボーカルなし.*保証しません/);
  // 試行の面（プロンプトの入力）は出し、BGM のモデル選択は出さない
  assert.ok(html.includes('aria-label="試行のプロンプト"'), "BGM の試行の面を出す");
  assert.equal(html.includes("お試し再生"), false);
  assert.equal(html.includes('aria-label="音声生成のモデル"'), false);
  assert.equal(html.includes('aria-label="コンテンツ生成のモデル"'), false);
});

test("URL が音声を指すときは音声タブを選び、音声の面だけを出す", () => {
  const html = render(contentSettings(), { contentSubsection: "speech" });
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>音声（TTS）/, "選んだタブを示す");
  assert.ok(html.includes('type="password"'), "APIキーはタブの外で共有する");
  assert.ok(html.includes('aria-label="音声生成のモデル"'), "音声の面を出す");
  assert.equal(html.includes('aria-label="コンテンツ生成のモデル"'), false, "画像の面は出さない");
});

test("取得前はタブ行も面も出さず、この画面の注記と再読み込みの導線を出す", () => {
  const html = render(contentSettings({ settings: null }));
  assert.ok(html.includes("コンテンツ生成の設定"), "取得前の見出しを出す");
  assert.equal(html.includes('role="tablist"'), false, "面の中身が無い間はタブ行を出さない");
  assert.ok(html.includes(CONTENT_SETTINGS_NOTE), "hook の注記をそのまま見せる");
  assert.ok(html.includes("再読み込み"), "この画面の再読み込みを出す");

  const reloading = render(contentSettings({ reloading: true }));
  assert.match(reloading, /<button[^>]*disabled=""[^>]*>.*再読み込み.*<\/button>/s, "取得中は押せない");
});

test("取り直しはタブ行の下のツールバーへ出し、本文の枠には置かない", () => {
  const html = render(contentSettings());
  const tabsAt = html.indexOf('role="tablist"');
  assert.ok(tabsAt >= 0, "タブ行を出す");
  assert.ok(html.indexOf("再読み込み") > tabsAt, "再読み込みはタブ行より下に出す");
  assert.ok(
    html.indexOf("再読み込み") < html.indexOf('aria-label="コンテンツ生成のAPIキー"'),
    "ツールバーは本文より上に出す",
  );

  const failed = render(
    contentSettings({
      settings: null,
      note: { text: "コンテンツ生成の設定を読み込めませんでした。接続できません", error: true },
    }),
  );
  assert.ok(failed.includes(RELOAD_ABOVE_NOTE), "本文の枠には上の導線を案内する");
  assert.equal((failed.match(/>再読み込み<\/button>/g) ?? []).length, 1, "再読み込みはツールバーに 1 つだけ");
});

test("未設定ではタブ行を出さず、キー入力だけを出す", () => {
  const html = render(contentSettings({ settings: { ...CONTENT_SETTINGS, configured: false, provider: null } }));
  assert.equal(html.includes('role="tablist"'), false, "キーを保存して初めて選べるようになるため出さない");
  assert.ok(html.includes('type="password"'), "キー入力は出す");
  assert.equal(html.includes('aria-label="コンテンツ生成のモデル"'), false, "面は出さない");
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

test("音声の同期が取れていない間だけ、音声タブに警告ドットと状態つきの読み上げ名を出す", () => {
  const unsynced = render(contentSettings({ speechSynced: false }));
  assert.match(
    unsynced,
    /<button[^>]*role="tab"[^>]*aria-label="音声（TTS）（現在の設定を確認できません）"[^>]*>音声（TTS）<span[\s\S]*?bg-warn[^>]*><\/span>/,
    "開かなくても対処が要ることが分かるようにする",
  );
  const synced = render(contentSettings());
  assert.equal(synced.includes('aria-label="音声（TTS）"'), false, "同期中は状態を足さない");
  assert.equal(/(?:role="tab")[\s\S]*?音声（TTS）<span/.test(synced), false, "同期中はドットを出さない");
});

test("試行の注記は設定の注記を隠さない（出どころごとに別の行へ出す）", () => {
  const trialNote = { text: "試行を開始しました。画面を離れても続きます。", error: false };
  const settingsNote = { text: "画像APIキーが無効です。設定を確認してください", error: true };
  const html = render(contentSettings({ note: settingsNote }), { trialNote });

  // 設定の注記行（aria-live）には設定の注記だけを出す（試行の注記で上書きしない）
  const noteRow = /<div aria-live="polite"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.ok(noteRow.includes(settingsNote.text), "設定の失敗を隠さない");
  assert.equal(noteRow.includes(trialNote.text), false, "試行の注記を設定の注記行へ混ぜない");

  // 試行の注記は試行の面の中に出す
  assert.ok(html.includes(trialNote.text), "試行の注記はその面に出す");

  // 音声・BGM のタブも同じ注記を自分の面の中に出す（種別が違っても試行の操作結果は 1 つの行に出す）
  for (const contentSubsection of ["speech", "bgm"] as const) {
    const other = render(contentSettings({ note: settingsNote }), { trialNote, contentSubsection });
    assert.ok(other.includes(settingsNote.text), contentSubsection);
    assert.ok(other.includes(trialNote.text), `${contentSubsection} の面でも試行の注記を出す`);
  }
});

test("BGM のタブにも実行中と新着の印を出し、開けば消える", () => {
  const running: ContentTrial = {
    id: "trial-bgm-run",
    kind: "bgm",
    model: "google/lyria-3-clip-preview",
    promptPreview: "静かな夜のピアノ",
    prompt: "静かな夜のピアノ",
    voice: null,
    instructions: null,
    speed: null,
    state: "running",
    keyEpoch: 0,
    artifactState: "none",
    artifact: null,
    charged: false,
    failureCode: null,
    failureMessage: null,
    startedAt: 1_000,
    finishedAt: null,
    durationMs: null,
    recorded: true,
  };
  // 実行中は BGM タブにだけ accent の点が出る（画像・音声のタブには出さない）
  const html = render(contentSettings(), { trials: [running], contentSubsection: "image" });
  assert.match(html, /<button[^>]*role="tab"[^>]*aria-label="音楽（BGM）（生成中）"/);
  assert.equal(html.includes('aria-label="画像生成（生成中）"'), false);

  // 実行中の点は開いたタブにも残る（開いて消えるのは新着の点だけ）
  const open = render(contentSettings(), { trials: [running], contentSubsection: "bgm" });
  assert.match(open, /aria-label="音楽（BGM）（生成中）"/);

  // 別のタブで終端した BGM には warn の点を出し、BGM を開けば消える（フックが newResults から外す）
  const finished = render(contentSettings(), { newResults: ["bgm"], contentSubsection: "image" });
  assert.match(finished, /aria-label="音楽（BGM）（新しい結果があります）"/);
  const cleared = render(contentSettings(), { newResults: [], contentSubsection: "image" });
  assert.equal(cleared.includes("（新しい結果があります）"), false);
});
