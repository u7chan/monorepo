import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionTarget } from "./targets";

export type ConnectionRecord = {
  id: string;
  name: string;
  origin: string;
  sessionId: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
};

export type ApiKeyRecord = {
  id: string;
  connectionId: string;
  name: string;
  prefix: string;
  /** 照合にだけ使う。管理 API の KeyView には載せない。 */
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

export type RunStatus = "running" | "awaiting_answer" | "completed" | "stopped" | "error";

export type RunRecord = {
  runId: string;
  connectionId: string;
  keyId: string;
  status: RunStatus;
  text: string | null;
  error: string | null;
  sessionUrl: string;
  createdAt: number;
  updatedAt: number;
};

export type RunView = RunRecord & { keyName: string | null };

/** 最後に使った時刻の書き込みは、この間隔より細かくしない。読み取りのたびに書くと WAL が太る。 */
const TOUCH_INTERVAL_MS = 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    session_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (origin, session_id, space_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS api_keys_connection ON api_keys (connection_id);

  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    status TEXT NOT NULL,
    text TEXT,
    error TEXT,
    session_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS runs_connection ON runs (connection_id, created_at DESC);
`;

type ConnectionRow = {
  id: string;
  name: string;
  origin: string;
  session_id: string;
  space_id: string;
  created_at: number;
  updated_at: number;
};

type KeyRow = {
  id: string;
  connection_id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

type RunRow = {
  run_id: string;
  connection_id: string;
  key_id: string;
  status: string;
  text: string | null;
  error: string | null;
  session_url: string;
  created_at: number;
  updated_at: number;
};

const RUN_STATUSES = new Set<RunStatus>(["running", "awaiting_answer", "completed", "stopped", "error"]);

function toConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    origin: row.origin,
    sessionId: row.session_id,
    spaceId: row.space_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function toRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    connectionId: row.connection_id,
    keyId: row.key_id,
    status: RUN_STATUSES.has(row.status as RunStatus) ? (row.status as RunStatus) : "error",
    text: row.text,
    error: row.error,
    sessionUrl: row.session_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const database = new Database(join(dataDir, "relay.sqlite"), { create: true });

  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(SCHEMA);

  return database;
}

export function createStore(database: Database) {
  const listConnectionsQuery = database.query<ConnectionRow, []>("SELECT * FROM connections ORDER BY created_at DESC");
  const getConnectionQuery = database.query<ConnectionRow, [string]>("SELECT * FROM connections WHERE id = ?");
  const findConnectionQuery = database.query<ConnectionRow, [string, string, string]>(
    "SELECT * FROM connections WHERE origin = ? AND session_id = ? AND space_id = ?",
  );
  const insertConnectionQuery = database.query(
    `INSERT INTO connections (id, name, origin, session_id, space_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateConnectionQuery = database.query(
    "UPDATE connections SET name = ?, origin = ?, session_id = ?, space_id = ?, updated_at = ? WHERE id = ?",
  );
  const deleteConnectionQuery = database.query("DELETE FROM connections WHERE id = ?");

  const listKeysQuery = database.query<KeyRow, []>("SELECT * FROM api_keys ORDER BY created_at DESC");
  const getKeyQuery = database.query<KeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?");
  const findKeyQuery = database.query<KeyRow, [string]>("SELECT * FROM api_keys WHERE hash = ?");
  const findActiveKeyQuery = database.query<KeyRow, [string]>(
    "SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL",
  );
  const insertKeyQuery = database.query(
    `INSERT INTO api_keys (id, connection_id, name, prefix, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const touchKeyQuery = database.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?");
  const revokeKeyQuery = database.query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
  const deleteKeyQuery = database.query("DELETE FROM api_keys WHERE id = ?");
  const countKeysQuery = database.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM api_keys WHERE connection_id = ?",
  );

  const insertRunQuery = database.query(
    `INSERT INTO runs (run_id, connection_id, key_id, status, text, error, session_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getRunQuery = database.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?");
  const updateRunQuery = database.query(
    "UPDATE runs SET status = ?, text = ?, error = ?, updated_at = ? WHERE run_id = ?",
  );
  // 一覧に本文を全部載せない。GUI のプレビューに必要な先頭だけを返し、応答サイズを抑える。
  const listRunsQuery = database.query<RunRow & { key_name: string | null }, [number]>(
    `SELECT runs.run_id, runs.connection_id, runs.key_id, runs.status,
            substr(runs.text, 1, 200) AS text, runs.error, runs.session_url,
            runs.created_at, runs.updated_at, api_keys.name AS key_name
     FROM runs LEFT JOIN api_keys ON api_keys.id = runs.key_id
     ORDER BY runs.created_at DESC LIMIT ?`,
  );
  const deleteRunsByConnectionQuery = database.query("DELETE FROM runs WHERE connection_id = ?");
  const pruneRunsQuery = database.query("DELETE FROM runs WHERE created_at < ?");

  const deleteConnectionTx = database.transaction((id: string) => {
    deleteRunsByConnectionQuery.run(id);
    // api_keys は ON DELETE CASCADE。runs は鍵を消しても履歴を読めるよう、接続単位でだけ消す。
    deleteConnectionQuery.run(id);
  });

  return {
    close: () => database.close(),

    listConnections(): ConnectionRecord[] {
      return listConnectionsQuery.all().map(toConnection);
    },

    getConnection(id: string): ConnectionRecord | null {
      const row = getConnectionQuery.get(id);

      return row ? toConnection(row) : null;
    },

    findConnection(target: ConnectionTarget): ConnectionRecord | null {
      const row = findConnectionQuery.get(target.origin, target.sessionId, target.spaceId);

      return row ? toConnection(row) : null;
    },

    insertConnection(record: ConnectionRecord): void {
      insertConnectionQuery.run(
        record.id,
        record.name,
        record.origin,
        record.sessionId,
        record.spaceId,
        record.createdAt,
        record.updatedAt,
      );
    },

    updateConnection(id: string, name: string, target: ConnectionTarget, now: number): void {
      updateConnectionQuery.run(name, target.origin, target.sessionId, target.spaceId, now, id);
    },

    deleteConnection(id: string): void {
      deleteConnectionTx(id);
    },

    listKeys(): ApiKeyRecord[] {
      return listKeysQuery.all().map(toKey);
    },

    getKey(id: string): ApiKeyRecord | null {
      const row = getKeyQuery.get(id);

      return row ? toKey(row) : null;
    },

    /** ハッシュは token から作る。revoked の行も返し、呼び出し側が状態を区別できるようにする。 */
    findKeyByHash(hash: string): ApiKeyRecord | null {
      const row = findKeyQuery.get(hash);

      return row ? toKey(row) : null;
    },

    findActiveKeyByHash(hash: string): ApiKeyRecord | null {
      const row = findActiveKeyQuery.get(hash);

      return row ? toKey(row) : null;
    },

    insertKey(record: Omit<ApiKeyRecord, "lastUsedAt" | "revokedAt">): void {
      insertKeyQuery.run(record.id, record.connectionId, record.name, record.prefix, record.hash, record.createdAt);
    },

    touchKey(id: string, now: number): void {
      const row = getKeyQuery.get(id);

      if (!row || (row.last_used_at !== null && now - row.last_used_at < TOUCH_INTERVAL_MS)) {
        return;
      }

      touchKeyQuery.run(now, id);
    },

    revokeKey(id: string, now: number): boolean {
      return revokeKeyQuery.run(now, id).changes > 0;
    },

    deleteKey(id: string): boolean {
      return deleteKeyQuery.run(id).changes > 0;
    },

    countKeys(connectionId: string): number {
      return countKeysQuery.get(connectionId)?.count ?? 0;
    },

    insertRun(record: Omit<RunRecord, "text" | "error">): void {
      insertRunQuery.run(
        record.runId,
        record.connectionId,
        record.keyId,
        record.status,
        null,
        null,
        record.sessionUrl,
        record.createdAt,
        record.updatedAt,
      );
    },

    getRun(runId: string): RunRecord | null {
      const row = getRunQuery.get(runId);

      return row ? toRun(row) : null;
    },

    updateRun(runId: string, status: RunStatus, text: string | null, error: string | null, now: number): void {
      updateRunQuery.run(status, text, error, now, runId);
    },

    listRuns(limit: number): RunView[] {
      return listRunsQuery.all(limit).map((row) => ({ ...toRun(row), keyName: row.key_name }));
    },

    /** 実行履歴は監査用に残すが、無期限には増やさない。起動時に古い行だけ消す。 */
    pruneRuns(before: number): number {
      return pruneRunsQuery.run(before).changes;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
