/**
 * 小さなインメモリカタログ (プロトタイプ用)。
 * わざとファイルに書き出さない: 使い捨てアプリを再起動すれば
 * このサンプル定義に戻る。
 * port 元: src/agents.js — 日本語エラー文言・正規化ロジックを完全保存。
 */
import { randomUUID } from "node:crypto";
import { ThinkingLevelSchema } from "./schema";
import type { AgentDef, Catalog, ModelRef, SkillDef, ThinkingLevel } from "./schema";

/** HTTP ハンドラがステータスコードを参照するためのエラー */
export interface HttpError extends Error {
  statusCode?: number;
}

type SkillRecord = SkillDef;
type AgentRecord = AgentDef;

/** catalog CRUD の入力は正規化ロジックが正なので unknown で受ける */
type DefinitionInput = unknown;

const DEFAULT_SKILLS: SkillRecord[] = [
  {
    id: "skill-cat-tone",
    name: "ねこ口調",
    description: "語尾を『にゃ』にして、少し親しみやすく話す",
    prompt: "猫になりきった口調で話してください。語尾に自然に『にゃ』を付け、内容の正確さは保ってください。",
  },
  {
    id: "skill-ninja-tone",
    name: "忍者口調",
    description: "忍者になりきって簡潔に返答する",
    prompt: "忍者になりきって話してください。落ち着いた忍者口調で、要点を短く報告してください。",
  },
  {
    id: "skill-kind-teacher",
    name: "やさしい先生",
    description: "専門用語をかみくだいて説明する",
    prompt: "初心者にも伝わるように、専門用語には短い説明を添えてください。相手を急かさず、やさしく励ます口調にしてください。",
  },
  {
    id: "skill-short-answer",
    name: "短く答える",
    description: "結論と次の一手を優先する",
    prompt: "まず結論を一〜三文で答え、その後に必要な補足だけを箇条書きで示してください。",
  },
];

const DEFAULT_AGENTS: AgentRecord[] = [
  {
    id: "agent-builder",
    name: "実装パートナー",
    description: "コードを読んで、実装まで一緒に進める",
    systemPrompt: "実装パートナーとして、まず現在のコードと実行結果を確認し、安全に小さな変更を積み重ねてください。変更したファイルと確認方法を最後に短くまとめてください。",
    skillIds: [],
  },
  {
    id: "agent-reviewer",
    name: "レビュー先輩",
    description: "バグや保守性の問題を優先してレビューする",
    systemPrompt: "厳しすぎないコードレビュー担当です。問題を重要度順に、ファイルや行の根拠付きで指摘してください。必要なら修正案も示してください。",
    skillIds: ["skill-short-answer"],
  },
  {
    id: "agent-cat",
    name: "ねこ先生",
    description: "ねこ口調で、やさしく教えてくれる",
    systemPrompt: "質問に対して、答えだけでなく理解の助けになる小さな例も添えてください。",
    skillIds: ["skill-cat-tone", "skill-kind-teacher"],
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
  return result;
}

/**
 * 定義の model 項目を正規化する。
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

/** 定義の thinkingLevel 項目を正規化する。undefined / null は未指定、未知の段階は 400。 */
function thinkingLevelOf(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = ThinkingLevelSchema.safeParse(typeof value === "string" ? value.trim() : value);
  if (!parsed.success) throw invalid(`Unknown thinking level: ${String(value)}`);
  return parsed.data;
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
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
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

  function normalizeSkillIds(
    skillIds: unknown,
    availableSkills: Map<string, SkillRecord> = skills,
  ): string[] {
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
        !snapshot || typeof snapshot !== "object" ||
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
      // model / thinkingLevel はスプレッドマージで扱う: キー省略は current を残し、
      // null は makeAgent 側で「未指定」に正規化されてキーごと消える。
      const merged = { ...current, ...(input as object) };
      const agent = makeAgent(
        merged,
        raw && Object.hasOwn(raw, "skillIds")
          ? normalizeSkillIds(raw.skillIds)
          : normalizeSkillIds(current.skillIds),
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
