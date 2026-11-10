// バックアップの差分計算・正規化 (純粋関数) と、アプリ DB の差分適用 / 全削除を検証する。
// ここは ZIP / サンドボックスを扱わない層なので、判定の規則そのものだけを見る。
import assert from "node:assert/strict";
import test from "node:test";
import { AppDb, type PromptRow, type StoredAgent } from "../src/app-db";
import { agentKey, normalizeBackupAgent, planAgents, planPrompts, planSkills } from "../src/backup/plan";
import type { BackupAgent, BackupPrompt } from "../src/schema";

function prompt(id: string, label: string, text = `text-${id}`): PromptRow {
  return { id, kind: "custom", label, prompt: text };
}

function agent(id: string, overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id,
    name: `agent-${id}`,
    description: "",
    systemPrompt: "",
    promptIds: [],
    ...overrides,
  };
}

test("planPrompts は追加 / 更新 / 同一 / 削除 / 並び替えを分けて数える", () => {
  const current = [prompt("a", "A"), prompt("b", "B"), prompt("c", "C")];
  const backup: BackupPrompt[] = [
    { id: "c", label: "C", prompt: "text-c" },
    { id: "a", label: "A2", prompt: "text-a" },
    { id: "d", label: "D", prompt: "text-d" },
  ];
  const plan = planPrompts({ current, backup, survivingAgents: [] });
  assert.deepEqual(plan.plan.counts, { added: 1, updated: 1, identical: 0, removed: 1, reordered: 1 });
  assert.deepEqual(
    plan.plan.items.map((item) => [item.id, item.status]),
    [
      ["c", "reordered"],
      ["a", "updated"],
      ["d", "added"],
      ["b", "removed"],
    ],
  );
  // 並びが変わるだけの行は counts.reordered に入り、内容は書き換えない
  assert.equal(plan.upserts.length, 2);
  assert.deepEqual(plan.deleteIds, ["b"]);
  assert.deepEqual(plan.order, ["c", "a", "d"]);
  assert.equal(plan.plan.total, 3);
});

test("planPrompts は内容も並びも同じなら 1 件も upsert しない", () => {
  const current = [prompt("a", "A"), prompt("b", "B")];
  const backup: BackupPrompt[] = [
    { id: "a", label: "A", prompt: "text-a" },
    { id: "b", label: "B", prompt: "text-b" },
  ];
  const plan = planPrompts({ current, backup, survivingAgents: [] });
  assert.deepEqual(plan.plan.counts, { added: 0, updated: 0, identical: 2, removed: 0, reordered: 0 });
  assert.equal(plan.upserts.length, 0);
});

test("planPrompts は適用後に残るエージェントが参照する削除対象をブロックする", () => {
  const current = [prompt("keep", "Keep"), prompt("gone", "Gone")];
  const backup: BackupPrompt[] = [{ id: "keep", label: "Keep", prompt: "text-keep" }];
  const blocked = planPrompts({
    current,
    backup,
    survivingAgents: [{ name: "A", promptIds: ["gone"] }],
  });
  assert.equal(blocked.plan.blocker?.code, "prompt_in_use");
  assert.deepEqual(blocked.plan.blocker?.names, ["Gone"]);

  // 同じ ID がバックアップにもある (= 更新) ならブロックしない
  const updated = planPrompts({
    current,
    backup: [{ id: "gone", label: "Gone", prompt: "changed" }],
    survivingAgents: [{ name: "A", promptIds: ["gone"] }],
  });
  assert.equal(updated.plan.blocker, null);
});

test("normalizeBackupAgent はモデルの可否と promptIds の参照を実効値へ寄せる", () => {
  const entry: BackupAgent = {
    id: "agent-a",
    name: "A",
    description: "",
    systemPrompt: "",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    promptIds: ["missing", "kept"],
    toolNames: ["bash"],
  };
  const kept = normalizeBackupAgent(entry, {
    promptUniverse: new Set(["kept"]),
    model: () => "unknown",
    knownTools: new Set(["bash"]),
  });
  assert.deepEqual(kept.agent.model, { provider: "p", id: "m" });
  assert.deepEqual(kept.agent.promptIds, ["kept"]);
  assert.equal(kept.agent.thinkingLevel, "high");
  assert.deepEqual(
    kept.warnings.map((warning) => warning.code),
    ["prompt_reference_removed", "model_unknown", "model_settings_missing"],
  );

  const dropped = normalizeBackupAgent(entry, {
    promptUniverse: new Set(["kept"]),
    model: () => "not_in_catalog",
    knownTools: new Set(["bash"]),
  });
  assert.equal(dropped.agent.model, undefined);
  assert.equal(dropped.agent.thinkingLevel, "high");
  assert.deepEqual(
    dropped.warnings.map((warning) => warning.code),
    ["prompt_reference_removed", "model_unavailable"],
  );

  const excluded = normalizeBackupAgent(entry, {
    promptUniverse: new Set(["kept"]),
    model: () => "not_allowed",
    knownTools: new Set(["bash", "edit"]),
  });
  assert.equal(excluded.agent.model, undefined);
  assert.deepEqual(
    excluded.warnings.map((warning) => warning.code),
    ["prompt_reference_removed", "model_not_allowed"],
  );
});

