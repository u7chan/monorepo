import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentField } from "../src/components/composer/AgentField";
import { AgentLabel } from "../src/components/composer/AgentLabel";
import type { AgentDef } from "../src/types";

const agents: AgentDef[] = ["ずんだもん", "コードレビュー", "汎用アシスタント"].map((name, i) => ({
  id: String(i),
  name,
  description: "",
  systemPrompt: "",
  skillIds: [],
}));

test("セッション中のエージェント名は読み取り専用で、未作成チャットでは選択できる", () => {
  const label = renderToStaticMarkup(
    createElement(AgentLabel, {
      agents,
      name: "保存時の名前",
      icon: undefined,
      compact: false,
    }),
  );
  assert.ok(label.includes("保存時の名前"));
  for (const interactive of ["<button", "popover=", "aria-haspopup", "role=", "tabindex"]) {
    assert.ok(!label.includes(interactive), interactive);
  }
  const props = { agents, agentId: "1", compact: false, onChangeAgent: () => {} };
  const inSession = renderToStaticMarkup(
    createElement(AgentField, {
      ...props,
      sessionAgent: { name: "保存時の名前" },
    }),
  );
  assert.ok(inSession.includes("保存時の名前"));
  assert.ok(!inSession.includes('aria-haspopup="listbox"'));
  const newChat = renderToStaticMarkup(createElement(AgentField, props));
  assert.ok(newChat.includes('aria-haspopup="listbox"'));
});
