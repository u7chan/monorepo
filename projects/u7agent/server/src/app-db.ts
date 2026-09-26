/**
 * アプリデータ (プロジェクト / エージェント / スキル) の SQLite ストア。
 * 置き場所・スキーマの作り直し・失敗時の扱いは docs/persistence.md を正とする。
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { httpError, messageFor } from "./http";
import type {
  AgentDef,
  AgentSuggestion,
  ModelRef,
  NotificationResult,
  NotificationSettings,
  Project,
  SkillDef,
} from "./schema";

export const APP_DB_FILENAME = "u7agent.db";
/** テーブル定義を変えたら上げる。新規作成と加算移行はこの版へ揃え、未知の版は作り直す */
export const APP_DB_SCHEMA_VERSION = 4;

/** プロバイダー API キーの保存行。平文なのでアクセス権の管理は docs/secrets.md を正とする */
export interface ProviderCredentialRow {
  provider: string;
  apiKey: string;
}

export interface AppDbStatus {
  /** null は永続化なし (メモリ DB)。開けなかったときも null */
  path: string | null;
  ok: boolean;
  error?: string;
}

export interface OpenAppDbOptions {
  /** 会話ストアと同じディレクトリ。null ならメモリ DB (テスト) */
  storeDir: string | null;
  /**
   * ログと health / 503 に載る DB エラー文言の境界。bootstrap が可変マスカーを渡し、
   * 登録済みのAPIキーが例外文言へ現れても生のまま記録しない。未指定は identity (テストの明示 opt-out)。
   */
  sanitizeError?: (text: string) => string;
}

/**
 * v1 -> v2 で足したテーブル。`IF NOT EXISTS` で定義を 1 つに保ち、新規作成と加算移行の両方から使う
 * (加算移行では既存の projects / agents / skills を消さない)。
 */
const NOTIFICATION_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL,
  webhookUrl TEXT,
  baseUrl TEXT,
  mention TEXT NOT NULL,
  lastResult TEXT
);
`;

/**
 * v2 -> v3 で足したテーブル。除外名は JSON 配列テキストで、**行が無い = 未設定**（実効値は既定）。
 * 明示空（`[]`）と区別するため、既定へ戻すときは行ごと消す。
 */
const ARCHIVE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS archive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  excludeNames TEXT NOT NULL
);
`;

/**
 * v3 -> v4 で足したテーブル。GUI から登録したプロバイダー API キーを 1 行 1 プロバイダーで持つ。
 * 値は必ずバインドして渡す (SQL 文字列へ埋め込まない)。
 */
const PROVIDER_CREDENTIALS_TABLE = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  apiKey TEXT NOT NULL
);
`;

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
${NOTIFICATION_SETTINGS_TABLE}
${ARCHIVE_SETTINGS_TABLE}
${PROVIDER_CREDENTIALS_TABLE}`;

