import assert from "node:assert/strict";
import test from "node:test";
import type { AgentForm } from "../src/components/agent-settings/AgentEditorForm";
import type { AgentDef } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const {
  agentFormOf,
  agentPayloadOf,
  withAllBuiltinSkillsDisabled,
  withAllBuiltinSkillsEnabled,
  withAllCommonSkillsVisible,
  withAllToolsDisabled,
  withAllToolsEnabled,
  withBuiltinSkillToggled,
  withCommonSkillToggled,
  withToolToggled,
} = await import("../src/components/agent-settings/AgentEditorForm");

function agent(overrides: Partial<AgentDef> = {}): AgentDef {
  return { id: "agent-a", name: "実装", description: "", systemPrompt: "", skillIds: [], ...overrides };
}

const VISIBLE = ["alpha", "beta"];

/** 実際に送られるキーを見る。`JSON.stringify` は undefined のキーだけを落とす */
function sent(form: AgentForm): Record<string, unknown> {
  return JSON.parse(JSON.stringify(agentPayloadOf(form))) as Record<string, unknown>;
}
test("下書きは未指定 / 空の許可リスト / 明示リストを区別する", () => {
  assert.equal(agentFormOf(agent()).commonSkillNames, undefined);
  assert.equal(agentFormOf(undefined).commonSkillNames, undefined);
  assert.deepEqual(agentFormOf(agent({ commonSkillNames: [] })).commonSkillNames, []);
  assert.deepEqual(agentFormOf(agent({ commonSkillNames: ["writer"] })).commonSkillNames, ["writer"]);
  // カタログの配列を直接編集しないようコピーして持つ
  const catalogNames = ["writer"];
  assert.notEqual(agentFormOf(agent({ commonSkillNames: catalogNames })).commonSkillNames, catalogNames);
});

test("保存ペイロードは未指定ならキーが落ち、null は解除として送られる", () => {
  assert.equal(Object.hasOwn(sent(agentFormOf(agent())), "commonSkillNames"), false);
  assert.deepEqual(sent(agentFormOf(agent({ commonSkillNames: [] }))).commonSkillNames, []);
  assert.deepEqual(sent(agentFormOf(agent({ commonSkillNames: ["writer"] }))).commonSkillNames, ["writer"]);

  const cleared = sent(withAllCommonSkillsVisible(agentFormOf(agent({ commonSkillNames: ["writer"] }))));
  assert.equal(Object.hasOwn(cleared, "commonSkillNames"), true);
  assert.equal(cleared.commonSkillNames, null);
});

test("未指定から 1 つ外すと、いま見えている一覧 − 対象の明示リストになる", () => {
  const form = withCommonSkillToggled(agentFormOf(agent()), "beta", false, VISIBLE);
  assert.deepEqual(form.commonSkillNames, ["alpha"]);
  assert.deepEqual(sent(form).commonSkillNames, ["alpha"]);

  // 解除 (null) も全可視なので同じ結果になる
  const cleared = withCommonSkillToggled({ ...agentFormOf(agent()), commonSkillNames: null }, "alpha", false, VISIBLE);
  assert.deepEqual(cleared.commonSkillNames, ["beta"]);
});

test("明示リストのトグルは対象の名前だけを増減し、一覧に無い保存名は落とさない", () => {
  const form = { ...agentFormOf(agent()), commonSkillNames: ["alpha", "gone"] };
  assert.deepEqual(withCommonSkillToggled(form, "alpha", false, VISIBLE).commonSkillNames, ["gone"]);
  assert.deepEqual(withCommonSkillToggled(form, "beta", true, VISIBLE).commonSkillNames, ["alpha", "gone", "beta"]);
  // すでに入っている名前を再度入れても増えない
  assert.deepEqual(withCommonSkillToggled(form, "alpha", true, VISIBLE).commonSkillNames, ["alpha", "gone"]);
});

test("「すべて表示に戻す」は null を送り、undefined (キー省略) へは戻らない", () => {
  const form = withAllCommonSkillsVisible(agentFormOf(agent({ commonSkillNames: [] })));
  assert.equal(form.commonSkillNames, null);
  const payload = sent(form);
  assert.equal(Object.hasOwn(payload, "commonSkillNames"), true);
  assert.equal(payload.commonSkillNames, null);

  // 戻した後は全可視として振る舞い、外せばまた明示リストになる
  assert.deepEqual(withCommonSkillToggled(form, "beta", false, VISIBLE).commonSkillNames, ["alpha"]);
});

