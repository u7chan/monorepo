/**
 * エージェントカタログ。定義はアプリデータの SQLite (app-db.ts) に保存し、
 * 再起動しても残る。サンプル定義は DB を新規作成したときだけ入る (app-db.ts の SEED_AGENTS)。
 * スキルはファイル (`.agents/skills`) を正とし、このカタログは定義を持たない (docs/api-catalog.md)。
 */
import { randomUUID } from "node:crypto";
import { AppDb, type StoredAgent } from "./app-db";
import {
  BUILTIN_AGENT_DESCRIPTION,
  BUILTIN_AGENT_ID,
  BUILTIN_AGENT_NAME,
  BUILTIN_AGENT_PROMPT_IDS,
} from "./builtin-catalog";
import { httpError } from "./http";
import { createPromptCatalog, type PromptCatalog } from "./prompts";
import { SKILL_NAME_MAX, SKILL_NAMES_MAX, TOOL_NAME_MAX, TOOL_NAMES_MAX, ThinkingLevelSchema } from "./schema";
import type {
  AgentDef,
  BuiltinSkillInfo,
  CatalogResponse,
  ModelRef,
  PromptRef,
  ThinkingLevel,
  ToolCatalogEntry,
} from "./schema";

export interface HttpError extends Error {
  statusCode?: number;
}

type AgentRecord = StoredAgent;

/** catalog CRUD の入力は正規化ロジックが正なので unknown で受ける */
type DefinitionInput = unknown;

/**
 * 常に 1 体居る汎用アシスタント。DB の行にはせず、ユーザー定義が 0 件でもセッションを
 * 作れる保証をこの分離で持つ (ユーザー定義の一覧には現れず、削除も編集もできない)。
 * 既定のエージェントはスキルを割り当てず、共通 / 組み込みは許可リスト未指定 = 全部 ON になる。
 * 閲覧ビューはその実効の一覧を読み取り専用で出す (なりきりは SEED_AGENTS のサンプルとして別に置く)。
 * 定型プロンプトは組み込みマスタを固定 ID で参照し、本文をここへ二重に定義しない。
 */
const BUILTIN_AGENT: AgentRecord = {
  id: BUILTIN_AGENT_ID,
  name: BUILTIN_AGENT_NAME,
  description: BUILTIN_AGENT_DESCRIPTION,
  systemPrompt: "",
  // 既定のエージェントは自然文では発火させない。スキルが増えても誤発火しないための固定値
  allowNaturalInvocation: false,
  // 固定参照。`agent_prompts` には書かず、解決はカタログ側で行う (外部キーは弱めない)
  promptIds: [...BUILTIN_AGENT_PROMPT_IDS],
};

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function text(value: unknown, fallback = "", maxLength = 8_000): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function invalid(message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = 400;
  return error;
}

function publicAgent(agent: AgentRecord, resolvePrompts: (ids: readonly string[]) => PromptRef[]): AgentDef {
  const result: AgentDef = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
  };
  // 未指定の項目はキーを省略する (保存・応答に null は現れない)
  if (agent.icon) result.icon = agent.icon;
  if (agent.model) result.model = { ...agent.model };
  if (agent.thinkingLevel) result.thinkingLevel = agent.thinkingLevel;
  // 参照先のラベル・本文を解決して載せる。表示の同一性は id で持ち、同じ本文の別マスタをまとめない
  const prompts = agent.promptIds?.length ? resolvePrompts(agent.promptIds) : [];
  if (prompts.length) result.prompts = prompts;
  // `[]` は「すべて OFF」なので真偽で落とさない (未指定のときだけキーを省略する)
  if (agent.commonSkillNames) result.commonSkillNames = [...agent.commonSkillNames];
  if (agent.builtinSkillNames) result.builtinSkillNames = [...agent.builtinSkillNames];
  // 既定 (true) はキーを省略し、false だけを載せる
  if (agent.allowNaturalInvocation === false) result.allowNaturalInvocation = false;
  if (agent.toolNames) result.toolNames = [...agent.toolNames];
  return result;
}

/**
 * セッションのスキルを自然文で発火させてよいか。ビルトインは定義の値に依らず常に許さない
 * (このフィールドが無い旧スナップショットから復元しても誤発火に戻さない)。
 */