test("正規化後のエージェントは 2 回目の差分で同一になる", () => {
  const entry: BackupAgent = {
    id: "agent-a",
    name: "A",
    description: "",
    systemPrompt: "",
    model: { provider: "p", id: "m" },
    promptIds: ["bundled", "unknown"],
    commonSkillNames: ["skill-x"],
  };
  const context = {
    promptUniverse: new Set(["bundled"]),
    model: () => "not_in_catalog" as const,
    knownCommonSkills: new Set<string>(),
  };
  const first = normalizeBackupAgent(entry, context);
  const stored: StoredAgent = { ...first.agent, promptIds: [...(first.agent.promptIds ?? [])] };
  const plan = planAgents({ current: [stored], normalized: [first] });
  assert.deepEqual(plan.plan.counts, { added: 0, updated: 0, identical: 1, removed: 0, reordered: 0 });
  assert.equal(agentKey(stored), agentKey(first.agent));
});

test("planAgents はバックアップに無い行を削除し、並びをバックアップ順にそろえる", () => {
  const current = [agent("a"), agent("b"), agent("c")];
  const normalized = [
    { agent: agent("c"), warnings: [] },
    { agent: agent("a", { name: "renamed" }), warnings: [] },
  ];
  const plan = planAgents({ current, normalized });
  assert.deepEqual(plan.deleteIds, ["b"]);
  assert.deepEqual(plan.order, ["c", "a"]);
  assert.equal(plan.plan.counts.removed, 1);
  assert.equal(plan.plan.counts.updated, 1);
  assert.equal(plan.plan.total, 2);
});

test("planSkills は取り込めない行があれば対象をブロックし、バックアップに無い名前を削除対象にする", () => {
  const plan = planSkills({
    current: ["alpha", "old"],
    importPlan: {
      skills: [
        { name: "alpha", status: "conflict" },
        { name: "fresh", status: "new" },
        { name: "same", status: "identical" },
        { name: "broken", status: "invalid", reason: "読めません" },
      ],
      entries: 4,
      bytes: 10,
    },
    blocker: null,
  });
  assert.equal(plan.plan.blocker?.code, "skill_invalid");
  assert.deepEqual(plan.plan.blocker?.names, ["broken"]);
  assert.deepEqual(plan.replaceNames, ["alpha"]);
  assert.deepEqual(plan.importNames, ["alpha", "fresh"]);
  assert.deepEqual(plan.deleteNames, ["old"]);
  assert.equal(plan.plan.counts.removed, 1);
  assert.equal(plan.plan.total, 3);
});

test("applyDefinitions は途中で失敗したらプロンプトも巻き戻す", () => {
  const db = AppDb.open({ storeDir: null });
  try {
    const before = db.listPrompts().filter((row) => row.kind === "custom").length;
    assert.throws(() =>
      db.applyDefinitions({
        deleteAgentIds: [],
        // 参照先の無い promptId は外部キーで失敗する (部分適用を残さないことの確認)
        promptUpserts: [prompt("prompt-new", "New")],
        agentUpserts: [agent("agent-bad", { promptIds: ["prompt-missing"] })],
        deletePromptIds: [],
        agentOrder: [],
        promptOrder: [],
      }),
    );
    assert.equal(db.listPrompts().filter((row) => row.kind === "custom").length, before);
    assert.equal(db.getAgent("agent-bad"), undefined);
  } finally {
    db.close();
  }
});

test("applyDefinitions は削除 → 追加の順で適用し、使用中のプロンプトを消せる", () => {
  const db = AppDb.open({ storeDir: null });
  try {
    db.insertPrompt(prompt("prompt-old", "Old"));
    db.saveAgent(agent("agent-1", { promptIds: ["prompt-old"] }));
    db.applyDefinitions({
      deleteAgentIds: ["agent-1"],
      promptUpserts: [prompt("prompt-new", "New")],
      agentUpserts: [agent("agent-2", { promptIds: ["prompt-new"] })],
      deletePromptIds: ["prompt-old"],
      agentOrder: ["agent-2"],
      promptOrder: ["prompt-new"],
    });
    assert.equal(db.getPrompt("prompt-old"), undefined);
    assert.deepEqual(db.getAgent("agent-2")?.promptIds, ["prompt-new"]);
    assert.equal(db.getAgent("agent-1"), undefined);
    assert.deepEqual(
      db
        .listAgents()
        .map((row) => row.id)
        .sort(),
      ["agent-2", "agent-zundamon"],
    );
  } finally {
    db.close();
  }
});

test("deleteAllDefinitions は使用中のプロンプトがあってもエージェントを先に消す", () => {
  const db = AppDb.open({ storeDir: null });
  try {
    db.insertPrompt(prompt("prompt-a", "A"));
    db.saveAgent(agent("agent-a", { promptIds: ["prompt-a"] }));
    const removed = db.deleteAllDefinitions();
    assert.ok(removed.agents >= 1);
    assert.equal(removed.prompts, 1);
    assert.equal(db.listAgents().length, 0);
    // 組み込みプロンプトは残る
    assert.ok(db.listPrompts().some((row) => row.kind === "builtin"));
  } finally {
    db.close();
  }
});
