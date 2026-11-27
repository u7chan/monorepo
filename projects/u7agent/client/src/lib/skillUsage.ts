/**
 * スキルの「使用中エージェント数」の導出。数えるのはユーザー定義エージェントの実効集合で、ビルトインの
 * 汎用アシスタントと実セッションは対象外。同名は共通を優先する (`overridden` だけで一律 0 にしない)。
 */
import type { AgentDef, FileSkillInfo } from "../types";
import { allowedNames } from "./agentAllowlist";

/** 実効の種別。同名なら共通 (プロジェクト / ユーザー) が組み込みに勝つ */
type EffectiveScope = "common" | "builtin";

/** relativePath → そのスキルを使うユーザー定義エージェント */
export type SkillUsage = ReadonlyMap<string, AgentDef[]>;

export type SkillUsageInput = {
  /** ユーザー定義のエージェント (カタログの `agents`。ビルトインは含まれない) */
  agents: readonly AgentDef[];
  /** `GET /api/skills/files` の一覧 (組み込みを含む) */
  skills: readonly FileSkillInfo[];
  /** 集計から外すビルトインの id。未取得なら undefined */
  builtinAgentId?: string;
};

/** スキル名の一覧。共通側はプロジェクト / ユーザーの両方を含む (どちらも `commonSkillNames` の対象) */
function namesOf(skills: readonly FileSkillInfo[]): { common: string[]; builtin: string[] } {
  const common: string[] = [];
  const builtin: string[] = [];
  for (const skill of skills) {
    const bucket = skill.scope === "builtin" ? builtin : common;
    if (!bucket.includes(skill.name)) bucket.push(skill.name);
  }
  return { common, builtin };
}

/** 1 体のエージェントの実効スキル (名前 → 種別)。許可リスト適用後の同名解決だけを行う */
export function effectiveSkills(
  agent: Pick<AgentDef, "commonSkillNames" | "builtinSkillNames">,
  names: { common: readonly string[]; builtin: readonly string[] },
): Map<string, EffectiveScope> {
  const effective = new Map<string, EffectiveScope>();
  const commonVisible = new Set(names.common);
  const builtinVisible = new Set(names.builtin);
  for (const name of allowedNames(agent.commonSkillNames, names.common)) {
    if (commonVisible.has(name)) effective.set(name, "common");
  }
  for (const name of allowedNames(agent.builtinSkillNames, names.builtin)) {
    // 共通が実効なら組み込みは落とす (上書きされた組み込みは使われない)
    if (!effective.has(name) && builtinVisible.has(name)) effective.set(name, "builtin");
  }
  return effective;
}

/**
 * 一覧の行ごとの使用中エージェント。影になった行 (`shadowed` に載っている側) は実効にならないため数えない。
 * 組み込みは同名の共通が実効のときだけ落ち、共通を外したエージェントでは数えられる。
 */
export function skillUsageByPath({ agents, skills, builtinAgentId }: SkillUsageInput): SkillUsage {
  const names = namesOf(skills);
  const shadowed = new Set(skills.flatMap((skill) => skill.shadowed.map((item) => item.relativePath)));
  const usage = new Map<string, AgentDef[]>();
  for (const skill of skills) usage.set(skill.relativePath, []);
  for (const agent of agents) {
    if (agent.id === builtinAgentId) continue;
    const effective = effectiveSkills(agent, names);
    for (const skill of skills) {
      const scope: EffectiveScope = skill.scope === "builtin" ? "builtin" : "common";
      if (effective.get(skill.name) !== scope) continue;
      if (scope === "common" && shadowed.has(skill.relativePath)) continue;
      usage.get(skill.relativePath)?.push(agent);
    }
  }
  return usage;
}

/** 表示用の件数。カタログを取得できていない間は呼ばない (0 と断定しない) */
export function skillUsageCount(usage: SkillUsage | undefined, relativePath: string): number | undefined {
  if (!usage) return undefined;
  return usage.get(relativePath)?.length ?? 0;
}

/** 一覧と詳細に出す集計の注記。何を数えていないかをここ 1 箇所で伝える */
export const SKILL_USAGE_NOTE =
  "ユーザー定義エージェントの定義から集計。既定の汎用アシスタントと既存セッションは対象外です。";

/** カタログを取得できていない間の注記。0 人と断定しない */
export const SKILL_USAGE_UNAVAILABLE_NOTE = "カタログを取得できていないため、使用中エージェント数を表示できません。";