export function allowsNaturalInvocation(agent: Pick<AgentDef, "id" | "allowNaturalInvocation">): boolean {
  if (agent.id === BUILTIN_AGENT.id) return false;
  return agent.allowNaturalInvocation !== false;
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

/**
 * 参照するマスタの `promptIds`。undefined / null は未指定 (= キー省略)、配列は順序を保って
 * 既存確認・重複・上限までカタログが検証する。`[]` は全解除で、キー省略と混同しない。
 * 形が違う値は 400 (黙って空にすると「解除した」と誤認される)。
 */
function promptIdsInput(value: unknown, normalize: (raw: unknown) => string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalid("promptIds must be an array of prompt ids");
  return normalize(value);
}

/**
 * 許可リスト (スキル / ツール) の正規化。`undefined` / `null` は未指定 (キー省略)、配列は
 * trim / 空除去 / 重複排除で正規化する。`[]` は「すべて OFF」なので未指定へ潰さず、非配列と上限超過は 400。
 * route の zod でも弾くが、catalog を直接使う経路で壊れた入力が `[]` = すべて OFF に化けないよう
 * ここでも fail-closed にする。上限は対象ごとに違う (スキル名はワークスペースの 1 セグメント名由来で、
 * ツール名に同じ根拠は無い) ため、kind は文言だけを分け、上限は引数で受ける。
 */
function allowlistOf(
  value: unknown,
  kind: string,
  limits: { nameMax: number; namesMax: number },
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalid(`${kind} names must be an array of strings`);
  if (value.length > limits.namesMax) {
    throw invalid(`${kind} names must have at most ${limits.namesMax} items`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw invalid(`${kind} names must be an array of strings`);
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    if (name.length > limits.nameMax) {
      throw invalid(`${kind} name must be at most ${limits.nameMax} characters`);
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

const SKILL_LIMITS = { nameMax: SKILL_NAME_MAX, namesMax: SKILL_NAMES_MAX } as const;
const TOOL_LIMITS = { nameMax: TOOL_NAME_MAX, namesMax: TOOL_NAMES_MAX } as const;

function makeAgent(input: DefinitionInput, promptIds: string[], id: string = randomUUID()): AgentRecord {
  const record = input as {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    commonSkillNames?: unknown;
    builtinSkillNames?: unknown;
    allowNaturalInvocation?: unknown;
    toolNames?: unknown;
    icon?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
    suggestions?: unknown;
    skillIds?: unknown;
  } | null;
  // 撤去済みの直接書き込みは無視せず 400 にする (黙って成功させると、定型文を保存できたと誤認させる)
  if (record && Object.hasOwn(record, "skillIds")) throw invalid("skillIds is no longer supported");
  if (record && Object.hasOwn(record, "suggestions")) {
    throw invalid("suggestions is no longer supported; use promptIds");
  }
  const name = text(record?.name);
  if (!name) throw invalid("Agent name is required");
  const agent: AgentRecord = {
    id,
    name,
    description: text(record?.description, "", 300),
    systemPrompt: text(record?.systemPrompt, ""),
    promptIds,
  };
  const icon = iconOf(record?.icon);
  const model = modelRef(record?.model);
  const thinkingLevel = thinkingLevelOf(record?.thinkingLevel);
  const commonSkillNames = allowlistOf(record?.commonSkillNames, "Common skill", SKILL_LIMITS);
  const builtinSkillNames = allowlistOf(record?.builtinSkillNames, "Builtin skill", SKILL_LIMITS);
  const allowNaturalInvocation = record?.allowNaturalInvocation;
  if (
    allowNaturalInvocation !== undefined &&
    allowNaturalInvocation !== null &&
    typeof allowNaturalInvocation !== "boolean"
  ) {
    throw invalid("allowNaturalInvocation must be a boolean");
  }
  // 一覧に無い名前も保存する (改名・削除・同梱の入れ替えで保存値を書き換えない。docs/api-catalog.md)
  const toolNames = allowlistOf(record?.toolNames, "Agent tool", TOOL_LIMITS);
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
  // `[]` は「すべて OFF」なので真偽で落とさない (未指定のときだけキーを省略する)
  if (commonSkillNames) agent.commonSkillNames = commonSkillNames;
  if (builtinSkillNames) agent.builtinSkillNames = builtinSkillNames;
  // true は既定なので保存せず、false のときだけ持つ (null は解除 = 既定の true)
  if (allowNaturalInvocation === false) agent.allowNaturalInvocation = false;
  if (toolNames) agent.toolNames = toolNames;
  return agent;
}

export interface AgentCatalog {
  /** ビルトインの汎用エージェント。ユーザー定義の一覧には入れない */
  builtinAgent(): AgentDef;
  /** ユーザー定義のみ (ビルトインを含まない) */
  listAgents(): AgentDef[];
  /**
   * 表示順の更新。応答と以後の一覧は、正規化したあとの順で返る。
   * 未知の id・重複・ビルトインは捨て、渡されなかった行は元の相対順で末尾に回す。
   */
  reorderAgents(ids: readonly string[]): AgentDef[];
  /** ビルトインも解決する (新規セッションの既定がこの id を指す) */
  getAgent(id: string): AgentDef | undefined;
  snapshot(): CatalogResponse;
  createAgent(input: DefinitionInput): AgentDef;
  updateAgent(id: string, input: DefinitionInput): AgentDef | undefined;
  removeAgent(id: string): boolean;
}

export interface CreateAgentCatalogOptions {
  /** GET /api/agents が返す同梱スキル。`AgentDef` の許可リストの対象外 */
  builtinSkills?: readonly BuiltinSkillInfo[];
  /**
   * GET /api/agents が返すツールの一覧。アプリ側の実効 (キー / 実行時トグル / serve の有無) は
   * 取得時点で変わるため、値ではなく都度の解決関数を受ける (設定の保存後にクライアントが取り直す)。
   * 未指定は空 (`[]` は「ツールが無い」ではなく、一覧を取得できていない状態として画面が出す)
   */
  tools?: () => readonly ToolCatalogEntry[];
  /** アプリデータの DB。未指定はメモリ DB (カタログの単体テスト) */
  db?: AppDb;
  /**
   * 定型プロンプトのマスタ。未指定は `db` から作る。API 側と共有するときは同じインスタンスを渡す
   * (マスタの一覧の使用先と、エージェントの解決結果を同じ保存先から読む)
   */
  prompts?: PromptCatalog;
}

export function createAgentCatalog(options: CreateAgentCatalogOptions = {}): AgentCatalog {
  const db = options.db ?? AppDb.open({ storeDir: null });
  const prompts = options.prompts ?? createPromptCatalog({ db });
  const builtin = copy(BUILTIN_AGENT);
  // 呼び出し側の配列を参照で持ち回らない (応答のたびにコピーを返す)
  const builtinSkills: BuiltinSkillInfo[] = (options.builtinSkills ?? []).map((skill) => ({ ...skill }));
  const tools = options.tools ?? (() => []);
  /**
   * 参照の解決。1 応答で何体ものエージェントを返すため、マスタは 1 回だけ読んで引き当てる
   * (1 体ごとに問い合わせない)。参照先が消えているのは DB の制約が壊れた状態なので 400 にする。
   */
  const resolver = () => {
    const refs = new Map(prompts.refs().map((prompt) => [prompt.id, prompt]));
    return (ids: readonly string[]) =>
      ids.map((id) => {
        const prompt = refs.get(id);
        if (!prompt) throw httpError(503, `定型プロンプトを解決できません: ${id}`);
        return { ...prompt };
      });
  };
  const listAgents = () => {
    const resolve = resolver();
    return db.listAgents().map((agent) => publicAgent(agent, resolve));
  };
  const getAgent = (id: string) => {
    const stored = db.getAgent(id) ?? (id === builtin.id ? builtin : undefined);
    return stored ? publicAgent(stored, resolver()) : undefined;
  };
  const builtinAgent = () => publicAgent(builtin, resolver());
  const snapshot = (): CatalogResponse => ({
    builtinAgent: builtinAgent(),
    builtinSkills: builtinSkills.map((skill) => ({ ...skill })),
    tools: tools().map((tool) => ({ ...tool })),
    // 選択肢は全マスタ。エージェントの解決済みの値とは別に載せる (同じ取得で編集面が揃う)
    prompts: prompts.refs(),
    agents: listAgents(),
  });

  return {
    builtinAgent,
    listAgents,
    getAgent,
    snapshot,
    reorderAgents(ids) {
      // 存在しない id を捨てる方針は normalize と同じ (ビルトインはユーザー定義の集合に無い)
      const current = db.listAgents();
      const known = new Set(current.map((agent) => agent.id));
      const seen = new Set<string>();
      const order: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
        seen.add(id);
        order.push(id);
      }
      // 渡されなかった行は末尾へ、元の相対順のまま (1 度も触られていない行を並べ替えない)
      for (const agent of current) {
        if (!seen.has(agent.id)) order.push(agent.id);
      }
      db.reorderAgents(order);
      return listAgents();
    },
    createAgent(input) {
      // 新品の自作エージェントに組み込みマスタを自動で付けない (参照は明示の `promptIds` だけ)
      const promptIds =
        promptIdsInput((input as { promptIds?: unknown } | null)?.promptIds, prompts.normalizeIds) ?? [];
      const agent = makeAgent(input, promptIds);
      db.saveAgent(agent);
      return publicAgent(agent, resolver());
    },
    updateAgent(id, input) {
      const current = db.getAgent(id);
      if (!current) return undefined;
      // キー省略は current を残し、null は makeAgent 側でキーごと消える。
      const merged = { ...current, ...(input as object) };
      // promptIds は未指定なら現在の参照を保つ (null も同じ)。`[]` は全解除としてそのまま通す
      const requested = promptIdsInput((input as { promptIds?: unknown } | null)?.promptIds, prompts.normalizeIds);
      // makeAgent は undefined のキーを付けないので、解除は merged の上書きで成立する
      const agent = makeAgent(merged, requested ?? [...(current.promptIds ?? [])], id);
      db.saveAgent(agent);
      return publicAgent(agent, resolver());
    },
    removeAgent(id) {
      return db.deleteAgent(id);
    },
  };
}
