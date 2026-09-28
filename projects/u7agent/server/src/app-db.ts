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
export const APP_DB_SCHEMA_VERSION = 9;

/** プロバイダー API キーの保存行。平文なのでアクセス権の管理は docs/secrets.md を正とする */
export interface ProviderCredentialRow {
  provider: string;
  apiKey: string;
  /** 最終保存時刻 (epoch ms)。NULL は移行前の行で不明 */
  updatedAt: number | null;
}

/** プロバイダーに紐づく人間用メモの保存行。空文字の行は未設定として返す (optionalText) */
export interface ProviderMemoRow {
  provider: string;
  memo: string;
}

/**
 * 利用可能なモデル / アプリ既定モデルの保存行。null は未設定 (制限なし・候補の先頭) を表す
 */
export interface ModelSettingsRow {
  allowedModels: ModelRef[] | null;
  defaultModel: string | null;
}

/**
 * 画像生成の保存行。**行が無い = 未設定**で、キー削除は行ごと消す。apiKey は平文
 * (アクセス権の管理と残存リスクは docs/secrets.md / docs/image-generation.md を正とする)
 */
export interface ImageSettingsRow {
  provider: string;
  model: string;
  apiKey: string;
}

/** カタログ 1 件の保存形。provider は v1 では openrouter 固定なので id と表示名だけを残す */
export interface ImageCatalogModelRow {
  id: string;
  name: string;
}

/**
 * live カタログのキャッシュ行。**行が無い = 取得できていない**で、SDK 同梱カタログへ落ちる。
 * 利用者データではなくキャッシュなので、壊れた行は未保存として扱い、設定 API を 503 にしない。
 */
export interface ImageCatalogRow {
  /** 最後に live を取得できた時刻 (epoch ms) */
  fetchedAt: number;
  models: ImageCatalogModelRow[];
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
 * `updatedAt` (epoch ms) は v6 -> v7 で足した列で、NULL は移行前の行 = 保存日不明。
 * 値は必ずバインドして渡す (SQL 文字列へ埋め込まない)。
 */
const PROVIDER_CREDENTIALS_TABLE = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  apiKey TEXT NOT NULL,
  updatedAt INTEGER
);
`;

/**
 * v4 -> v5 で足したテーブル。利用可能なモデルは JSON 配列テキストで、**行が無い = 未設定**。
 * 空配列も未設定 (制限なし) へ正規化するため、両方が null の保存は行ごと消す。
 */
const MODEL_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allowedModels TEXT,
  defaultModel TEXT
);
`;

/**
 * v5 -> v6 で足したテーブル。provider に紐づく人間用メモで、**行が無い = 未設定**。
 * credential とは別テーブルにし、キーの登録有無 (managed) とメモを混ぜない。
 */
const PROVIDER_MEMOS_TABLE = `
CREATE TABLE IF NOT EXISTS provider_memos (
  provider TEXT PRIMARY KEY,
  memo     TEXT NOT NULL
);
`;

/**
 * v7 -> v8 で足したテーブル。画像生成の provider / model / APIキーを 1 行だけ持ち、
 * **行が無い = 未設定**（キー削除は行ごと消す）。provider_credentials とは別管理にし、
 * プロバイダー登録キーを画像生成へ流用しない（docs/image-generation.md）。
 */
const IMAGE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS image_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  apiKey   TEXT NOT NULL
);
`;

/**
 * v8 -> v9 で足したテーブル。取得に失敗した起動でも前回の一覧を出せるように、
 * 最後に成功した live カタログを 1 行だけ残す (docs/image-generation.md)。
 */
const IMAGE_CATALOG_TABLE = `
CREATE TABLE IF NOT EXISTS image_catalog (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  fetchedAt INTEGER NOT NULL,
  models    TEXT NOT NULL
);
`;

/**
 * provider メモは retainSecret に登録しない方針なので、SQLite の例外文言に値が写り得る。
 * ログ・health・503 へは、この値を含まない固定文言だけを渡す。
 */
const PROVIDER_MEMO_QUERY_FAILED = "provider memo query failed";

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
${PROVIDER_CREDENTIALS_TABLE}
${MODEL_SETTINGS_TABLE}
${PROVIDER_MEMOS_TABLE}
${IMAGE_SETTINGS_TABLE}
${IMAGE_CATALOG_TABLE}`;

