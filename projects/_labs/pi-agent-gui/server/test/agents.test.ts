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