test("ツールの下書きも未指定 / 空の許可リスト / 明示リストを区別する", () => {
  assert.equal(agentFormOf(agent()).toolNames, undefined);
  assert.equal(agentFormOf(undefined).toolNames, undefined);
  assert.deepEqual(agentFormOf(agent({ toolNames: [] })).toolNames, []);
  assert.deepEqual(agentFormOf(agent({ toolNames: ["read"] })).toolNames, ["read"]);
  // カタログの配列を直接編集しないようコピーして持つ
  const catalogNames = ["read"];
  assert.notEqual(agentFormOf(agent({ toolNames: catalogNames })).toolNames, catalogNames);
});

test("ツールの保存ペイロードは未指定ならキーが落ち、null は解除として送られる", () => {
  assert.equal(Object.hasOwn(sent(agentFormOf(agent())), "toolNames"), false);
  assert.deepEqual(sent(agentFormOf(agent({ toolNames: [] }))).toolNames, []);
  assert.deepEqual(sent(agentFormOf(agent({ toolNames: ["read"] }))).toolNames, ["read"]);

  const cleared = sent(withAllToolsEnabled(agentFormOf(agent({ toolNames: ["read"] }))));
  assert.equal(Object.hasOwn(cleared, "toolNames"), true);
  assert.equal(cleared.toolNames, null);
  assert.deepEqual(sent(withAllToolsDisabled(agentFormOf(agent()))).toolNames, []);
});

test("ツールのトグルは未指定から見えている一覧を固定し、明示リストでは増減だけする", () => {
  const form = withToolToggled(agentFormOf(agent()), "beta", false, VISIBLE);
  assert.deepEqual(form.toolNames, ["alpha"]);
  assert.deepEqual(sent(form).toolNames, ["alpha"]);

  const explicit = { ...agentFormOf(agent()), toolNames: ["alpha", "gone"] };
  assert.deepEqual(withToolToggled(explicit, "alpha", false, VISIBLE).toolNames, ["gone"]);
  assert.deepEqual(withToolToggled(explicit, "beta", true, VISIBLE).toolNames, ["alpha", "gone", "beta"]);
  // 一覧に無い保存名も落とさない
  assert.deepEqual(withToolToggled(explicit, "beta", false, VISIBLE).toolNames, ["alpha", "gone"]);
});

test("一覧を取得できないときの下書きは編集前のまま送る", () => {
  // 取得失敗では欄そのものを出さない (skillSelector.test.ts) ので、下書きを変える入口が無い。
  // 触っていない下書きがそのまま渡り、未指定ならキーが落ち、[] ならすべて OFF のままであることを固定する
  assert.equal(Object.hasOwn(sent(agentFormOf(agent())), "commonSkillNames"), false);
  assert.deepEqual(sent(agentFormOf(agent({ commonSkillNames: [] }))).commonSkillNames, []);
});

test("組み込みの下書きも未指定 / 空の許可リスト / 明示リストを区別する", () => {
  assert.equal(agentFormOf(agent()).builtinSkillNames, undefined);
  assert.equal(agentFormOf(undefined).builtinSkillNames, undefined);
  assert.deepEqual(agentFormOf(agent({ builtinSkillNames: [] })).builtinSkillNames, []);
  assert.deepEqual(agentFormOf(agent({ builtinSkillNames: ["serve"] })).builtinSkillNames, ["serve"]);
  // カタログの配列を直接編集しないようコピーして持つ
  const catalogNames = ["serve"];
  assert.notEqual(agentFormOf(agent({ builtinSkillNames: catalogNames })).builtinSkillNames, catalogNames);
});

test("組み込みの全外しは空の明示リスト、使用への復帰は null で送る", () => {
  const disabled = sent(withAllBuiltinSkillsDisabled(agentFormOf(agent())));
  assert.deepEqual(disabled.builtinSkillNames, []);

  const enabled = sent(withAllBuiltinSkillsEnabled(agentFormOf(agent({ builtinSkillNames: [] }))));
  assert.equal(Object.hasOwn(enabled, "builtinSkillNames"), true);
  assert.equal(enabled.builtinSkillNames, null);
});

test("組み込みのトグルは未指定から見えている一覧を固定し、明示リストでは増減だけする", () => {
  const form = withBuiltinSkillToggled(agentFormOf(agent()), "beta", false, VISIBLE);
  assert.deepEqual(form.builtinSkillNames, ["alpha"]);
  assert.deepEqual(sent(form).builtinSkillNames, ["alpha"]);

  const explicit = { ...agentFormOf(agent()), builtinSkillNames: ["alpha", "gone"] };
  assert.deepEqual(withBuiltinSkillToggled(explicit, "alpha", false, VISIBLE).builtinSkillNames, ["gone"]);
  assert.deepEqual(withBuiltinSkillToggled(explicit, "beta", true, VISIBLE).builtinSkillNames, [
    "alpha",
    "gone",
    "beta",
  ]);
});
