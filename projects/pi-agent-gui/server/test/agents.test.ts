import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";

const DEFAULT_BUILDER_SUGGESTIONS = [
  { label: "プロジェクトを説明して", prompt: "このプロジェクトの構成を簡単に教えて" },
  { label: "テストを確認して", prompt: "まずテストがあるか確認して" },
  { label: "README をレビューして", prompt: "README を読んで改善案を3つ出して" },
];

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
    "agent-general",
    "agent-builder",
    "agent-reviewer",
    "agent-researcher",
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

test("only the code builder ships with default suggestions", () => {
  const catalog = createAgentCatalog();
  const agents = catalog.listAgents();
  assert.deepEqual(
    agents.find((agent) => agent.id === "agent-builder")?.suggestions,
    DEFAULT_BUILDER_SUGGESTIONS,
  );
  for (const agent of agents) {
    if (agent.id === "agent-builder") continue;
    assert.equal(Object.hasOwn(agent, "suggestions"), false, `${agent.id} must omit suggestions`);
  }
});

test("normalizes agent suggestions on create", () => {
  const catalog = createAgentCatalog();

  // 配列でなければ未指定 (キー省略)。null / 文字列 / オブジェクト / 数値はすべて同じ扱い
  const nonArrays: unknown[] = [null, undefined, "プロンプト", { label: "x", prompt: "y" }, 42];
  for (const suggestions of nonArrays) {
    const agent = catalog.createAgent({ name: "非配列", suggestions });
    assert.equal(
      Object.hasOwn(agent, "suggestions"),
      false,
      `must omit suggestions for ${JSON.stringify(suggestions)}`,
    );
  }

  // label / prompt が空・非文字列の要素は捨てる
  const kept = { label: "残る", prompt: "残るプロンプト" };
  const dropped = catalog.createAgent({
    name: "空要素",
    suggestions: [
      { label: "   ", prompt: "有効なプロンプト" },
      { label: "有効なラベル", prompt: "   " },
      { label: 42, prompt: "数値ラベル" },
      { prompt: "ラベルなし" },
      null,
      "文字列",
      kept,
    ],
  });
  assert.deepEqual(dropped.suggestions, [{ label: "残る", prompt: "残るプロンプト" }]);
  // 元の入力オブジェクトを参照で持ち回らない
  assert.notEqual(dropped.suggestions?.[0], kept);

  // 正規化後に 0 件ならキーを省略する
  const empty = catalog.createAgent({
    name: "全部空",
    suggestions: [{ label: "", prompt: "" }, { label: " ", prompt: " " }, null],
  });
  assert.equal(Object.hasOwn(empty, "suggestions"), false);
});

test("trims, truncates and deduplicates suggestions before the 6 item cap", () => {
  const catalog = createAgentCatalog();

  const trimmed = catalog.createAgent({
    name: "trim と切り詰め",
    suggestions: [{ label: `  ${"い".repeat(70)}  `, prompt: `  ${"う".repeat(600)}  ` }],
  });
  assert.equal(trimmed.suggestions?.[0].label, "い".repeat(60));
  assert.equal(trimmed.suggestions?.[0].prompt, "う".repeat(500));

  // prompt の重複は最初の 1 件だけ残す (trim 後で比較する)
  const deduped = catalog.createAgent({
    name: "重複排除",
    suggestions: [
      { label: "1 件目", prompt: "同じ" },
      { label: "2 件目", prompt: "同じ" },
      { label: "3 件目", prompt: " 同じ " },
      { label: "別", prompt: "別のプロンプト" },
    ],
  });
  assert.deepEqual(deduped.suggestions, [
    { label: "1 件目", prompt: "同じ" },
    { label: "別", prompt: "別のプロンプト" },
  ]);

  // 重複排除が先なので、重複は 6 件の枠を消費せず 7 件目のユニークが残る
  const capped = catalog.createAgent({
    name: "上限",
    suggestions: [
      { label: "A", prompt: "A" },
      { label: "A の重複", prompt: "A" },
      { label: "B", prompt: "B" },
      { label: "C", prompt: "C" },
      { label: "D", prompt: "D" },
      { label: "E", prompt: "E" },
      { label: "F", prompt: "F" },
      { label: "G", prompt: "G" },
    ],
  });
  assert.deepEqual(capped.suggestions?.map((suggestion) => suggestion.prompt), ["A", "B", "C", "D", "E", "F"]);
});

