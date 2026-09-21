/**
 * 小さなインメモリカタログ。ファイルに書き出さないのは意図的で、
 * 再起動すると以下のサンプル定義に戻る。
 */
import { randomUUID } from "node:crypto";
import { ThinkingLevelSchema } from "./schema";
import type { AgentDef, AgentSuggestion, Catalog, ModelRef, SkillDef, ThinkingLevel } from "./schema";

export interface HttpError extends Error {
  statusCode?: number;
}

type SkillRecord = SkillDef;
type AgentRecord = AgentDef;

/** catalog CRUD の入力は正規化ロジックが正なので unknown で受ける */
type DefinitionInput = unknown;

/**
 * 既定は汎用アシスタント 1 体と、どのエージェントにも割り当てないサンプルスキル 1 件。
 * 口調や手順はスキルに置く分担なので、なりきりもスキル側だけで表し、使う人が選んで付ける。
 */
const DEFAULT_SKILLS: SkillRecord[] = [
  {
    id: "skill-zundamon-speech",
    name: "ずんだもんの語尾",
    description: "「〜なのだ」「〜のだ」の語尾で話す",
    prompt:
      "ずんだもんの口調で話してください。文末は「〜なのだ」「〜のだ」にし、一人称は「ボク」を使ってください。内容や説明の正確さは変えず、口調だけを変えてください。コード・コマンド・ファイルパス・エラーメッセージは書き換えず、そのまま示してください。",
  },
];

const DEFAULT_AGENTS: AgentRecord[] = [
  {
    id: "agent-general",
    name: "汎用アシスタント",
    description: "役割や口調を設定していない既定のエージェント。まずはこのまま試す",
    systemPrompt: "",
    skillIds: [],
    suggestions: [
      { label: "プロジェクトを説明して", prompt: "このプロジェクトの構成を簡単に教えて" },
      { label: "テストを確認して", prompt: "まずテストがあるか確認して" },
      { label: "README をレビューして", prompt: "README を読んで改善案を3つ出して" },
    ],
  },
];

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown, fallback = "", maxLength = 8_000): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function definitionId(value: DefinitionInput): string {
  return text((value as { id?: unknown } | null)?.id, "", 200) || randomUUID();
}

function invalid(message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = 400;
  return error;
}

function publicSkill(skill: SkillRecord): SkillDef {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
  };
}

function publicAgent(agent: AgentRecord): AgentDef {
  const result: AgentDef = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    skillIds: [...agent.skillIds],
  };
  // 未指定の項目はキーを省略する (保存・応答に null は現れない)
  if (agent.model) result.model = { ...agent.model };
  if (agent.thinkingLevel) result.thinkingLevel = agent.thinkingLevel;
  if (agent.suggestions?.length) result.suggestions = agent.suggestions.map((suggestion) => ({ ...suggestion }));
  return result;
}

/**
 * undefined / null は「未指定」(= キー省略)、形式が違うものは 400。
 */
function modelRef(value: unknown): ModelRef | undefined {
  if (value === undefined || value === null) return undefined;
  const record = value as { provider?: unknown; id?: unknown } | null;
  const provider = typeof record?.provider === "string" ? record.provider.trim() : "";
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  if (!provider || !id) throw invalid("Model must look like { provider, id }");
  return { provider, id };
}

/** undefined / null は未指定、未知の段階は 400。 */
function thinkingLevelOf(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = ThinkingLevelSchema.safeParse(typeof value === "string" ? value.trim() : value);
  if (!parsed.success) throw invalid(`Unknown thinking level: ${String(value)}`);
  return parsed.data;
}

/** 上限は 6 件。UI もこの値に合わせて「＋ 追加」を止める。 */
const SUGGESTION_LIMIT = 6;

/**
 * 配列以外は未指定として空を返す。prompt の重複は先に除いてから上限で切るので、
 * 重複が 6 件の枠を消費しない (skillIds の dedupe と同じ発想)。
 */
function normalizeSuggestions(value: unknown): AgentSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: AgentSuggestion[] = [];
  for (const item of value) {
    const record = item as { label?: unknown; prompt?: unknown } | null;
    const label = text(record?.label, "", 60);
    const prompt = text(record?.prompt, "", 500);
    if (!label || !prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    result.push({ label, prompt });
    if (result.length === SUGGESTION_LIMIT) break;
  }
  return result;
}

function makeSkill(input: DefinitionInput, id: string = randomUUID()): SkillRecord {
  const record = input as { name?: unknown; prompt?: unknown; description?: unknown } | null;
  const name = text(record?.name);
  const prompt = text(record?.prompt);
  if (!name || !prompt) throw invalid("Skill name and prompt are required");
  return {
    id,
    name,
    description: text(record?.description, "", 300),
    prompt,
  };
}