/** アプリ所有のテーブルだけを落とす (同じ DB に足した別機能のテーブルを巻き込まない) */
const DROP_TABLES = `
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS notification_settings;
DROP TABLE IF EXISTS archive_settings;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS model_settings;
DROP TABLE IF EXISTS provider_memos;
DROP TABLE IF EXISTS image_settings;
DROP TABLE IF EXISTS image_catalog;
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

/** NULL を不明のまま読む (移行前の行を 0 と混同しない) */
function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
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

/**
 * 保存行の JSON 配列を読む。JSON.parse の文言は値の断片を写すため、テーブル / 列だけを示して
 * 503 へ渡す (health とログで、どの行を直せばよいか分かるようにする)。
 */
function jsonArrayColumn<T>(table: string, column: string, value: unknown): T[] | undefined {
  try {
    return jsonArray<T>(value);
  } catch {
    throw new Error(`${table}.${column} is not valid JSON`);
  }
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
  return { provider: text(row.provider), apiKey: text(row.apiKey), updatedAt: optionalNumber(row.updatedAt) };
}

/** 空文字の行は未設定として落とす (手編集された DB を「メモあり」と読み違えない) */
function providerMemoOf(row: Row): ProviderMemoRow | undefined {
  const memo = optionalText(row.memo);
  return memo === undefined ? undefined : { provider: text(row.provider), memo };
}

/** 列は NOT NULL だが、手編集で空文字にされた行は未設定として読む (メモと同じ規約) */
function imageSettingsOf(row: Row): ImageSettingsRow | undefined {
  const provider = optionalText(row.provider);
  const model = optionalText(row.model);
  const apiKey = optionalText(row.apiKey);
  if (!provider || !model || !apiKey) return undefined;
  return { provider, model, apiKey };
}

/**
 * キャッシュ行の JSON 配列。要素の形が違えば行ごと無視する (キャッシュなので、読めなければ
 * SDK カタログへ落ちれば足りる)。JSON 自体が壊れているときは列名だけの例外にする。
 */
function imageCatalogModelsOf(value: unknown): ImageCatalogModelRow[] | undefined {
  const entries = jsonArrayColumn<unknown>("image_catalog", "models", value);
  if (!entries || entries.length === 0) return undefined;
  const models: ImageCatalogModelRow[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
    models.push({ id, name });
  }
  return models;
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
  /**
   * 壊れた保存値のように、別テーブルの読取成功で消してはいけない失敗。テーブル名ごとに持ち、
   * 同じテーブルの読取が成功したときだけ解除する。一過性の失敗 (#error) と違い probe() では消えない。
   */
  #storedValueErrors = new Map<string, string>();
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
    // 壊れた保存値は別テーブルの成功で消さない (health が失敗を示し続ける)。解消はその行の修正か保存し直し
    const [storedValueError] = this.#storedValueErrors.values();
    const error = storedValueError ?? this.#error;
    return error ? { path: this.#path, ok: false, error } : { path: this.#path, ok: true };
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

  /**
   * 稼働中の失敗も 503 に寄せる (成功したら解除する)。理由は health にも出る。
   * `storedValueKey` を渡した読取は「壊れた保存値」として扱い、別テーブルの成功では消さない。
   */
  #query<T>(fn: (db: DatabaseSync) => T, storedValueKey?: string): T {
    const db = this.#handle();
    try {
      const result = fn(db);
      if (storedValueKey) this.#storedValueErrors.delete(storedValueKey);
      this.#error = undefined;
      return result;
    } catch (error) {
      const message = this.#sanitizeError(messageFor(error));
      this.#error = message;
      if (storedValueKey) this.#storedValueErrors.set(storedValueKey, message);
      console.error(`[u7agent] app db query failed: ${message}`);
      throw httpError(503, `アプリデータ（SQLite）を利用できません: ${message}`);
    }
  }

  /**
   * provider メモ専用のクエリ入口。メモはマスカーへ登録しないため、トリガーの RAISE などで例外文言に
   * 値が写っても、#query がログ / #error へ渡す前に値を含まない固定文言へ置き換える。
   */
  #memoQuery<T>(fn: (db: DatabaseSync) => T): T {
    return this.#query((db) => {
      try {
        return fn(db);
      } catch {
        throw new Error(PROVIDER_MEMO_QUERY_FAILED);
      }
    });
  }

  #schemaVersion(): number {
    const row = this.#handle().prepare("PRAGMA user_version").get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  /**
   * 加算移行の列追加。SQLite に `ADD COLUMN IF NOT EXISTS` は無く PRAGMA はパラメータ化できないため、
   * テーブル名・列名・定義はコード側の定数だけを渡す。存在確認は毎回 PRAGMA を引く
   * (結果をキャッシュすると、同じ列名を別テーブルへ足すときに壊れる)。
   */
  #addColumnIfMissing(table: string, column: string, definition: string): void {
    this.#query((db) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (columns.some((row) => row.name === column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });
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

  /** 古い版からの加算的な移行。足りないテーブルと列だけを足し、既存の定義は触らない */
  #migrate(): void {
    this.#query((db) => db.exec("BEGIN"));
    try {
      this.#query((db) => db.exec(NOTIFICATION_SETTINGS_TABLE));
      this.#query((db) => db.exec(ARCHIVE_SETTINGS_TABLE));
      this.#query((db) => db.exec(PROVIDER_CREDENTIALS_TABLE));
      this.#query((db) => db.exec(MODEL_SETTINGS_TABLE));
      this.#query((db) => db.exec(PROVIDER_MEMOS_TABLE));
      this.#query((db) => db.exec(IMAGE_SETTINGS_TABLE));
      this.#query((db) => db.exec(IMAGE_CATALOG_TABLE));
      // 列追加は CREATE TABLE IF NOT EXISTS の後 (既存テーブルでは CREATE が何もしないため)。DDL も
      // トランザクション対象なので、途中失敗で列だけが残らない
      this.#addColumnIfMissing("provider_credentials", "updatedAt", "INTEGER");
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
      const names = jsonArrayColumn<string>("archive_settings", "excludeNames", row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、他の列と同じく 503 にする
      if (!names) throw new Error("archive_settings.excludeNames is not a JSON array");
      return names;
    }, "archive_settings");
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
   * `updatedAt` (epoch ms) は呼び出し側が渡す (移行で既存行を書き戻さない)。
   */
  saveProviderCredential(provider: string, apiKey: string, updatedAt: number): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO provider_credentials (provider, apiKey, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET apiKey = excluded.apiKey, updatedAt = excluded.updatedAt`,
        )
        .run(provider, apiKey, updatedAt),
    );
  }

  deleteProviderCredential(provider: string): boolean {
    return this.#query(
      (db) => db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider).changes > 0,
    );
  }

  // --- provider memos (provider に紐づく人間用メモ。行が無い = 未設定) ---

  listProviderMemos(): ProviderMemoRow[] {
    return this.#memoQuery((db) =>
      (db.prepare("SELECT * FROM provider_memos ORDER BY rowid").all() as Row[])
        .map(providerMemoOf)
        .filter((row): row is ProviderMemoRow => row !== undefined),
    );
  }

  getProviderMemo(provider: string): ProviderMemoRow | undefined {
    const row = this.#memoQuery(
      (db) => db.prepare("SELECT * FROM provider_memos WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerMemoOf(row) : undefined;
  }

  /** 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定する */
  saveProviderMemo(provider: string, memo: string): void {
    this.#memoQuery((db) =>
      db
        .prepare(
          `INSERT INTO provider_memos (provider, memo) VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET memo = excluded.memo`,
        )
        .run(provider, memo),
    );
  }

  deleteProviderMemo(provider: string): boolean {
    return this.#memoQuery(
      (db) => db.prepare("DELETE FROM provider_memos WHERE provider = ?").run(provider).changes > 0,
    );
  }

  // --- model settings (1 行だけ。行が無い = 未設定) ---

  /** 行が無ければ undefined。壊れた JSON は黙って未設定へ落とさず 503 にする */
  readModelSettings(): ModelSettingsRow | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM model_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      // 行がある以上 allowedModels は JSON 配列か NULL のはず。壊れた値を制限なしと読み違えない
      const parsed =
        row.allowedModels === null
          ? null
          : jsonArrayColumn<ModelRef>("model_settings", "allowedModels", row.allowedModels);
      if (row.allowedModels !== null && !parsed) throw new Error("model_settings.allowedModels is not a JSON array");
      return {
        allowedModels: parsed && parsed.length > 0 ? parsed : null,
        defaultModel: optionalText(row.defaultModel) ?? null,
      };
    }, "model_settings");
  }

  /** 空配列は制限なしへ正規化する。両方 null になったら行を消して未設定へ戻す */
  saveModelSettings(settings: ModelSettingsRow): void {
    const allowedModels = settings.allowedModels && settings.allowedModels.length > 0 ? settings.allowedModels : null;
    const defaultModel = settings.defaultModel || null;
    if (!allowedModels && !defaultModel) {
      this.resetModelSettings();
      return;
    }
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO model_settings (id, allowedModels, defaultModel) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET allowedModels = excluded.allowedModels, defaultModel = excluded.defaultModel`,
        )
        .run(allowedModels ? JSON.stringify(allowedModels) : null, defaultModel),
    );
  }

  /** 行を消して未設定へ戻す (保存値が残っていないことを応答で確かめる導線) */
  resetModelSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM model_settings WHERE id = 1").run().changes > 0);
  }

  // --- image settings (1 行だけ。行が無い = 未設定) ---

  /** 行が無ければ undefined。空文字へ手編集された行も未設定として読む */
  readImageSettings(): ImageSettingsRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM image_settings WHERE id = 1").get() as Row | undefined);
    return row ? imageSettingsOf(row) : undefined;
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。単一ステートメントなので自動コミットで確定する */
  saveImageSettings(settings: ImageSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO image_settings (id, provider, model, apiKey) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, apiKey = excluded.apiKey`,
        )
        .run(settings.provider, settings.model, settings.apiKey),
    );
  }

  /** 行を消して未設定へ戻す (キー削除は provider / model も含めて行ごと消す) */
  deleteImageSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM image_settings WHERE id = 1").run().changes > 0);
  }

  // --- image catalog (live カタログのキャッシュ 1 行) ---

  /** 行が無い / 形が壊れているときは undefined (未取得として SDK カタログへ落とす) */
  readImageCatalog(): ImageCatalogRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM image_catalog WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const models = imageCatalogModelsOf(row.models);
    const fetchedAt = Number(row.fetchedAt);
    if (!models || !Number.isFinite(fetchedAt)) return undefined;
    return { fetchedAt, models };
  }

  /** 取得成功時の上書き (id = 1 の upsert)。キャッシュなので、失敗しても呼び出し側は続行する */
  saveImageCatalog(row: ImageCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO image_catalog (id, fetchedAt, models) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, models = excluded.models`,
        )
        .run(row.fetchedAt, JSON.stringify(row.models)),
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
