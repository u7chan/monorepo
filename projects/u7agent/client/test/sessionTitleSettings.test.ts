// 設定 → 会話タイトルの表示変換と検証を確認する。
//   - 定義は空白だけ・上限超過を保存前に弾く (サーバーと同じ規則)
//   - モデル選択の値と警告はサーバーの応答だけで決まり、本会話のモデルへ勝手に切り替えない
//   - On / Off のチップと保存後の注記が状態に追随する

import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_TITLE_DEFINITION_SAVED_NOTE,
  SESSION_TITLE_EFFORT_SAVED_NOTE,
  SESSION_TITLE_MODEL_SAVED_NOTE,
  TITLE_DEFINITION_MAX,
  sessionTitleDefinitionError,
  sessionTitleEffortForModel,
  sessionTitleEffortNotice,
  sessionTitleEffortOptions,
  sessionTitleEffortValue,
  sessionTitleModelOptions,
  sessionTitleModelUnavailableNotice,
  sessionTitleModelValue,
  sessionTitleSavedNote,
  sessionTitleStatusBadge,
} from "../src/lib/sessionTitleSettings";
import type { TitleSummarySettingsResponse } from "../src/types";

const baseSettings: TitleSummarySettingsResponse = {
  enabled: false,
  model: null,
  thinkingLevel: null,
  effectiveThinkingLevel: null,
  definition: "定義",
  defaultDefinition: "既定",
  models: [
    {
      provider: "stub",
      id: "stub-model",
      name: "Stub Model",
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    },
    { provider: "other", id: "other-model", name: "Other Model", thinkingLevels: ["off"] },
  ],
  modelAvailable: false,
};

test("定義は空白だけ・上限超過を拒否し、上限以内は通す", () => {
  assert.match(sessionTitleDefinitionError("   ")!, /入力してください/);
  assert.match(sessionTitleDefinitionError("あ".repeat(TITLE_DEFINITION_MAX + 1))!, /文字以内/);
  assert.equal(sessionTitleDefinitionError("日本語20文字程度で。"), undefined);
  assert.equal(sessionTitleDefinitionError("あ".repeat(TITLE_DEFINITION_MAX)), undefined);
});

test("モデルの選択肢は provider/id を値にし、未選択は空文字で表す", () => {
  assert.deepEqual(sessionTitleModelOptions(baseSettings.models), [
    { value: "stub/stub-model", label: "Stub Model", detail: "stub-model", group: "stub" },
    { value: "other/other-model", label: "Other Model", detail: "other-model", group: "other" },
  ]);
  assert.equal(sessionTitleModelValue(baseSettings), "");
  assert.equal(sessionTitleModelValue({ model: "stub/stub-model" }), "stub/stub-model");
});

test("Effort は選択中モデルの対応段階だけを出し、実効値と未指定の警告を返す", () => {
  assert.equal(sessionTitleEffortValue(baseSettings), "");
  assert.deepEqual(
    sessionTitleEffortOptions({
      ...baseSettings,
      model: "stub/stub-model",
      effectiveThinkingLevel: "high",
    }).map((option) => option.value),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.equal(sessionTitleEffortValue({ ...baseSettings, effectiveThinkingLevel: "high" }), "high");
  // 保存値がモデルの段階から外れたら、実効値は先頭へフォールバックして警告する
  const fallback = {
    ...baseSettings,
    model: "other/other-model",
    thinkingLevel: "high" as const,
    effectiveThinkingLevel: "off" as const,
  };
  assert.deepEqual(
    sessionTitleEffortOptions(fallback).map((option) => option.value),
    ["off"],
  );
  assert.match(sessionTitleEffortNotice(fallback)!, /既定の Effort/);
  assert.equal(
    sessionTitleEffortNotice({ ...fallback, thinkingLevel: "off", effectiveThinkingLevel: "off" }),
    undefined,
  );
});

test("モデル切替では現在の Effort を残し、非対応なら最小段階を選ぶ", () => {
  const settings = { ...baseSettings, model: "stub/stub-model", effectiveThinkingLevel: "low" as const };
  assert.equal(sessionTitleEffortForModel(settings, "stub/stub-model", "high"), "high");
  assert.equal(sessionTitleEffortForModel(settings, "other/other-model", "high"), "off");
  assert.equal(sessionTitleEffortForModel(settings, "ghost/missing", "low"), null);
});

test("保存済みモデルが候補に無いときだけ警告する", () => {
  assert.equal(sessionTitleModelUnavailableNotice(baseSettings), undefined);
  assert.match(
    sessionTitleModelUnavailableNotice({ model: "stub/stub-model", modelAvailable: false })!,
    /AI 要約だけを飛ばし/,
  );
  assert.equal(sessionTitleModelUnavailableNotice({ model: "stub/stub-model", modelAvailable: true }), undefined);
});

test("チップと保存後の注記は On / Off に追随する", () => {
  assert.deepEqual(sessionTitleStatusBadge(true), { label: "AI要約 On", tone: "ok" });
  assert.deepEqual(sessionTitleStatusBadge(false), { label: "AI要約 Off", tone: "warn" });
  assert.match(sessionTitleSavedNote({ enabled: true }), /1 回だけ要約/);
  assert.match(sessionTitleSavedNote({ enabled: false }), /モデルと定義は保持/);
  assert.match(SESSION_TITLE_DEFINITION_SAVED_NOTE, /保存しました/);
  assert.match(SESSION_TITLE_MODEL_SAVED_NOTE, /要約モデル/);
  assert.match(SESSION_TITLE_EFFORT_SAVED_NOTE, /Effort/);
});
