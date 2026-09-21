import assert from "node:assert/strict";
import test from "node:test";
import { adoptKnownAgentId, selectableAgents } from "../src/lib/agentSelection";
import type { AgentDef, CatalogResponse } from "../src/types";

const agent = (id: string): AgentDef => ({ id, name: id, description: "", systemPrompt: "", skillIds: [] });

test("selectableAgents puts the built-in agent before the user-defined ones", () => {
  const catalog: CatalogResponse = {
    builtinAgent: agent("agent-general"),
    agents: [agent("agent-code")],
    skills: [],
  };
  assert.deepEqual(
    selectableAgents(catalog).map((item) => item.id),
    ["agent-general", "agent-code"],
  );
});

test("selectableAgents tolerates a catalog that is not loaded yet", () => {
  // 取得前の初期状態はビルトインが null
  assert.deepEqual(selectableAgents({ builtinAgent: null, agents: [], skills: [] }), []);
});

test("adopts the snapshot agent when the catalog still has it", () => {
  const agents = [agent("agent-general"), agent("agent-code")];
  assert.equal(adoptKnownAgentId(agents, "agent-code", "agent-general"), "agent-code");
});

test("keeps the current selection when the snapshot agent is gone", () => {
  // 削除済み / ID 変更前のエージェントを指すセッションを開いても、選択に持ち込まない
  const agents = [agent("agent-general")];
  assert.equal(adoptKnownAgentId(agents, "agent-zundamon", "agent-general"), "agent-general");
  assert.equal(adoptKnownAgentId(agents, undefined, "agent-general"), "agent-general");
});
