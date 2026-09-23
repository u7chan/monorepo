import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_THINKING_LEVELS,
  deriveComposerSettings,
  effortLabel,
  type ComposerSettingsInput,
} from "../src/lib/composerSettings";
import type { AgentDef, Health, ModelOption, ThinkingLevel } from "../src/types";

const health = (overrides: Partial<Health> = {}): Health => ({ ready: true, ...overrides });

const agent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  id: "agent-1",
  name: "Agent",
  description: "",
  systemPrompt: "",
  skillIds: [],
  ...overrides,
});

const option = (
  provider: string,
  id: string,
  thinkingLevels: ThinkingLevel[] = ["low", "high"],
  supportsThinking = true,
): ModelOption => ({ provider, id, name: `${provider}/${id}`, supportsThinking, thinkingLevels });

function input(overrides: Partial<ComposerSettingsInput> = {}): ComposerSettingsInput {
  return {
    health: health(),
    selectedAgent: undefined,
    sessionId: "",
    preselection: {},
    chat: { supportsThinking: true, availableThinkingLevels: ALL_THINKING_LEVELS },
    sending: false,
    settingsChanging: false,
    stopVisible: false,
    ...overrides,
  };
}

test("shows the effective values that resync put on the chat", () => {
  const settings = deriveComposerSettings(
    input({
      sessionId: "s-1",
      preselection: { model: { provider: "pre", id: "selected" } },
      selectedAgent: agent({ model: { provider: "agent", id: "model" } }),
      chat: {
        sessionModel: "resync/model",
        sessionThinkingLevel: "high",
        supportsThinking: false,
        availableThinkingLevels: ["off"],
      },
      health: health({ model: "app/default", modelOptions: [option("resync", "model")] }),
    }),
  );

  assert.equal(settings.model, "resync/model");
  assert.equal(settings.thinkingLevel, "high");
  assert.equal(settings.supportsThinking, false);
  assert.deepEqual(settings.thinkingLevels, ["off"]);
});

test("resolves an unsent chat in the server order: preselection, agent, app default", () => {
  const modelOptions = [option("pre", "selected", ["low"]), option("agent", "model"), option("app", "default")];
  const fromPreselection = deriveComposerSettings(
    input({
      preselection: { model: { provider: "pre", id: "selected" }, thinkingLevel: "low" },
      selectedAgent: agent({ model: { provider: "agent", id: "model" }, thinkingLevel: "high" }),
      health: health({ model: "app/default", defaultThinkingLevel: "medium", modelOptions }),
    }),
  );
  assert.equal(fromPreselection.model, "pre/selected");
  assert.equal(fromPreselection.thinkingLevel, "low");
  assert.deepEqual(fromPreselection.thinkingLevels, ["low"], "候補は選択中モデルの能力から引く");

  const fromAgent = deriveComposerSettings(
    input({
      selectedAgent: agent({ model: { provider: "agent", id: "model" }, thinkingLevel: "high" }),
      health: health({ model: "app/default", defaultThinkingLevel: "medium", modelOptions }),
    }),
  );
  assert.equal(fromAgent.model, "agent/model");
  assert.equal(fromAgent.thinkingLevel, "high");

  const fromAppDefault = deriveComposerSettings(
    input({ health: health({ model: "app/default", defaultThinkingLevel: "medium", modelOptions }) }),
  );
  assert.equal(fromAppDefault.model, "app/default");
  assert.equal(fromAppDefault.thinkingLevel, "medium");
});

test("falls back to all effort levels when the model cannot be resolved", () => {
  const settings = deriveComposerSettings(input({ preselection: { model: { provider: "ghost", id: "none" } } }));

  assert.equal(settings.supportsThinking, true);
  assert.deepEqual(settings.thinkingLevels, ALL_THINKING_LEVELS);
  assert.equal(settings.effortNotice, "使用モデルに応じて補正されます");
});

test("warns when the displayed model is missing from the candidate list", () => {
  const modelOptions = [option("ok", "model")];
  const missing = deriveComposerSettings(
    input({ health: health({ modelOptions }), preselection: { model: { provider: "ghost", id: "none" } } }),
  );
  assert.equal(missing.modelWarning, "ghost/none は現在利用できません。別のモデルを選択してください。");

  const resolved = deriveComposerSettings(
    input({ health: health({ modelOptions }), preselection: { model: { provider: "ok", id: "model" } } }),
  );
  assert.equal(resolved.modelWarning, undefined);
  assert.equal(resolved.effortNotice, undefined, "候補を引けるときは補正の案内を出さない");
});

test("disables the picker while running, sending, or changing settings", () => {
  assert.equal(deriveComposerSettings(input({ stopVisible: true })).disabled, true);
  assert.equal(deriveComposerSettings(input({ sending: true })).disabled, true);

  const changing = deriveComposerSettings(input({ settingsChanging: true }));
  assert.equal(changing.disabled, true);
  assert.equal(changing.changing, true);
  assert.equal(deriveComposerSettings(input()).disabled, false);
});

test("blocks sending only when an unsent chat cannot resolve a model", () => {
  const reason = "既定モデルを解決できません";
  assert.equal(
    deriveComposerSettings(input({ health: health({ defaultModelError: reason }) })).sendBlockedReason,
    reason,
  );
  assert.equal(
    deriveComposerSettings(input({ health: health({ model: "app/default", defaultModelError: reason }) }))
      .sendBlockedReason,
    undefined,
    "モデルを表示できるなら送信を止めない",
  );
  assert.equal(
    deriveComposerSettings(input({ sessionId: "s-1", health: health({ defaultModelError: reason }) }))
      .sendBlockedReason,
    undefined,
    "作成済みセッションには関係しない",
  );
});

test("状態行に出すモデル表示名を解決する", () => {
  const named: ModelOption = {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    supportsThinking: true,
    thinkingLevels: ["high"],
  };

  const resolved = deriveComposerSettings(
    input({ health: health({ model: "anthropic/claude-sonnet-4-5", modelOptions: [named] }) }),
  );
  assert.equal(resolved.modelLabel, "Claude Sonnet 4.5", "候補を引けるときは SDK の表示名");

  const missing = deriveComposerSettings(
    input({ preselection: { model: { provider: "ghost", id: "none" } }, health: health({ modelOptions: [named] }) }),
  );
  assert.equal(missing.modelLabel, "ghost/none", "候補に無いモデルも provider/id なら出せる");
  assert.equal(deriveComposerSettings(input()).modelLabel, undefined, "モデルが未解決なら出さない");
});

test("renders unknown effort levels as-is", () => {
  assert.equal(effortLabel("xhigh"), "xHigh");
  assert.equal(effortLabel("warp"), "warp");
});
