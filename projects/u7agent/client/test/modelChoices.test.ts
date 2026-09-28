// Model ピッカーの選択肢ラベル。DOM を使わず、同名衝突の判定規則だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { modelChoices, unavailableModelChoice } from "../src/lib/modelChoices";
import type { ModelOption } from "../src/types";

const option = (provider: string, id: string, name: string): ModelOption => ({
  provider,
  id,
  name,
  supportsThinking: true,
  thinkingLevels: [],
});

test("同名の候補がないときは表示名だけで、value は常に provider/id", () => {
  const choices = modelChoices([
    option("deepseek", "deepseek-flash", "DeepSeek V4.1 Flash"),
    option("openai", "gpt-6-luna", "GPT-6 Luna"),
  ]);
  assert.deepEqual(choices, [
    {
      value: "deepseek/deepseek-flash",
      label: "DeepSeek V4.1 Flash",
      model: { provider: "deepseek", id: "deepseek-flash" },
    },
    { value: "openai/gpt-6-luna", label: "GPT-6 Luna", model: { provider: "openai", id: "gpt-6-luna" } },
  ]);
});

test("別 provider で同名なら provider を添える", () => {
  const choices = modelChoices([
    option("openai", "gpt-6-luna", "GPT-6 Luna"),
    option("openai-codex", "gpt-6-luna", "GPT-6 Luna"),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["GPT-6 Luna（openai）", "GPT-6 Luna（openai-codex）"],
  );
});

test("同じ provider 内で同名・別 id なら provider/id まで出す", () => {
  const choices = modelChoices([
    option("radius", "deepseek-v4-flash", "DeepSeek V4.1 Flash"),
    option("radius", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["DeepSeek V4.1 Flash（radius/deepseek-v4-flash）", "DeepSeek V4.1 Flash（radius/deepseek-v4.1-flash）"],
  );
});

test("provider をまたぐ同名と provider 内の id 割れが同時に成立するときは行ごとに規則を決める", () => {
  const choices = modelChoices([
    option("radius", "deepseek-v4-flash", "DeepSeek V4.1 Flash"),
    option("radius", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
    option("deepseek", "deepseek-flash", "DeepSeek V4.1 Flash"),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    [
      "DeepSeek V4.1 Flash（radius/deepseek-v4-flash）",
      "DeepSeek V4.1 Flash（radius/deepseek-v4.1-flash）",
      "DeepSeek V4.1 Flash（deepseek）",
    ],
  );
});

test("同じ (provider, id) の重複は distinct に数えず、判定を変えない", () => {
  const choices = modelChoices([
    option("openai", "gpt-6-luna", "GPT-6 Luna"),
    option("openai", "gpt-6-luna", "GPT-6 Luna"),
    option("openai-codex", "gpt-6-luna", "GPT-6 Luna"),
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["GPT-6 Luna（openai）", "GPT-6 Luna（openai）", "GPT-6 Luna（openai-codex）"],
  );
});

test("name が空の候補は provider/id を出す", () => {
  const choices = modelChoices([option("zai", "glm-5.3-flash", "")]);
  assert.deepEqual(choices, [
    { value: "zai/glm-5.3-flash", label: "zai/glm-5.3-flash", model: { provider: "zai", id: "glm-5.3-flash" } },
  ]);
});

test("利用不可の行は value と label が provider/id（利用不可）で、model は null", () => {
  assert.deepEqual(unavailableModelChoice("openai/gpt-6-luna"), {
    value: "openai/gpt-6-luna",
    label: "openai/gpt-6-luna（利用不可）",
    model: null,
  });
});