test("updates and clears agent suggestions", () => {
  const catalog = createAgentCatalog();

  // キー省略の更新は保持する
  const kept = catalog.updateAgent("agent-builder", { description: "説明だけ更新" });
  assert.deepEqual(kept?.suggestions, DEFAULT_BUILDER_SUGGESTIONS);

  const replaced = catalog.updateAgent("agent-builder", {
    suggestions: [{ label: " 足す ", prompt: " 追加のプロンプト " }],
  });
  assert.deepEqual(replaced?.suggestions, [{ label: "足す", prompt: "追加のプロンプト" }]);

  // 空配列 / null は解除 (キー省略)
  const cleared = catalog.updateAgent("agent-builder", { suggestions: [] });
  assert.equal(Object.hasOwn(cleared ?? {}, "suggestions"), false);
  const afterClear = catalog.updateAgent("agent-builder", { description: "解除後" });
  assert.equal(Object.hasOwn(afterClear ?? {}, "suggestions"), false);

  const nullCleared = catalog.updateAgent("agent-general", {
    suggestions: [{ label: "一時", prompt: "一時的なプロンプト" }],
  });
  assert.equal(nullCleared?.suggestions?.length, 1);
  const nulled = catalog.updateAgent("agent-general", { suggestions: null });
  assert.equal(Object.hasOwn(nulled ?? {}, "suggestions"), false);
});

test("round-trips suggestions through the definition snapshot", () => {
  const catalog = createAgentCatalog();

  // エクスポート → インポート
  const replaced = catalog.replace(catalog.snapshot());
  assert.deepEqual(
    replaced.agents.find((agent) => agent.id === "agent-builder")?.suggestions,
    DEFAULT_BUILDER_SUGGESTIONS,
  );
  // snapshot に乗るので、別カタログの import も通る
  assert.deepEqual(
    catalog.snapshot().agents.find((agent) => agent.id === "agent-builder")?.suggestions,
    DEFAULT_BUILDER_SUGGESTIONS,
  );

  // 旧形式 (suggestions なし) の import はそのまま通る
  const oldForm = catalog.replace({ skills: [], agents: [{ id: "agent-legacy", name: "旧形式", skillIds: [] }] });
  assert.equal(Object.hasOwn(oldForm.agents[0], "suggestions"), false);

  const legacy = catalog.replace({
    skills: [],
    agents: [{ id: "agent-legacy", name: "旧形式", skillIds: [], suggestions: [{ label: "l", prompt: "p" }] }],
  });
  assert.deepEqual(legacy.agents[0].suggestions, [{ label: "l", prompt: "p" }]);
});

test("public agents copy the suggestions of the internal catalog", () => {
  const catalog = createAgentCatalog();
  const internal = catalog.getAgent("agent-builder")?.suggestions;
  const exported = catalog.listAgents().find((agent) => agent.id === "agent-builder")?.suggestions;
  assert.ok(exported && internal);
  assert.notEqual(exported, internal);
  assert.notEqual(exported[0], internal[0]);

  exported[0].label = "書き換え";
  exported.push({ label: "追加", prompt: "追加のプロンプト" });
  assert.deepEqual(catalog.getAgent("agent-builder")?.suggestions, DEFAULT_BUILDER_SUGGESTIONS);
  assert.deepEqual(
    catalog.snapshot().agents.find((agent) => agent.id === "agent-builder")?.suggestions,
    DEFAULT_BUILDER_SUGGESTIONS,
  );
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
  const agent = catalog.getAgent("agent-general");
  assert.throws(
    () => catalog.updateAgent("agent-general", { thinkingLevel: "ultra" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(catalog.getAgent("agent-general"), agent);
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
