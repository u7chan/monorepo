/**
 * エージェントカタログ。定義はアプリデータの SQLite (app-db.ts) に保存し、
 * 再起動しても残る。サンプル定義は DB を新規作成したときだけ入る (app-db.ts の SEED_AGENTS)。
 * スキルはファイル (`.agents/skills`) を正とし、このカタログは定義を持たない (docs/api-catalog.md)。
 */
import { randomUUID } from "node:crypto";
import { AppDb } from "./app-db";
import { SKILL_NAME_MAX, SKILL_NAMES_MAX, TOOL_NAME_MAX, TOOL_NAMES_MAX, ThinkingLevelSchema } from "./schema";
import type {
  AgentDef,
  AgentSuggestion,
  BuiltinSkillInfo,
  CatalogResponse,
  ModelRef,
  ThinkingLevel,
  ToolCatalogEntry,
} from "./schema";

export interface HttpError extends Error {
  statusCode?: number;
}

type AgentRecord = AgentDef;

/** catalog CRUD の入力は正規化ロジックが正なので unknown で受ける */
type DefinitionInput = unknown;

/**
 * 常に 1 体居る汎用アシスタント。DB の行にはせず、ユーザー定義が 0 件でもセッションを
 * 作れる保証をこの分離で持つ (ユーザー定義の一覧には現れず、削除も編集もできない)。
 * 既定のエージェントはスキルを割り当てず、共通 / 組み込みは許可リスト未指定 = 全部 ON になる。
 * 閲覧ビューはその実効の一覧を読み取り専用で出す (なりきりは SEED_AGENTS のサンプルとして別に置く)。
 */
const BUILTIN_AGENT: AgentRecord = {
  id: "agent-general",
  name: "汎用アシスタント",
  description: "役割や口調を設定していない既定のエージェント",
  systemPrompt: "",
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

function invalid(message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = 400;
  return error;
}

function publicAgent(agent: AgentRecord): AgentDef {
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
  if (agent.suggestions?.length) result.suggestions = agent.suggestions.map((suggestion) => ({ ...suggestion }));
  // `[]` は「すべて OFF」なので真偽で落とさない (未指定のときだけキーを省略する)
  if (agent.commonSkillNames) result.commonSkillNames = [...agent.commonSkillNames];
  if (agent.builtinSkillNames) result.builtinSkillNames = [...agent.builtinSkillNames];
  if (agent.toolNames) result.toolNames = [...agent.toolNames];
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
 * 重複が 6 件の枠を消費しない。
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

function makeAgent(input: DefinitionInput, id: string = randomUUID()): AgentRecord {
  const record = input as {
    name?: unknown;
    description?: unknown;
    systemPrompt?: unknown;
    commonSkillNames?: unknown;
    builtinSkillNames?: unknown;
    toolNames?: unknown;
    icon?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
    suggestions?: unknown;
    skillIds?: unknown;
  } | null;
  // 撤去済みの DB カタログ割り当ては無視せず 400 にする (黙って成功させると
  // 割り当てが保存されたと誤認させる。docs/api-catalog.md)
  if (record && Object.hasOwn(record, "skillIds")) throw invalid("skillIds is no longer supported");
  const name = text(record?.name);
  if (!name) throw invalid("Agent name is required");
  const agent: AgentRecord = {
    id,
    name,
    description: text(record?.description, "", 300),
    systemPrompt: text(record?.systemPrompt, ""),
  };
  const icon = iconOf(record?.icon);
  const model = modelRef(record?.model);
  const thinkingLevel = thinkingLevelOf(record?.thinkingLevel);
  const suggestions = normalizeSuggestions(record?.suggestions);
  const commonSkillNames = allowlistOf(record?.commonSkillNames, "Common skill", SKILL_LIMITS);
  const builtinSkillNames = allowlistOf(record?.builtinSkillNames, "Builtin skill", SKILL_LIMITS);
  // 一覧に無い名前も保存する (改名・削除・同梱の入れ替えで保存値を書き換えない。docs/api-catalog.md)
  const toolNames = allowlistOf(record?.toolNames, "Agent tool", TOOL_LIMITS);
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel;
  // 正規化して 0 件ならキーを省略する (解除もこの経路で成立する)
  if (suggestions.length) agent.suggestions = suggestions;
  // `[]` は「すべて OFF」なので真偽で落とさない (未指定のときだけキーを省略する)
  if (commonSkillNames) agent.commonSkillNames = commonSkillNames;
  if (builtinSkillNames) agent.builtinSkillNames = builtinSkillNames;
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
  getAgent(id: string): AgentRecord | undefined;
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
}

export function createAgentCatalog(options: CreateAgentCatalogOptions = {}): AgentCatalog {
  const db = options.db ?? AppDb.open({ storeDir: null });
  const builtin = copy(BUILTIN_AGENT);
  // 呼び出し側の配列を参照で持ち回らない (応答のたびにコピーを返す)
  const builtinSkills: BuiltinSkillInfo[] = (options.builtinSkills ?? []).map((skill) => ({ ...skill }));
  const tools = options.tools ?? (() => []);

  const builtinAgent = () => publicAgent(builtin);
  const listAgents = () => db.listAgents().map(publicAgent);
  const getAgent = (id: string) => db.getAgent(id) ?? (id === builtin.id ? builtin : undefined);
  const snapshot = (): CatalogResponse => ({
    builtinAgent: builtinAgent(),
    builtinSkills: builtinSkills.map((skill) => ({ ...skill })),
    tools: tools().map((tool) => ({ ...tool })),
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
      const agent = makeAgent(input);
      db.saveAgent(agent);
      return publicAgent(agent);
    },
    updateAgent(id, input) {
      const current = db.getAgent(id);
      if (!current) return undefined;
      // キー省略は current を残し、null は makeAgent 側でキーごと消える。
      const merged = { ...current, ...(input as object) };
      // makeAgent は undefined のキーを付けないので、解除は merged の上書きで成立する
      const agent = makeAgent(merged, id);
      db.saveAgent(agent);
      return publicAgent(agent);
    },
    removeAgent(id) {
      return db.deleteAgent(id);
    },
  };
}
