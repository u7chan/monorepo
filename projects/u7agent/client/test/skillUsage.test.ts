// スキルの「使用中エージェント数」。エージェントごとに許可リストを適用した後の実効集合を数え、
// 同名の共通 / 組み込みは共通を優先する (server/src/file-skills.ts の解決と同じ)。
// 一覧の `overridden` だけで一律 0 にすると「共通を外して組み込みを使う」反例を取り違える。
import assert from "node:assert/strict";
import test from "node:test";
import { effectiveSkills, skillUsageByPath, skillUsageCount } from "../src/lib/skillUsage";
import type { AgentDef, FileSkillInfo } from "../src/types";

/** 定義の null (解除) も作れるようにする。AgentDef 自体は null を持たない (フォームの送信専用の値) */
function agent(
  id: string,
  overrides: { commonSkillNames?: string[] | null; builtinSkillNames?: string[] | null } = {},
): AgentDef {
  return { id, name: id, description: "", systemPrompt: "", ...overrides } as AgentDef;
}

function skill(name: string, overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return {
    name,
    description: "",
    path: `/workspace/.agents/skills/${name}/SKILL.md`,
    relativePath: `.agents/skills/${name}/SKILL.md`,
    scope: "user",
    disableModelInvocation: false,
    shadowed: [],
    overridden: false,
    ...overrides,
  };
}

function builtin(name: string, overrides: Partial<FileSkillInfo> = {}): FileSkillInfo {
  return skill(name, {
    path: `/workspace/.u7agent/builtin-skills/${name}/SKILL.md`,
    relativePath: `.u7agent/builtin-skills/${name}/SKILL.md`,
    scope: "builtin",
    overridden: true,
    version: "1",
    ...overrides,
  });
}

function countOf(usage: ReturnType<typeof skillUsageByPath>, target: FileSkillInfo): number {
  return usage.get(target.relativePath)?.length ?? 0;
}

test("未指定 / 解除は全可視、空の明示リストは 0、明示リストはその名前だけを数える", () => {
  const alpha = skill("alpha");
  const beta = skill("beta");
  const skills = [alpha, beta];
  const usage = skillUsageByPath({
    agents: [agent("a1"), agent("a2", { commonSkillNames: null }), agent("a3", { commonSkillNames: [] })],
    skills,
  });
  assert.equal(countOf(usage, alpha), 2);
  assert.equal(countOf(usage, beta), 2);

  const explicit = skillUsageByPath({
    agents: [agent("a1", { commonSkillNames: ["alpha"] })],
    skills,
  });
  assert.equal(countOf(explicit, alpha), 1);
  assert.equal(countOf(explicit, beta), 0);
});

test("許可リストで外したスキルは実効から落ちる", () => {
  const alpha = skill("alpha");
  const beta = skill("beta");
  const usage = skillUsageByPath({
    agents: [agent("a1", { commonSkillNames: ["beta"] })],
    skills: [alpha, beta],
  });
  assert.equal(countOf(usage, alpha), 0);
  assert.equal(countOf(usage, beta), 1);
});

test("ビルトインの汎用アシスタントは許可リストを持たないため集計しない", () => {
  const alpha = skill("alpha");
  const usage = skillUsageByPath({
    agents: [agent("builtin-agent"), agent("a1")],
    skills: [alpha],
    builtinAgentId: "builtin-agent",
  });
  assert.equal(countOf(usage, alpha), 1);
});

test("同名は共通を優先し、共通を外していれば組み込みを数える (反例)", () => {
  const commonServe = skill("serve");
  const builtinServe = builtin("serve");
  const skills = [commonServe, builtinServe];

  // 既定 (未指定) では共通が実効。上書きされた組み込みは数えない
  const defaults = skillUsageByPath({ agents: [agent("a1")], skills });
  assert.equal(countOf(defaults, commonServe), 1);
  assert.equal(countOf(defaults, builtinServe), 0);
  assert.equal(builtinServe.overridden, true, "一覧では上書きの警告が出る行");

  // 反例: 共通 serve があり、共有を [] で外して組み込み serve だけを選んだエージェントは
  // 組み込み serve を使う。`overridden` だけで一律 0 にすると 0 と誤る
  const usingBuiltin = skillUsageByPath({
    agents: [agent("a1", { commonSkillNames: [], builtinSkillNames: ["serve"] })],
    skills,
  });
  assert.equal(countOf(usingBuiltin, commonServe), 0);
  assert.equal(countOf(usingBuiltin, builtinServe), 1);
});

test("影になった共通行 (shadowed) は実効にならない", () => {
  const winner = skill("alpha", { relativePath: ".agents/skills/alpha/SKILL.md" });
  const shadowed = skill("alpha", {
    relativePath: ".agents/skills/alpha-old/SKILL.md",
  });
  winner.shadowed = [{ path: "/workspace/.agents/skills/alpha-old/SKILL.md", relativePath: shadowed.relativePath }];
  const usage = skillUsageByPath({ agents: [agent("a1")], skills: [winner, shadowed] });
  assert.equal(countOf(usage, winner), 1);
  assert.equal(countOf(usage, shadowed), 0);
});

test("プロジェクトスコープも共通の許可リストで数える", () => {
  const project = skill("alpha", {
    scope: "project",
    path: "/workspace/project/.agents/skills/alpha/SKILL.md",
    relativePath: ".agents/skills/alpha/SKILL.md",
  });
  const usage = skillUsageByPath({ agents: [agent("a1", { commonSkillNames: ["alpha"] })], skills: [project] });
  assert.equal(countOf(usage, project), 1);
});

test("実効集合は名前ごとに共通 / 組み込みの 1 つだけを持つ", () => {
  const effective = effectiveSkills(
    { commonSkillNames: ["serve", "alpha"], builtinSkillNames: ["serve", "browser"] },
    { common: ["serve", "alpha"], builtin: ["serve", "browser"] },
  );
  assert.deepEqual(
    [...effective],
    [
      ["serve", "common"],
      ["alpha", "common"],
      ["browser", "builtin"],
    ],
  );
});

test("件数は未取得なら表示せず、行が無いスキルは 0 体", () => {
  const alpha = skill("alpha");
  const usage = skillUsageByPath({ agents: [], skills: [alpha] });
  assert.equal(skillUsageCount(usage, alpha.relativePath), 0);
  assert.equal(skillUsageCount(undefined, alpha.relativePath), undefined);
});