/** アプリ所有のテーブルだけを落とす (同じ DB に足した別機能のテーブルを巻き込まない) */
const DROP_TABLES = `
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS archive_settings;
DROP TABLE IF EXISTS provider_credentials;
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

function providerCredentialOf(row: Row): ProviderCredentialRow {
  return { provider: text(row.provider), apiKey: text(row.apiKey) };
}

function notificationSettingsOf(row: Row): NotificationSettings {
  const settings: NotificationSettings = {
    enabled: Number(row.enabled) === 1,
    // 保存側は none / here しか書かないが、未知の値は既定へ寄せる
    mention: row.mention === "here" ? "here" : "none",
  };
  const webhookUrl = optionalText(row.webhookUrl);
  const baseUrl = optionalText(row.baseUrl);
  const lastResult = jsonObject<NotificationResult>(row.lastResult);
  if (webhookUrl) settings.webhookUrl = webhookUrl;
  if (baseUrl) settings.baseUrl = baseUrl;
  if (lastResult) settings.lastResult = lastResult;
  return settings;
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
  #sanitizeError: (text: string) => string;

  private constructor(
    db: DatabaseSync | null,
    path: string | null,
    sanitizeError: (text: string) => string,
    error?: string,
  ) {
    this.#db = db;
    this.#path = path;
    this.#sanitizeError = sanitizeError;
    this.#error = error;
  }

  static open({ storeDir, sanitizeError }: OpenAppDbOptions): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    const path = storeDir === null ? null : join(storeDir, APP_DB_FILENAME);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path ?? ":memory:");
      // 会話ストアと同じ方針 (メモリ DB では無視される)
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      const instance = new AppDb(db, path, sanitize);
      const version = instance.#schemaVersion();
      // user_version が 0 = 未初期化 (新規ファイル・0 バイトの残骸・メモリ DB)。このときだけ seed する
      if (version === 0) instance.#recreate(true);
      // 古い版は加算的に移行する (定義を消さない)。未知の新しい版だけ従来どおり作り直す
      else if (version < APP_DB_SCHEMA_VERSION) instance.#migrate();
      else if (version > APP_DB_SCHEMA_VERSION) instance.#recreate(false);
      return instance;
    } catch (error) {
      try {
        // 失敗した接続を残さない (後始末の失敗で元の理由を隠さない)
        db?.close();
      } catch {
        // noop
      }
      console.error(`[u7agent] app db unavailable: ${sanitize(messageFor(error))}`);
      return new AppDb(null, path, sanitize, sanitize(messageFor(error)));
    }
  }

  /** パス解決の失敗など、開く前に DB を使えないと分かっている状態 */
  static unavailable({
    storeDir,
    error,
    sanitizeError,
  }: {
    storeDir: string | null;
    error: string;
    sanitizeError?: (text: string) => string;
  }): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    return new AppDb(null, storeDir === null ? null : join(storeDir, APP_DB_FILENAME), sanitize, sanitize(error));
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
      this.#error = this.#sanitizeError(messageFor(error));
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

  /** 古い版からの加算的な移行。足りないテーブルだけを作り、既存の定義は触らない */
  #migrate(): void {
    this.#query((db) => db.exec("BEGIN"));
    try {
      this.#query((db) => db.exec(NOTIFICATION_SETTINGS_TABLE));
      this.#query((db) => db.exec(ARCHIVE_SETTINGS_TABLE));
      this.#query((db) => db.exec(PROVIDER_CREDENTIALS_TABLE));
      // PRAGMA はパラメータ化できない (値はコード側の定数)
      this.#query((db) => db.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION}`));
      this.#query((db) => db.exec("COMMIT"));
      console.log(`[u7agent] app db migrated (schema ${APP_DB_SCHEMA_VERSION})`);
    } catch (error) {
      try {
        this.#query((db) => db.exec("ROLLBACK"));
      } catch {
        // 元の例外を優先する
      }
      throw error;
    }
  }

  // --- notification settings (1 行だけ) ---

  getNotificationSettings(): NotificationSettings | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM notification_settings WHERE id = 1").get() as Row | undefined,
    );
    return row ? notificationSettingsOf(row) : undefined;
  }

  saveNotificationSettings(settings: NotificationSettings): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO notification_settings (id, enabled, webhookUrl, baseUrl, mention, lastResult)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, webhookUrl = excluded.webhookUrl,
             baseUrl = excluded.baseUrl, mention = excluded.mention, lastResult = excluded.lastResult`,
        )
        .run(
          settings.enabled ? 1 : 0,
          settings.webhookUrl ?? null,
          settings.baseUrl ?? null,
          settings.mention,
          settings.lastResult ? JSON.stringify(settings.lastResult) : null,
        ),
    );
  }

  // --- archive settings (1 行だけ。行が無い = 未設定) ---

  readArchiveExcludeNames(): string[] | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM archive_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      const names = jsonArray<string>(row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、他の列と同じく 503 にする
      if (!names) throw new Error("archive_settings.excludeNames is not a JSON array");
      return names;
    });
  }

  saveArchiveExcludeNames(names: readonly string[]): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO archive_settings (id, excludeNames) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET excludeNames = excluded.excludeNames`,
        )
        .run(JSON.stringify(names)),
    );
  }

  /** 行を消して未設定へ戻す (既定名を保存し直すと、以後の既定の更新に追随しなくなる) */
  resetArchiveExcludeNames(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM archive_settings WHERE id = 1").run().changes > 0);
  }

  // --- provider credentials (GUI から登録したプロバイダー API キー) ---

  listProviderCredentials(): ProviderCredentialRow[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM provider_credentials ORDER BY rowid").all() as Row[]).map(providerCredentialOf),
    );
  }

  getProviderCredential(provider: string): ProviderCredentialRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM provider_credentials WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerCredentialOf(row) : undefined;
  }

  /**
   * 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定し、
   * ここが成功して返れば行は永続化されている (呼び出し側の not_stored 判定の根拠)。
   */
  saveProviderCredential(provider: string, apiKey: string): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO provider_credentials (provider, apiKey) VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET apiKey = excluded.apiKey`,
        )
        .run(provider, apiKey),
    );
  }

  deleteProviderCredential(provider: string): boolean {
    return this.#query(
      (db) => db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider).changes > 0,
    );
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
}
