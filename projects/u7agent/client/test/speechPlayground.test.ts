// お試し再生の描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 入力の初期値・生成中の無効化・失敗の表示・結果の形式表示を固定する
// (初期値・検証・文言そのものは lib/contentSettings の純関数テストが担う)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SpeechPlaygroundView } from "../src/components/content-settings/SpeechPlayground";
import type { SpeechPreviewAudio, SpeechPreviewDraft } from "../src/lib/contentSettings";
import type { ContentSettingsResponse, ContentSpeechSettings } from "../src/types";

const SPEECH_MODELS = [
  {
    provider: "openrouter",
    id: "google/gemini-3.8-flash-tts",
    name: "Google: Gemini 3.8 Flash TTS",
    voices: ["Zephyr", "Kore"],
  },
  { provider: "openrouter", id: "fish/audio", name: "Fish Audio" },
];

function settings(speech: Partial<ContentSpeechSettings> = {}): ContentSettingsResponse {
  return {
    configured: true,
    provider: "openrouter",
    runtimeAvailable: true,
    image: { model: "openai/gpt-image-2", models: [], catalogSource: "live", fetchedAt: null },
    speech: {
      model: "google/gemini-3.8-flash-tts",
      voice: "Zephyr",
      models: SPEECH_MODELS,
      catalogSource: "live",
      fetchedAt: null,
      ...speech,
    },
  };
}

function draft(overrides: Partial<SpeechPreviewDraft> = {}): SpeechPreviewDraft {
  return {
    model: "google/gemini-3.8-flash-tts",
    voice: "Zephyr",
    text: "こんにちは",
    instructions: "",
    speed: "",
    ...overrides,
  };
}

function render(
  options: {
    speech?: Partial<ContentSpeechSettings>;
    values?: Partial<SpeechPreviewDraft>;
    busy?: boolean;
    error?: string | null;
    audio?: (SpeechPreviewAudio & { url: string }) | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(SpeechPlaygroundView, {
      settings: settings(options.speech),
      values: draft(options.values),
      busy: options.busy ?? false,
      error: options.error ?? null,
      audio: options.audio ?? null,
      onChange: () => {},
      onSubmit: () => {},
    }),
  );
}

test("お試し再生は本文・モデル・ボイス・演技指示・速度と、課金の注意を出す", () => {
  const html = render();
  assert.ok(html.includes("お試し再生"), "セクション名を出す");
  assert.match(html, /<textarea[^>]*aria-label="お試し再生の本文"[^>]*>こんにちは<\/textarea>/, "本文を出す");
  assert.match(html, /<select[^>]*aria-label="お試し再生のモデル"/, "モデルを選ばせる");
  assert.ok(html.includes('value="google/gemini-3.8-flash-tts"'), "保存済みモデルを選択した状態で出す");
  assert.match(html, /<select[^>]*aria-label="お試し再生のボイス"/, "宣言があるモデルはボイスを選ばせる");
  assert.ok(html.includes(">Kore</option>"), "宣言されている他のボイスも候補に出す");
  assert.match(html, /<input[^>]*aria-label="お試し再生の演技指示"/, "演技指示の入力を出す");
  assert.match(html, /<input[^>]*aria-label="お試し再生の速度"/, "速度の入力を出す");
  assert.ok(html.includes(">再生</button>"), "生成の操作を出す");
  assert.ok(html.includes("1 回の再生ごとに provider のクレジットを消費します"), "課金を先に伝える");
  assert.ok(html.includes("保存した設定は変えずに"), "保存を変えないことを伝える");
  assert.ok(html.includes("未対応のモデルでは無視されるか 400 になります"), "未対応パラメーターの扱いを伝える");
  assert.equal(html.includes("<audio"), false, "未生成ではプレイヤーを出さない");
});

test("宣言が無いモデルではボイスを自由記述にし、カタログ外の現在値も残す", () => {
  const free = render({ values: { model: "fish/audio", voice: "my-voice" } });
  assert.match(free, /<input[^>]*aria-label="お試し再生のボイス"[^>]*value="my-voice"/, "自由記述へ切り替える");
  assert.ok(free.includes("モデル既定（空欄のまま送ります）"), "空欄の意味を出す");

  const stale = render({ speech: { model: "stale/tts" }, values: { model: "stale/tts", voice: "Zephyr" } });
  assert.ok(stale.includes("stale/tts（カタログ外）"), "保存済みの現在値を選択肢に残す");
  assert.ok(stale.includes('value="stale/tts"'));
});

test("生成中は入力と操作を無効にし、進行中の表示を出す", () => {
  const html = render({ busy: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*>生成中…<\/button>/, "連打できないようにする");
  assert.ok(html.includes("音声を生成しています…"), "進行中を出す");
  for (const label of [
    "お試し再生の本文",
    "お試し再生のモデル",
    "お試し再生のボイス",
    "お試し再生の演技指示",
    "お試し再生の速度",
  ]) {
    assert.match(html, new RegExp(`aria-label="${label}"[^>]*disabled=""`), `${label} を触らせない`);
  }
});

test("失敗は分類済みの文言を出し、入力と選択を保つ", () => {
  const html = render({
    values: { text: "こんにちは", instructions: "静かに読む", speed: "1.5" },
    error: "音声生成の残高が不足しています",
  });
  assert.match(html, /role="alert"[^>]*>音声生成の残高が不足しています<\/p>/, "理由を出す");
  assert.match(html, /<textarea[^>]*aria-label="お試し再生の本文"[^>]*>こんにちは<\/textarea>/, "本文を保つ");
  assert.match(html, /<input[^>]*aria-label="お試し再生の演技指示"[^>]*value="静かに読む"/, "演技指示を保つ");
  assert.match(html, /<input[^>]*aria-label="お試し再生の速度"[^>]*value="1.5"/, "速度を保つ");
  assert.equal(html.includes("生成中…"), false, "失敗後は再試行できる");
});

test("生成できたら blob: のプレイヤーと、返ってきた形式を出す", () => {
  const mp3 = render({ audio: { blob: new Blob(), url: "blob:http://localhost/1", format: "mp3" } });
  assert.match(mp3, /<audio[^>]*controls=""[^>]*src="blob:http:\/\/localhost\/1"/, "その場で再生できるようにする");
  assert.ok(mp3.includes("音声を生成しました（mp3）"), "どちらの形式で返ったかを出す");

  const wav = render({ audio: { blob: new Blob(), url: "blob:http://localhost/2", format: "wav" } });
  assert.ok(wav.includes("音声を生成しました（wav）"), "pcm は wav として返る");
  assert.ok(wav.includes('src="blob:http://localhost/2"'));

  const unknown = render({ audio: { blob: new Blob(), url: "blob:http://localhost/3", format: undefined } });
  assert.ok(unknown.includes("音声を生成しました"), "判別できない形式でも生成できたことは伝える");
  assert.equal(unknown.includes("音声を生成しました（"), false, "形式を推測して出さない");
});
