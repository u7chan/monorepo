/**
 * 小さなインメモリカタログ。ファイルに書き出さないのは意図的で、
 * 再起動すると以下のサンプル定義に戻る。
 */
import { randomUUID } from "node:crypto";
import { ThinkingLevelSchema } from "./schema";
import type {
  AgentDef,
  AgentSuggestion,
  BuiltinSkillInfo,
  CatalogResponse,
  ModelRef,
  SkillDef,
  ThinkingLevel,
} from "./schema";

export interface HttpError extends Error {
  statusCode?: number;
}

type SkillRecord = SkillDef;
type AgentRecord = AgentDef;

/** catalog CRUD の入力は正規化ロジックが正なので unknown で受ける */
type DefinitionInput = unknown;

/**
 * 初期投入するユーザー定義エージェント。口調のように会話全体へ常時効かせたい指示はスキルではなく
 * エージェントの systemPrompt に置く。通常の定義と同じ扱いにするので削除も置換もでき、再起動で戻る。
 */
const DEFAULT_AGENTS: AgentRecord[] = [
  {
    id: "agent-zundamon",
    name: "ずんだもん",
    description: "「〜なのだ」「〜のだ」の語尾で話す",
    systemPrompt:
      "ずんだもんの口調で話してください。文末は「〜なのだ」「〜のだ」にし、一人称は「ボク」を使ってください。内容や説明の正確さは変えず、口調だけを変えてください。コード・コマンド・ファイルパス・エラーメッセージは書き換えず、そのまま示してください。",
    skillIds: [],
  },
];

/**
 * 常に 1 体居る汎用アシスタント。置換対象のマップにも入れず、ユーザー定義が 0 件でもセッションを
 * 作れる保証と、インポートで消えないことをこの分離で持つ。既定のエージェントは役割もスキルも
 * 持たない (なりきりは DEFAULT_AGENTS のサンプルとして別に置く)。
 */
const BUILTIN_AGENT: AgentRecord = {
  id: "agent-general",
  name: "汎用アシスタント",
  description: "役割や口調を設定していない既定のエージェント",
  systemPrompt: "",
  skillIds: [],
  suggestions: [
    { label: "プロジェクトを説明して", prompt: "このプロジェクトの構成を簡単に教えて" },
    { label: "テストを確認して", prompt: "まずテストがあるか確認して" },
    { label: "README をレビューして", prompt: "README を読んで改善案を3つ出して" },
  ],
};

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
    body: skill.body,
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
  if (agent.icon) result.icon = agent.icon;
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

/** svg はスクリプトを持ち込めるため受理せず、クライアントが再エンコードする webp と png だけにする */
const ICON_DATA_URL = /^data:image\/(webp|png);base64,([A-Za-z0-9+/]+={0,2})$/;
/** 単体の作成 / 更新の body 上限 (64 KiB) で systemPrompt と同居できる大きさ。client は 256×256 へ縮小してから送る */
const ICON_MAX_BYTES = 16 * 1024;

/**
 * prefix が正しくても中身が別形式なら壊れた画像になるため、先頭の署名まで見る。
 * 最後までデコードできるかは見ない (client が常に再エンコードするため実運用では一致する)。
 */
const ICON_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  png: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  // RIFF....WEBP (4..8 はファイルサイズ)
  webp: (bytes) =>
    bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

/**
 * text() は使わない (trim + slice で base64 を切ると壊れた画像が保存される)。形式とデコード後の
 * 大きさだけを検証する。undefined / null は未指定、形式違い・16 KiB 超は 400。
 */
function iconOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const match = typeof value === "string" ? ICON_DATA_URL.exec(value) : null;
  if (typeof value !== "string" || !match) throw invalid("Icon must be a webp or png data URL");
  const bytes = Buffer.from(match[2], "base64");
  // 再エンコードと一致しない base64 は壊れた画像になる (余分な文字・誤った padding) ので弾く
  if (bytes.length === 0 || bytes.toString("base64") !== match[2]) throw invalid("Icon must be valid base64");
  if (bytes.length > ICON_MAX_BYTES) throw invalid(`Icon must be at most ${ICON_MAX_BYTES / 1024} KiB`);
  if (!ICON_SIGNATURES[match[1]](bytes)) throw invalid(`Icon must contain a ${match[1]} image`);
  return value;
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
  const record = input as { name?: unknown; body?: unknown; description?: unknown } | null;
  const name = text(record?.name);
  const body = text(record?.body);
  if (!name || !body) throw invalid("Skill name and body are required");
  return {
    id,
    name,
    description: text(record?.description, "", 300),
    body,
  };
}

