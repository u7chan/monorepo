import assert from "node:assert/strict";
import test from "node:test";
import { adoptKnownAgentId } from "../src/lib/agentSelection";
import type { AgentDef } from "../src/types";

const agent = (id: string): AgentDef => ({ id, name: id, description: "", systemPrompt: "", skillIds: [] });

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
