import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_THINKING_LEVELS,
  clampEffortLevel,
  deriveComposerSettings,
  effortChoices,
  effortLabel,
  type ComposerSettingsInput,
} from "../src/lib/composerSettings";
import { MODEL_UNSET_GUIDE } from "../src/lib/modelSettings";
import type { AgentDef, Health, ModelOption, RunStatus, ThinkingLevel } from "../src/types";

const health = (overrides: Partial<Health> = {}): Health => ({ ready: true, ...overrides });

const agent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  id: "agent-1",
  name: "Agent",
  description: "",
  systemPrompt: "",
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
    chat: { supportsThinking: true, availableThinkingLevels: ALL_THINKING_LEVELS, runStatus: "idle", runTools: {} },
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
        runStatus: "idle",
        runTools: {},
      },
      health: health({ model: "app/default", modelOptions: [option("resync", "model")] }),
    }),
  );

  assert.equal(settings.model, "resync/model");
  assert.equal(settings.thinkingLevel, "high");
  assert.equal(settings.supportsThinking, false);
  assert.deepEqual(settings.thinkingLevels, ["off"]);
  assert.equal(settings.effortLabel, undefined, "推論に対応しないモデルの Effort は状態行に出さない");
});

test("derives the status row effort from the effective value", () => {
  const session = deriveComposerSettings(
    input({
      sessionId: "s-1",
      chat: {
        sessionModel: "resync/model",
        sessionThinkingLevel: "xhigh",
        supportsThinking: true,
        availableThinkingLevels: ["off", "xhigh"],
        runStatus: "idle",
        runTools: {},
      },
      health: health({ modelOptions: [option("resync", "model")] }),
    }),
  );
  assert.equal(session.effortLabel, "xHigh", "ピッカーと同じラベルを使う");

  const unsent = deriveComposerSettings(
    input({
      preselection: { model: { provider: "pre", id: "selected" }, thinkingLevel: "medium" },
      health: health({ modelOptions: [option("pre", "selected", ["low", "medium", "high"])] }),
    }),
  );
  assert.equal(unsent.effortLabel, "Medium", "未作成のチャットも「これから使う」Effort を出す");

  const unresolved = deriveComposerSettings(input({}));
  assert.equal(unresolved.effortLabel, undefined, "Effort が未解決のときは出さない");

  const noModel = deriveComposerSettings(input({ preselection: { thinkingLevel: "medium" } }));
  assert.equal(noModel.effortLabel, undefined, "モデル名が未解決なら続けて出す相手が無いので出さない");
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
  assert.equal(fromAppDefault.thinkingLevel, "high", "モデルが扱えないアプリ既定は clamp して表示する");
});

test("clamps the effort level the way the SDK does", () => {
  assert.equal(clampEffortLevel("medium", ["low", "high", "max"]), "high", "上へ寄せる");
  assert.equal(clampEffortLevel("xhigh", ["off", "low", "medium", "high"]), "high", "上に無ければ下へ寄せる");
  assert.equal(clampEffortLevel("medium", ["low", "medium"]), "medium", "候補にあるなら触らない");
  assert.equal(clampEffortLevel("zzz" as ThinkingLevel, ["low", "high"]), "low", "段階として知らない値は先頭へ");
  assert.equal(clampEffortLevel(undefined, ["low"]), undefined);
  assert.equal(clampEffortLevel("medium", []), "medium", "候補が無いときは表示できる値を残す");
});

test("an unsent chat shows the effort the session will actually use", () => {
  const modelOptions = [option("deep", "flash", ["low", "high", "max"])];
  const fromAppDefault = deriveComposerSettings(
    input({ health: health({ model: "deep/flash", defaultThinkingLevel: "medium", modelOptions }) }),
  );
  assert.equal(fromAppDefault.thinkingLevel, "high", "アプリ既定がモデルの段階に無いときも作成後の実効値に揃える");
  assert.equal(fromAppDefault.effortLabel, "High", "トリガーの表示も同じ値から出す");
  assert.deepEqual(fromAppDefault.thinkingLevels, ["low", "high", "max"], "選べない段階は候補へ混ぜない");

  const fromAgent = deriveComposerSettings(
    input({
      selectedAgent: agent({ model: { provider: "deep", id: "flash" }, thinkingLevel: "xhigh" }),
      health: health({ modelOptions }),
    }),
  );
  assert.equal(fromAgent.thinkingLevel, "max", "定義の値が上に無ければ上の段階へ寄せる");

  const fromPreselection = deriveComposerSettings(
    input({
      preselection: { model: { provider: "deep", id: "flash" }, thinkingLevel: "medium" },
      health: health({ modelOptions }),
    }),
  );
  assert.equal(fromPreselection.thinkingLevel, "high", "作成前の選択も同じ規則で clamp する");
});