function makeAgent(input: DefinitionInput, skillIds: string[], id: string = randomUUID()): AgentRecord {
  const record = input as {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
    suggestions?: unknown;
  } | null;
  const name = text(record?.name);
  if (!name) throw invalid("Agent name is required");
  const agent: AgentRecord = {
    id,
    name,
    description: text(record?.description, "", 300),
    systemPrompt: text(record?.systemPrompt, ""),
    skillIds,
  };
  const model = modelRef(record?.model);
  const thinkingLevel = thinkingLevelOf(record?.thinkingLevel);
  const suggestions = normalizeSuggestions(record?.suggestions);
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
  // 正規化して 0 件ならキーを省略する (解除もこの経路で成立する)
  if (suggestions.length) agent.suggestions = suggestions;
  return agent;
}

export interface AgentCatalog {
  listSkills(): SkillDef[];
  listAgents(): AgentDef[];
  getSkill(id: string): SkillRecord | undefined;
  getAgent(id: string): AgentRecord | undefined;
  snapshot(): Catalog;
  replace(snapshot: DefinitionInput): Catalog;
  createSkill(input: DefinitionInput): SkillDef;
  updateSkill(id: string, input: DefinitionInput): SkillDef | undefined;
  removeSkill(id: string): boolean;
  createAgent(input: DefinitionInput): AgentDef;
  updateAgent(id: string, input: DefinitionInput): AgentDef | undefined;
  removeAgent(id: string): boolean;
}

export function createAgentCatalog(): AgentCatalog {
  const skills = new Map<string, SkillRecord>(DEFAULT_SKILLS.map((skill) => [skill.id, copy(skill)]));
  const agents = new Map<string, AgentRecord>(DEFAULT_AGENTS.map((agent) => [agent.id, copy(agent)]));

  const listSkills = () => [...skills.values()].map(publicSkill);
  const listAgents = () => [...agents.values()].map(publicAgent);
  const getSkill = (id: string) => skills.get(id);
  const getAgent = (id: string) => agents.get(id);

  function normalizeSkillIds(skillIds: unknown, availableSkills: Map<string, SkillRecord> = skills): string[] {
    if (!Array.isArray(skillIds)) return [];
    return [...new Set(skillIds.filter((id): id is string => typeof id === "string" && availableSkills.has(id)))];
  }

  return {
    listSkills,
    listAgents,
    getSkill,
    getAgent,
    snapshot() {
      return { agents: listAgents(), skills: listSkills() };
    },
    replace(snapshot) {
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        !Array.isArray((snapshot as { skills?: unknown }).skills) ||
        !Array.isArray((snapshot as { agents?: unknown }).agents)
      ) {
        throw invalid("Definitions must contain skills and agents arrays");
      }
      const body = snapshot as { skills: DefinitionInput[]; agents: DefinitionInput[] };

      const importedSkills = new Map<string, SkillRecord>();
      for (const input of body.skills) {
        const id = definitionId(input);
        if (importedSkills.has(id)) throw invalid(`Duplicate skill id: ${id}`);
        importedSkills.set(id, makeSkill(input, id));
      }

      const importedAgents = new Map<string, AgentRecord>();
      for (const input of body.agents) {
        const id = definitionId(input);
        if (importedAgents.has(id)) throw invalid(`Duplicate agent id: ${id}`);
        const raw = input as { skillIds?: unknown } | null;
        importedAgents.set(id, makeAgent(input, normalizeSkillIds(raw?.skillIds, importedSkills), id));
      }
      if (importedAgents.size === 0) throw invalid("At least one agent is required");

      skills.clear();
      for (const [id, skill] of importedSkills) skills.set(id, skill);
      agents.clear();
      for (const [id, agent] of importedAgents) agents.set(id, agent);
      return { agents: listAgents(), skills: listSkills() };
    },
    createSkill(input) {
      const skill = makeSkill(input);
      skills.set(skill.id, skill);
      return publicSkill(skill);
    },
    updateSkill(id, input) {
      const current = skills.get(id);
      if (!current) return undefined;
      const skill = makeSkill({ ...current, ...(input as object) }, id);
      skills.set(id, skill);
      return publicSkill(skill);
    },
    removeSkill(id) {
      if (!skills.delete(id)) return false;
      for (const agent of agents.values()) {
        agent.skillIds = agent.skillIds.filter((skillId) => skillId !== id);
      }
      return true;
    },
    createAgent(input) {
      const raw = input as { skillIds?: unknown } | null;
      const agent = makeAgent(input, normalizeSkillIds(raw?.skillIds));
      agents.set(agent.id, agent);
      return publicAgent(agent);
    },
    updateAgent(id, input) {
      const current = agents.get(id);
      if (!current) return undefined;
      const raw = input as { skillIds?: unknown } | null;
      // キー省略は current を残し、null は makeAgent 側でキーごと消える。
      const merged = { ...current, ...(input as object) };
      const agent = makeAgent(
        merged,
        raw && Object.hasOwn(raw, "skillIds") ? normalizeSkillIds(raw.skillIds) : normalizeSkillIds(current.skillIds),
        id,
      );
      // makeAgent は undefined のキーを付けないので、解除は merged の上書きで成立する
      agents.set(id, agent);
      return publicAgent(agent);
    },
    removeAgent(id) {
      if (!agents.has(id) || agents.size <= 1) return false;
      return agents.delete(id);
    },
  };
}