function makeAgent(input: DefinitionInput, skillIds: string[], id: string = randomUUID()): AgentRecord {
  const record = input as {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    icon?: unknown;
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
  const icon = iconOf(record?.icon);
  const model = modelRef(record?.model);
  const thinkingLevel = thinkingLevelOf(record?.thinkingLevel);
  const suggestions = normalizeSuggestions(record?.suggestions);
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
  // 正規化して 0 件ならキーを省略する (解除もこの経路で成立する)
  if (suggestions.length) agent.suggestions = suggestions;
  return agent;
}

export interface AgentCatalog {
  /** ビルトインの汎用エージェント。置換対象のマップには入れない */
  builtinAgent(): AgentDef;
  listSkills(): SkillDef[];
  /** ユーザー定義のみ (ビルトインを含まない) */
  listAgents(): AgentDef[];
  getSkill(id: string): SkillRecord | undefined;
  /** ビルトインも解決する (新規セッションの既定がこの id を指す) */
  getAgent(id: string): AgentRecord | undefined;
  snapshot(): CatalogResponse;
  /** 送られた定義 (ビルトイン以外) を丸ごと入れ替える。`snapshot` に戻り値をそのまま渡せる */
  replace(definitions: DefinitionInput): CatalogResponse;
  createSkill(input: DefinitionInput): SkillDef;
  updateSkill(id: string, input: DefinitionInput): SkillDef | undefined;
  removeSkill(id: string): boolean;
  createAgent(input: DefinitionInput): AgentDef;
  updateAgent(id: string, input: DefinitionInput): AgentDef | undefined;
  removeAgent(id: string): boolean;
}

export interface CreateAgentCatalogOptions {
  /** GET /api/agents が返す同梱スキル。カタログの CRUD と `skillIds` の対象外 */
  builtinSkills?: readonly BuiltinSkillInfo[];
}

export function createAgentCatalog(options: CreateAgentCatalogOptions = {}): AgentCatalog {
  const skills = new Map<string, SkillRecord>();
  // ユーザー定義だけを置換対象にする。ビルトインはここに入れない
  const agents = new Map<string, AgentRecord>(DEFAULT_AGENTS.map((agent) => [agent.id, copy(agent)]));
  const builtin = copy(BUILTIN_AGENT);
  // 呼び出し側の配列を参照で持ち回らない (応答のたびにコピーを返す)
  const builtinSkills: BuiltinSkillInfo[] = (options.builtinSkills ?? []).map((skill) => ({ ...skill }));

  const builtinAgent = () => publicAgent(builtin);
  const listSkills = () => [...skills.values()].map(publicSkill);
  const listAgents = () => [...agents.values()].map(publicAgent);
  const getSkill = (id: string) => skills.get(id);
  const getAgent = (id: string) => agents.get(id) ?? (id === builtin.id ? builtin : undefined);
  const snapshot = (): CatalogResponse => ({
    builtinAgent: builtinAgent(),
    builtinSkills: builtinSkills.map((skill) => ({ ...skill })),
    agents: listAgents(),
    skills: listSkills(),
  });

  function normalizeSkillIds(skillIds: unknown, availableSkills: Map<string, SkillRecord> = skills): string[] {
    if (!Array.isArray(skillIds)) return [];
    return [...new Set(skillIds.filter((id): id is string => typeof id === "string" && availableSkills.has(id)))];
  }

  return {
    builtinAgent,
    listSkills,
    listAgents,
    getSkill,
    getAgent,
    snapshot,
    replace(definitions) {
      if (
        !definitions ||
        typeof definitions !== "object" ||
        !Array.isArray((definitions as { skills?: unknown }).skills) ||
        !Array.isArray((definitions as { agents?: unknown }).agents)
      ) {
        throw invalid("Definitions must contain skills and agents arrays");
      }
      const body = definitions as { skills: DefinitionInput[]; agents: DefinitionInput[] };

      const importedSkills = new Map<string, SkillRecord>();
      for (const input of body.skills) {
        const id = definitionId(input);
        if (importedSkills.has(id)) throw invalid(`Duplicate skill id: ${id}`);
        importedSkills.set(id, makeSkill(input, id));
      }

      const importedAgents = new Map<string, AgentRecord>();
      for (const input of body.agents) {
        const id = definitionId(input);
        // 送られた定義をそのまま入れるのが置換の意味なので、ビルトインの id は黙って捨てず拒否する
        if (id === builtin.id) throw invalid(`Agent id ${id} is reserved for the built-in agent`);
        if (importedAgents.has(id)) throw invalid(`Duplicate agent id: ${id}`);
        const raw = input as { skillIds?: unknown } | null;
        importedAgents.set(id, makeAgent(input, normalizeSkillIds(raw?.skillIds, importedSkills), id));
      }
      // ビルトインが常に 1 体居るので、ユーザー定義 0 件も許す

      skills.clear();
      for (const [id, skill] of importedSkills) skills.set(id, skill);
      agents.clear();
      for (const [id, agent] of importedAgents) agents.set(id, agent);
      return snapshot();
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
      return agents.delete(id);
    },
  };
}
