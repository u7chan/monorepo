// 試行の結果から既定のモデル（音声はボイスも）を保存する導線。client に DOM テスト基盤が無いため、
// 表示条件（保存値と同じなら出さない）と PUT の本文、保存の進行と失敗の印を純関数と controller で固定する。

import assert from "node:assert/strict";
import test from "node:test";
import { speechScreenSelection } from "../src/lib/contentSettings";
import {
  createTrialDefaultAction,
  imageTrialDefaultTarget,
  INITIAL_TRIAL_DEFAULT_STATE,
  speechTrialDefaultTarget,
  type TrialDefaultState,
} from "../src/lib/trialDefault";
import type { ContentSettingsResponse, UpdateContentImageBody } from "../src/types";

const IMAGE_MODELS = [
  { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
  { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
];

const SPEECH_MODELS = [
  { provider: "openrouter", id: "google/gemini-3.8-flash-tts", name: "Gemini TTS", voices: ["Zephyr", "Aoede"] },
  { provider: "openrouter", id: "fish/audio", name: "Fish Audio", voices: [] },
];

function settings(
  overrides: Partial<ContentSettingsResponse> = {},
  image: Partial<ContentSettingsResponse["image"]> = {},
  speech: Partial<ContentSettingsResponse["speech"]> = {},
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
    disabledMessage: "無効",
    runtimeAvailable: true,
    bgm: { model: "google/lyria-3-clip-preview", format: "mp3", expectedDurationSeconds: 30 },
    image: { model: "openai/gpt-image-2", models: IMAGE_MODELS, catalogSource: "live", fetchedAt: null, ...image },
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

test("画像は試行のモデルが保存値と違うときだけ既定にできる", () => {
  assert.equal(
    imageTrialDefaultTarget({ settings: settings(), trialModel: "openrouter/openai/gpt-image-2" }),
    null,
    "保存値と同じなら導線を出さない",
  );
  assert.deepEqual(
    imageTrialDefaultTarget({ settings: settings(), trialModel: "openrouter/google/gemini-image" }),
    { provider: "openrouter", model: "google/gemini-image" },
    "試行に使ったモデルを PUT の本文にする",
  );
});

test("画像のモデルを本文にできないときは導線を出さない", () => {
  assert.equal(
    imageTrialDefaultTarget({ settings: settings(), trialModel: "openrouter/unknown/image" }),
    null,
    "カタログにも保存値にも無いモデルは保存できない",
  );
  const outside = settings({}, { model: "openrouter/retired/image" });
  assert.equal(
    imageTrialDefaultTarget({ settings: outside, trialModel: "openrouter/retired/image" }),
    null,
    "保存値と同じならカタログ外でも出さない",
  );
  assert.deepEqual(
    imageTrialDefaultTarget({ settings: outside, trialModel: "openrouter/openai/gpt-image-2" }),
    { provider: "openrouter", model: "openai/gpt-image-2" },
    "カタログ外の保存値でも、カタログにあるモデルへは切り替えられる",
  );
});

test("音声は試行のモデルとボイスの両方が保存値と同じときだけ導線を出さない", () => {
  const base = { trialModel: "google/gemini-3.8-flash-tts" };
  assert.equal(speechTrialDefaultTarget({ settings: settings(), ...base, trialVoice: "Zephyr" }), null);
  assert.equal(
    speechTrialDefaultTarget({ settings: settings(), ...base, trialVoice: "Zephyr" }),
    null,
    "モデルもボイスも同じなら出さない",
  );
  assert.deepEqual(
    speechTrialDefaultTarget({ settings: settings(), ...base, trialVoice: "Aoede" }),
    { model: "google/gemini-3.8-flash-tts", voice: "Aoede" },
    "ボイスだけ違ってもモデルとボイスを保存する",
  );
  assert.deepEqual(
    speechTrialDefaultTarget({ settings: settings(), trialModel: "fish/audio", trialVoice: null }),
    { model: "fish/audio", voice: "" },
    "モデルが違えばボイス未指定として保存する",
  );
});

test("音声のボイス未指定は保存値の空文字と同じ扱いにする", () => {
  const unset = settings({}, {}, { voice: "" });
  assert.equal(
    speechTrialDefaultTarget({ settings: unset, trialModel: "google/gemini-3.8-flash-tts", trialVoice: null }),
    null,
    "どちらも「指定なし」なら差が無い",
  );
  assert.deepEqual(
    speechTrialDefaultTarget({ settings: settings(), trialModel: "google/gemini-3.8-flash-tts", trialVoice: null }),
    { model: "google/gemini-3.8-flash-tts", voice: "" },
    "保存値にボイスがあれば未指定へ切り替える",
  );
});

test("音声もカタログで解決できないモデルは導線を出さない", () => {
  assert.equal(
    speechTrialDefaultTarget({ settings: settings(), trialModel: "unknown/tts", trialVoice: "Zephyr" }),
    null,
  );
});

test("保存後は保存値が試行の値になり、下書きを捨てれば未保存でなくなる", () => {
  const before = settings({}, {}, { voice: "Zephyr" });
  const target = speechTrialDefaultTarget({
    settings: before,
    trialModel: "google/gemini-3.8-flash-tts",
    trialVoice: "Aoede",
  });
  assert.deepEqual(target, { model: "google/gemini-3.8-flash-tts", voice: "Aoede" });

  // PUT の応答（保存後の設定）と、下書きを捨てた状態
  const after = settings({}, {}, { model: target?.model, voice: target?.voice });
  assert.equal(
    speechTrialDefaultTarget({ settings: after, trialModel: "google/gemini-3.8-flash-tts", trialVoice: "Aoede" }),
    null,
    "保存できたら導線は消える",
  );
  assert.equal(
    speechScreenSelection(after, { model: null, voice: null }).dirty,
    false,
    "下書きが空なら保存値に追随し、未保存として残らない",
  );

  const savedImage = settings({}, { model: "google/gemini-image" });
  assert.equal(
    imageTrialDefaultTarget({ settings: savedImage, trialModel: "openrouter/google/gemini-image" }),
    null,
    "画像も保存後は導線が消える",
  );
});

function setupAction(save: (input: UpdateContentImageBody) => Promise<boolean>) {
  let state: TrialDefaultState = INITIAL_TRIAL_DEFAULT_STATE;
  const states: TrialDefaultState[] = [];
  const saved: UpdateContentImageBody[] = [];
  const action = createTrialDefaultAction({
    onChange: (next) => {
      state = next;
      states.push(next);
    },
  });
  const target = { provider: "openrouter", model: "google/gemini-image" };
  return {
    action,
    target,
    states,
    saved,
    state: () => state,
    run: () =>
      action.run(target, async (input) => {
        saved.push(input);
        return save(input);
      }),
  };
}

test("保存中は saving を立て、成功したら失敗の印を残さない", async () => {
  const view = setupAction(async () => true);
  assert.equal(await view.run(), true);
  assert.deepEqual(view.saved, [{ provider: "openrouter", model: "google/gemini-image" }]);
  assert.deepEqual(view.states, [
    { saving: true, failed: false },
    { saving: false, failed: false },
  ]);
});

test("保存できなかったときと例外は失敗の印を立て、成功と取り違えない", async () => {
  const rejected = setupAction(async () => false);
  assert.equal(await rejected.run(), false);
  assert.deepEqual(rejected.state(), { saving: false, failed: true });

  const thrown = setupAction(async () => {
    throw new Error("503");
  });
  assert.equal(await thrown.run(), false);
  assert.deepEqual(thrown.state(), { saving: false, failed: true });
});

test("押下中は二重に送らない", async () => {
  let release!: (saved: boolean) => void;
  const view = setupAction(
    () =>
      new Promise<boolean>((done) => {
        release = done;
      }),
  );
  const first = view.run();
  assert.equal(await view.run(), false, "保存中は受け付けない");
  assert.equal(view.saved.length, 1);
  release(true);
  assert.equal(await first, true);
});

test("破棄の通知の後も次の押下は保存できる（StrictMode の effect 再実行で壊れない）", async () => {
  const view = setupAction(async () => true);
  // StrictMode の開発時は Effect が setup → cleanup → setup と余分に 1 周する
  view.action.invalidate();
  assert.equal(await view.run(), true, "破棄の通知で以後の押下を殺さない");
  assert.deepEqual(view.saved, [{ provider: "openrouter", model: "google/gemini-image" }]);
  assert.deepEqual(view.state(), { saving: false, failed: false });
});

test("破棄の後に遅れて届いた保存結果は適用しない", async () => {
  let release!: (saved: boolean) => void;
  const view = setupAction(
    () =>
      new Promise<boolean>((done) => {
        release = done;
      }),
  );
  const first = view.run();
  view.action.invalidate();
  const applied = view.states.length;
  release(true);
  assert.equal(await first, false, "破棄後の結果は成功として扱わない");
  assert.equal(view.states.length, applied, "破棄後の結果で state を変えない");
});
