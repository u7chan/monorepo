/**
 * アプリデータ (プロジェクト / エージェント / スキル) の SQLite ストア。
 * 置き場所・スキーマの作り直し・失敗時の扱いは docs/persistence.md を正とする。
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { httpError, messageFor } from "./http";
import type { AgentDef, AgentSuggestion, ModelRef, Project, SkillDef } from "./schema";

export const APP_DB_FILENAME = "u7agent.db";
/** テーブル定義を変えたら上げる。不一致の DB は作り直す */
export const APP_DB_SCHEMA_VERSION = 1;

export interface AppDbStatus {
  /** null は永続化なし (メモリ DB)。開けなかったときも null */
  path: string | null;
  ok: boolean;
  error?: string;
}

export interface OpenAppDbOptions {
  /** 会話ストアと同じディレクトリ。null ならメモリ DB (テスト) */
  storeDir: string | null;
}

const CREATE_TABLES = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  systemPrompt TEXT NOT NULL,
  icon TEXT,
  model TEXT,
  thinkingLevel TEXT,
  skillIds TEXT NOT NULL,
  suggestions TEXT
);
`;

/** アプリ所有のテーブルだけを落とす (同じ DB に足した別機能のテーブルを巻き込まない) */
const DROP_TABLES = `
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS projects;
`;

/**
 * DB を新規作成したときだけ入れるサンプル定義 (作り直しでは入れない)。
 * 口調のように会話全体へ常時効かせたい指示はスキルではなくエージェントの systemPrompt に置く。
 */
const SEED_AGENTS: AgentDef[] = [
  {
    id: "agent-zundamon",
    name: "ずんだもん",
    description: "「〜なのだ」「〜のだ」の語尾で話す",
    systemPrompt:
      "ずんだもんの口調で話してください。文末は「〜なのだ」「〜のだ」にし、一人称は「ボク」を使ってください。内容や説明の正確さは変えず、口調だけを変えてください。コード・コマンド・ファイルパス・エラーメッセージは書き換えず、そのまま示してください。",
    skillIds: [],
  },
];

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 自分で書いた JSON 列だけを読む。壊れていたら黙って空にせず例外にして 503 側で見せる */
function jsonArray<T>(value: unknown): T[] | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

function jsonObject<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
}

function projectOf(row: Row): Project {
  return {
    id: text(row.id),
    name: text(row.name),
    cwd: text(row.cwd),
    createdAt: Number(row.createdAt),
  };
}

function skillOf(row: Row): SkillDef {
  return {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    body: text(row.body),
  };
}

function agentOf(row: Row): AgentDef {
  const agent: AgentDef = {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    systemPrompt: text(row.systemPrompt),
    skillIds: jsonArray<string>(row.skillIds) ?? [],
  };
  const icon = optionalText(row.icon);
  const model = jsonObject<ModelRef>(row.model);
  const thinkingLevel = optionalText(row.thinkingLevel);
  const suggestions = jsonArray<AgentSuggestion>(row.suggestions);
  // 未指定の項目はキーごと省略する (応答に null は現れない)
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel as AgentDef["thinkingLevel"];
  if (suggestions?.length) agent.suggestions = suggestions;
  return agent;
}

/**
 * DB を持てない状態でもインスタンスを返し、クエリで 503 を投げる (メモリ DB へは逃がさない)。
 * 理由は health へ出し、ルートはこの例外で 503 になる。
 */
export class AppDb {
  #db: DatabaseSync | null;
  #path: string | null;
  #error: string | undefined;

  private constructor(db: DatabaseSync | null, path: string | null, error?: string) {
    this.#db = db;
    this.#path = path;
    this.#error = error;
  }

  static open({ storeDir }: OpenAppDbOptions): AppDb {
    const path = storeDir === null ? null : join(storeDir, APP_DB_FILENAME);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path ?? ":memory:");
      // 会話ストアと同じ方針 (メモリ DB では無視される)
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      const instance = new AppDb(db, path);
      const version = instance.#schemaVersion();
      // user_version が 0 = 未初期化 (新規ファイル・0 バイトの残骸・メモリ DB)。このときだけ seed する
      if (version !== APP_DB_SCHEMA_VERSION) instance.#recreate(version === 0);
      return instance;
    } catch (error) {
      try {
        // 失敗した接続を残さない (後始末の失敗で元の理由を隠さない)
        db?.close();
      } catch {
        // noop
      }
      console.error(`[u7agent] app db unavailable: ${messageFor(error)}`);
      return new AppDb(null, path, messageFor(error));
    }
  }

  /** パス解決の失敗など、開く前に DB を使えないと分かっている状態 */
  static unavailable({ storeDir, error }: { storeDir: string | null; error: string }): AppDb {
    return new AppDb(null, storeDir === null ? null : join(storeDir, APP_DB_FILENAME), error);
  }

  status(): AppDbStatus {
    if (!this.#db) return { path: this.#path, ok: false, error: this.#error ?? "unknown error" };
    return this.#error ? { path: this.#path, ok: false, error: this.#error } : { path: this.#path, ok: true };
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /** 途中で失敗したら部分適用を残さない。呼び出し側の例外はそのまま伝える */
  transaction<T>(fn: () => T): T {
    this.#query((db) => db.exec("BEGIN"));
    try {
      const result = fn();
      this.#query((db) => db.exec("COMMIT"));
      return result;
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // rollback の失敗で元の例外を隠さない (接続が壊れている場合は次のクエリで 503 になる)
      }
      throw error;
    }
  }

  /** 入口ガードが失敗状態から戻れるかを確かめる軽い読み取り (成功したら #error が消える) */
  probe(): boolean {
    return this.#query((db) => Boolean(db.prepare("SELECT 1").get()));
  }

  #handle(): DatabaseSync {
    if (!this.#db) throw httpError(503, `アプリデータ（SQLite）を利用できません: ${this.#error ?? "unknown error"}`);
    return this.#db;
  }

  /** 稼働中の失敗も 503 に寄せる (成功したら解除する)。理由は health にも出る */
  #query<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.#handle();
    try {
      const result = fn(db);
      this.#error = undefined;
      return result;
    } catch (error) {
      this.#error = messageFor(error);
      console.error(`[u7agent] app db query failed: ${this.#error}`);
      throw httpError(503, `アプリデータ（SQLite）を利用できません: ${this.#error}`);
    }
  }

  #schemaVersion(): number {
    const row = this.#handle().prepare("PRAGMA user_version").get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  /** DROP → CREATE → user_version → (未初期化なら) seed を 1 トランザクションで行う */
  #recreate(seed: boolean): void {
    this.#query((db) => db.exec("BEGIN"));
    try {
      this.#query((db) => db.exec(DROP_TABLES));
      this.#query((db) => db.exec(CREATE_TABLES));
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      if (seed) this.#seed();
      this.#query((db) => db.exec("COMMIT"));
      // 既存 DB の作り直しはデータが消える経路なので警告として出す
      if (seed) console.log(`[u7agent] app db created (schema ${APP_DB_SCHEMA_VERSION})`);
      else console.error(`[u7agent] app db recreated without seed (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }

  #seed(): void {
    for (const agent of SEED_AGENTS) this.saveAgent(agent);
  }

  // --- projects ---

  listProjects(): Project[] {
    return this.#query((db) => (db.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]).map(projectOf));
  }

  getProject(id: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  findProjectByCwd(cwd: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE cwd = ?").get(cwd) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  insertProject(project: Project): void {
    this.#query((db) =>
      db
        .prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)")
        .run(project.id, project.name, project.cwd, project.createdAt),
    );
  }

  deleteProject(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0);
  }

  // --- skills ---

  listSkills(): SkillDef[] {
    return this.#query((db) => (db.prepare("SELECT * FROM skills ORDER BY rowid").all() as Row[]).map(skillOf));
  }

  getSkill(id: string): SkillDef | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Row | undefined);
    return row ? skillOf(row) : undefined;
  }

  /** 作成と更新で同じ (id が主キー) */
  saveSkill(skill: SkillDef): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO skills (id, name, description, body) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, body = excluded.body`,
        )
        .run(skill.id, skill.name, skill.description, skill.body),
    );
  }

  deleteSkill(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes > 0);
  }

  // --- agents ---

  listAgents(): AgentDef[] {
    return this.#query((db) => (db.prepare("SELECT * FROM agents ORDER BY rowid").all() as Row[]).map(agentOf));
  }

  getAgent(id: string): AgentDef | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined);
    return row ? agentOf(row) : undefined;
  }

  saveAgent(agent: AgentDef): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO agents (id, name, description, systemPrompt, icon, model, thinkingLevel, skillIds, suggestions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
             systemPrompt = excluded.systemPrompt, icon = excluded.icon, model = excluded.model,
             thinkingLevel = excluded.thinkingLevel, skillIds = excluded.skillIds, suggestions = excluded.suggestions`,
        )
        .run(
          agent.id,
          agent.name,
          agent.description,
          agent.systemPrompt,
          agent.icon ?? null,
          agent.model ? JSON.stringify(agent.model) : null,
          agent.thinkingLevel ?? null,
          JSON.stringify(agent.skillIds),
          agent.suggestions ? JSON.stringify(agent.suggestions) : null,
        ),
    );
  }

  deleteAgent(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0);
  }

  // --- 複数テーブルにまたがる更新 (部分適用を残さない) ---

  /** スキル削除と、それを参照している agents からの除去をまとめる */
  deleteSkillAndDetach(id: string): boolean {
    return this.transaction(() => {
      const agents = this.listAgents();
      if (!this.deleteSkill(id)) return false;
      for (const agent of agents) {
        if (!agent.skillIds.includes(id)) continue;
        this.saveAgent({ ...agent, skillIds: agent.skillIds.filter((skillId) => skillId !== id) });
      }
      return true;
    });
  }

  /** カタログの一括置換。全削除 → 投入を 1 トランザクションで行う */
  replaceCatalog(skills: SkillDef[], agents: AgentDef[]): void {
    this.transaction(() => {
      this.#query((db) => db.prepare("DELETE FROM skills").run());
      this.#query((db) => db.prepare("DELETE FROM agents").run());
      for (const skill of skills) this.saveSkill(skill);
      for (const agent of agents) this.saveAgent(agent);
    });
  }
}
