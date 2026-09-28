// 画像生成タブの表示変換。選択肢の組み立て・現在値の解決・PUT の本文・入力の後始末を純関数で固定する
// (画面の描画は client/test/imageSettingsTab.test.ts の静的描画が担う)。

import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteImageKeyConfirmMessage,
  imageModelOptions,
  imageModelSelection,
  imageModelValue,
  keyDraftAfterSave,
} from "../src/lib/imageSettings";
import type { ImageSettingsResponse } from "../src/types";

function settings(overrides: Partial<ImageSettingsResponse> = {}): ImageSettingsResponse {
  return {
    configured: true,
    provider: "openrouter",
    model: "openai/gpt-image-2",
    models: [
      { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
      { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
      { provider: "openrouter", id: "mystery/image", name: "GPT Image 2" },
    ],
    runtimeAvailable: true,
    ...overrides,
  };
}

test("モデルの選択肢はカタログ順に並べ、同名は id を添えて一意にする", () => {
  const options = imageModelOptions(settings());
  assert.deepEqual(
    options.map((option) => option.label),
    ["GPT Image 2（openai/gpt-image-2）", "Gemini Image", "GPT Image 2（mystery/image）"],
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["openrouter/openai/gpt-image-2", "openrouter/google/gemini-image", "openrouter/mystery/image"],
  );
});

test("カタログ外の保存済みモデルは現在値として先頭に足す", () => {
  const options = imageModelOptions(settings({ model: "stale/model" }));
  assert.equal(options[0].value, "openrouter/stale/model");
  assert.equal(options[0].label, "stale/model（カタログ外）");
  assert.equal(options[0].model?.provider, "openrouter");
  assert.equal(options.length, 4, "カタログの 3 件を失わない");
});

test("現在値と PUT の本文を選択肢から解決する", () => {
  assert.equal(imageModelValue(settings()), "openrouter/openai/gpt-image-2");
  assert.equal(imageModelValue({ provider: null, model: null }), "", "行が無ければ空文字");

  const options = imageModelOptions(settings());
  assert.deepEqual(imageModelSelection(options, options[1].value), {
    provider: "openrouter",
    model: "google/gemini-image",
  });
  assert.equal(imageModelSelection(options, "openrouter/unknown"), null, "選択肢に無い値は保存しない");
});

test("キー入力は保存に成功したときだけ消す", () => {
  assert.equal(keyDraftAfterSave("dummy-image-key", true), "");
  assert.equal(keyDraftAfterSave("dummy-image-key", false), "dummy-image-key");
});

test("削除の確認は新しい会話への影響と既存の会話の失敗を伝える", () => {
  const message = deleteImageKeyConfirmMessage();
  assert.match(message, /削除します/);
  assert.match(message, /新しい会話/);
  assert.match(message, /キー無効エラー/);
});
