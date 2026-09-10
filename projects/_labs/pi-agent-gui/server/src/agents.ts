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

/**
 * 既定スキル: なりきり (口調の演技) ではなく、職務ごとの手順・スタイルを
 * 注ぎ込む単位として設計する。エージェント側の systemPrompt は役割だけを
 * 持ち、仕事の進め方はスキルで差し込む。
 */
const DEFAULT_SKILLS: SkillRecord[] = [
  {
    id: "skill-small-steps",
    name: "小さく直す",
    description: "変更を最小の一歩ずつ、確認しながら進める",
    prompt: "変更は最小の一歩に分割してください。各ステップでは現在のコードや実行結果を根拠に確認してから次へ進み、大きな書き換えをしないでください。",
  },
  {
    id: "skill-change-report",
    name: "変更レポート",
    description: "最後に変更点と確認方法を箇条書きで報告する",
    prompt: "作業の最後に、変更したファイル・各変更の要点・動作確認の方法・残った課題を箇条書きで報告してください。",
  },
  {
    id: "skill-severity-review",
    name: "重要度順レビュー",
    description: "指摘を重要度順に並べ、根拠と修正案を添える",
    prompt: "指摘は重要度の高い順に並べてください。各指摘にファイル名と行の根拠を添え、修正案があれば示してください。些末な指摘は省略するか最後にまとめてください。",
  },
  {
    id: "skill-evidence-first",
    name: "根拠を示す",
    description: "結論の後に、参照したファイルや実行結果を根拠として示す",
    prompt: "まず結論を述べ、その後に根拠 (参照したファイルパス・シンボル・実行結果) を示してください。コードから確認できない内容は推測と明示してください。",
  },
  {
    id: "skill-plain-words",
    name: "かみくだく説明",
    description: "専門用語に短い説明を添えて伝える",
    prompt: "専門用語には短い説明を添え、初めて読む人にも伝わる表現にしてください。長い説明より短い文と小さな例を優先してください。",
  },
];

/**
 * 既定エージェント: 素の汎用 1 体 + 職務の異なるサンプル 3 体。
 * model / thinkingLevel はすべて未指定 (アプリ既定に任せる)。
 */
const DEFAULT_AGENTS: AgentRecord[] = [
  {
    id: "agent-general",
    name: "汎用アシスタント",
    description: "設定なしの素のエージェント。まずはこのまま試す",
    systemPrompt: "",
    skillIds: [],
  },
  {
    id: "agent-builder",
    name: "コード実装",
    description: "コードを読んで、安全に変更を実装する",
    systemPrompt: "実装担当として、プロジェクトのコードを実際に読んでから変更を実装してください。指示が曖昧なときは決め打ちせず、短く確認してから進めてください。",
    skillIds: ["skill-small-steps", "skill-change-report"],
  },
  {
    id: "agent-reviewer",
    name: "コードレビュー",
    description: "バグや保守性の問題を重要度順にレビューする",
    systemPrompt: "レビュー担当として、変更対象のコードを実際に読んでから判断してください。根拠のない指摘はしないでください。",
    skillIds: ["skill-severity-review"],
  },
  {
    id: "agent-researcher",
    name: "コード調査",
    description: "コードベースを調べて、根拠つきで説明する",
    systemPrompt: "調査担当として、質問への答えをコードベースから確認してから説明してください。事実と推測を区別してください。",
    skillIds: ["skill-evidence-first", "skill-plain-words"],
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