test("keeps the in-session effort as the SDK reports it", () => {
  const settings = deriveComposerSettings(
    input({
      sessionId: "s-1",
      chat: {
        sessionModel: "deep/flash",
        sessionThinkingLevel: "medium",
        supportsThinking: true,
        availableThinkingLevels: ["low", "high", "max"],
        runStatus: "idle",
        runTools: {},
      },
      health: health({ modelOptions: [option("deep", "flash", ["low", "high", "max"])] }),
    }),
  );
  assert.equal(settings.thinkingLevel, "medium", "セッションの実効値は SDK が補正済みなので BFF 側で触らない");
  assert.deepEqual(settings.thinkingLevels, ["low", "high", "max"]);
});

test("orders the effort choices by level even when the current value is not offered", () => {
  assert.deepEqual(effortChoices(["low", "high", "max"], "medium"), ["low", "medium", "high", "max"]);
  assert.deepEqual(effortChoices(["low", "high", "max"], "max"), ["low", "high", "max"], "候補の並びを保つ");
  assert.deepEqual(effortChoices(["low", "high"], "zzz"), ["low", "high", "zzz"], "知らない値は末端へ置く");
  assert.deepEqual(effortChoices(["off"], undefined), ["off"]);
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
  assert.equal(
    deriveComposerSettings(input({ health: health({ defaultModelUnset: true }) })).sendBlockedReason,
    MODEL_UNSET_GUIDE,
    "既定が未設定なら選択先を示して送信を止める",
  );
  // 無効なトリガーの理由は入力欄の下の footnote に出る。health.error は認証必須 / availability / 初期化失敗を持つ
  assert.equal(
    deriveComposerSettings(input({ health: health({ error: "APIキーが必要です" }) })).sendBlockedReason,
    "APIキーが必要です",
    "カタログを取得できない理由も footnote で読める",
  );
  assert.equal(
    deriveComposerSettings(input({ health: health({ error: "pi を起動できませんでした" }) })).sendBlockedReason,
    "pi を起動できませんでした",
    "初期化失敗も同じ経路で読める",
  );
  assert.equal(
    deriveComposerSettings(input({ health: health({ defaultModelUnset: true, error: "APIキーが必要です" }) }))
      .sendBlockedReason,
    MODEL_UNSET_GUIDE,
    "既定が未設定なら選択先の案内を優先する",
  );
  assert.equal(
    deriveComposerSettings(
      input({ health: health({ defaultModelUnset: true }), preselection: { model: { provider: "ok", id: "model" } } }),
    ).sendBlockedReason,
    undefined,
    "チャットで使うモデルを選んでいれば送れる",
  );
});

test("トリガーに出すモデル表示名を解決する", () => {
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
  assert.equal(
    deriveComposerSettings(input()).modelLabel,
    undefined,
    "モデルが未解決なら出さない (トリガーは未選択と出す)",
  );
});

test("renders unknown effort levels as-is", () => {
  assert.equal(effortLabel("xhigh"), "xHigh");
  assert.equal(effortLabel("warp"), "warp");
});

const chatWith = (runStatus: RunStatus): ComposerSettingsInput["chat"] => ({
  supportsThinking: true,
  availableThinkingLevels: ALL_THINKING_LEVELS,
  runStatus,
  runTools: {},
});

test("手動圧縮は実効 busy (running / queued / compacting) と通信中に押せない", () => {
  assert.equal(deriveComposerSettings(input()).compactDisabled, false, "idle は押せる");

  for (const status of ["running", "queued", "compacting"] as const) {
    const settings = deriveComposerSettings(input({ chat: chatWith(status) }));
    assert.equal(settings.compactDisabled, true, `${status} は押せない`);
    assert.ok(settings.compactDisabledReason, `${status} は理由を出す`);
  }
  // statusOf は idle 相当でも completed / stopped / error を返すため、idle と同じ扱いにする
  for (const status of ["idle", "completed", "stopped", "error"] as const) {
    const settings = deriveComposerSettings(input({ chat: chatWith(status) }));
    assert.equal(settings.compactDisabled, false, `${status} は押せる`);
    assert.equal(settings.compactDisabledReason, undefined);
  }

  assert.equal(deriveComposerSettings(input({ sending: true })).compactDisabled, true);
  assert.equal(deriveComposerSettings(input({ settingsChanging: true })).compactDisabled, true);
  assert.equal(deriveComposerSettings(input({ chat: chatWith("compacting") })).compactDisabledReason, "圧縮中");
  assert.equal(deriveComposerSettings(input({ chat: chatWith("running") })).compactDisabledReason, "実行中");
});
