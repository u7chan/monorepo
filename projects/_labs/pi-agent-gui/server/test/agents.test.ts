import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";

const definitions = {
  agents: [
    {
      id: "agent-imported",
      name: "読み込みエージェント",
      description: "インポートされた定義",
      systemPrompt: "短く答えてください。",
      skillIds: ["skill-imported", "skill-missing"],
    },
  ],
  skills: [
    {
      id: "skill-imported",
      name: "インポートスキル",
      description: "テスト用スキル",
      prompt: "テスト用の指示です。",
    },
  ],
};

test("replaces the in-memory catalog from a JSON definition snapshot", () => {
  const catalog = createAgentCatalog();
  const result = catalog.replace(definitions);

  assert.deepEqual(result, {
    agents: [
      {
        id: "agent-imported",
        name: "読み込みエージェント",
        description: "インポートされた定義",
        systemPrompt: "短く答えてください。",
        skillIds: ["skill-imported"],
      },
    ],
    skills: [
      {
        id: "skill-imported",
        name: "インポートスキル",
        description: "テスト用スキル",
        prompt: "テスト用の指示です。",
      },
    ],
  });
  assert.equal(catalog.getAgent("agent-builder"), undefined);
});

test("built-in agents keep model and thinkingLevel unspecified", () => {
  const catalog = createAgentCatalog();
  for (const agent of catalog.listAgents()) {
    assert.equal(Object.hasOwn(agent, "model"), false, `${agent.id} must omit model`);
    assert.equal(Object.hasOwn(agent, "thinkingLevel"), false, `${agent.id} must omit thinkingLevel`);
  }
  assert.deepEqual(catalog.snapshot().agents.map((agent) => agent.id), [
    "agent-builder",
    "agent-reviewer",
    "agent-cat",
  ]);
});

test("creates and updates agents with an independent model / thinkingLevel", () => {
  const catalog = createAgentCatalog();

  // 片方だけ / 両方
  const modelOnly = catalog.createAgent({
    name: "モデル指定",
    model: { provider: "openai", id: "gpt-5.5" },
  });
  assert.deepEqual(modelOnly.model, { provider: "openai", id: "gpt-5.5" });
  assert.equal(Object.hasOwn(modelOnly, "thinkingLevel"), false);

  const effortOnly = catalog.createAgent({ name: "Effort 指定", thinkingLevel: "high" });
  assert.equal(effortOnly.thinkingLevel, "high");
  assert.equal(Object.hasOwn(effortOnly, "model"), false);

  const both = catalog.createAgent({
    name: "両方指定",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(both.model, { provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(both.thinkingLevel, "xhigh");

  // キー省略の更新は保持、null は指定解除、値は上書き
  const kept = catalog.updateAgent(both.id, { description: "説明だけ更新" });
  assert.deepEqual(kept?.model, { provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.equal(kept?.thinkingLevel, "xhigh");

  const clearedModel = catalog.updateAgent(both.id, { model: null });
  assert.equal(Object.hasOwn(clearedModel ?? {}, "model"), false);
  assert.equal(clearedModel?.thinkingLevel, "xhigh");

  const replaced = catalog.updateAgent(both.id, {
    model: { provider: "openai", id: "gpt-5.5" },
    thinkingLevel: "minimal",
  });
  assert.deepEqual(replaced?.model, { provider: "openai", id: "gpt-5.5" });
  assert.equal(replaced?.thinkingLevel, "minimal");

  const clearedBoth = catalog.updateAgent(both.id, { model: null, thinkingLevel: null });
  assert.equal(Object.hasOwn(clearedBoth ?? {}, "model"), false);
  assert.equal(Object.hasOwn(clearedBoth ?? {}, "thinkingLevel"), false);

  // 作成時の null は未指定として扱う
  const nullCreated = catalog.createAgent({ name: "null 作成", model: null, thinkingLevel: null });
  assert.equal(Object.hasOwn(nullCreated, "model"), false);
  assert.equal(Object.hasOwn(nullCreated, "thinkingLevel"), false);
});

test("rejects malformed model references and unknown thinking levels with 400", () => {
  const catalog = createAgentCatalog();
  const invalidInputs: unknown[] = [
    { name: "x", model: { provider: "openai" } },
    { name: "x", model: { provider: "", id: "gpt" } },
    { name: "x", model: "openai/gpt" },
    { name: "x", model: { provider: 42, id: "gpt" } },
    { name: "x", thinkingLevel: "ultra" },
    { name: "x", thinkingLevel: 3 },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => catalog.createAgent(input),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      `must reject ${JSON.stringify(input)}`,
    );
  }

  // 不正な更新も 400 (既存値は保持)
  const agent = catalog.getAgent("agent-cat");
  assert.throws(
    () => catalog.updateAgent("agent-cat", { thinkingLevel: "ultra" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent("agent-cat"), agent);
});

test("imports old definitions without the new keys and exports only specified ones", () => {
  const catalog = createAgentCatalog();

  // 旧形式 (model / thinkingLevel なし) の import はそのまま受け付ける
  const imported = catalog.replace({
    skills: [],
    agents: [{ id: "agent-legacy", name: "旧形式", skillIds: [] }],
  });
  assert.equal(Object.hasOwn(imported.agents[0], "model"), false);
  assert.equal(Object.hasOwn(imported.agents[0], "thinkingLevel"), false);

  // 新形式の import: 利用不能でも形式が正しければ保持する
  const next = catalog.replace({
    skills: [],
    agents: [
      { id: "agent-legacy", name: "旧形式", skillIds: [] },
      {
        id: "agent-new",
        name: "新形式",
        skillIds: [],
        model: { provider: "openai", id: "gpt-5.5" },
        thinkingLevel: "max",
      },
    ],
  });
  assert.deepEqual(next.agents[1].model, { provider: "openai", id: "gpt-5.5" });
  assert.equal(next.agents[1].thinkingLevel, "max");
  // export (= GET /api/agents) は未指定項目のキーを省く
  assert.equal(Object.hasOwn(next.agents[0], "model"), false);
  assert.equal(Object.hasOwn(next.agents[0], "thinkingLevel"), false);

  assert.throws(
    () => catalog.replace({ skills: [], agents: [{ name: "不正", thinkingLevel: "ultra" }] }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  // 不正な import は従来のカタログを壊さない
  assert.equal(catalog.getAgent("agent-new")?.thinkingLevel, "max");
});
