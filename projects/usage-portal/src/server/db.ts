import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSnapshot } from "./providers/types";
import type { SamplePoint } from "./trend";
import type { UsageError } from "./state";

export const SCHEMA_VERSION = 3;

/** 単一キー時代の OpenCode Go の source id。起動時の掃除でだけ使う。 */
const LEGACY_OPENCODE_SOURCE_ID = "opencode-go";
/** アカウント別のキーへ移す前の Codex の source id。起動時の引き継ぎでだけ使う。 */
const LEGACY_CODEX_SOURCE_ID = "codex";

/**
 * 3 つのテーブルの `provider` 列は provider id ではなく source id を持つ。
 * `codex`（未接続時）/ `codex:<chatgpt account id>` / `opencode-go:<account uuid>` が入り、
 * 列名だけが v1 のまま残っている。
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE provider_snapshot (
    provider TEXT PRIMARY KEY,
    captured_at INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL
  );

  CREATE TABLE provider_error (
    provider TEXT PRIMARY KEY,
    failed_at INTEGER NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE TABLE usage_sample (
    provider TEXT NOT NULL,
    window_id TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    resets_at INTEGER,
    PRIMARY KEY (provider, window_id, captured_at)
  ) WITHOUT ROWID;
  `,
  `
  CREATE TABLE fetch_interval (
    provider TEXT PRIMARY KEY,
    interval_ms INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE claude_start (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    stopped_code TEXT,
    last_sent_at INTEGER,
    armed_at INTEGER NOT NULL
  );

  CREATE TABLE claude_start_run (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    slot_at INTEGER,
    ran_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    code TEXT,
    resets_at INTEGER
  );

  CREATE INDEX claude_start_run_slot ON claude_start_run (slot_at);
  `,
];

export type DatabaseHandle = {
  db: Database;
  path: string;
  close: () => void;
};

const STATE_TABLES = ["provider_snapshot", "provider_error"] as const;
const USAGE_TABLES = [...STATE_TABLES, "usage_sample"] as const;

export function openDatabase(dataDir: string, filename = "usage.sqlite"): DatabaseHandle {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const path = join(dataDir, filename);
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);

  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) {
      chmodSync(file, 0o600);
    }
  }

  return { db, path, close: () => db.close() };
}

export function verifyDatabase(handle: DatabaseHandle): boolean {
  try {
    handle.db.query("SELECT 1").get();

    return true;
  } catch {
    return false;
  }
}

export type StoredProviderUsage = { snapshot: ProviderSnapshot | null; error: UsageError | null };

/** provider ごとに保存した取得間隔。行が無い provider は env か既定値を使う。 */
export function loadFetchIntervals(handle: DatabaseHandle): Map<string, number> {
  const rows = handle.db.query("SELECT provider, interval_ms FROM fetch_interval").all() as {
    provider: string;
    interval_ms: number;
  }[];

  return new Map(rows.map((row) => [row.provider, row.interval_ms]));
}

/** 停止判定に使う失敗の分類と時刻を、source ごとにまとめて読む。 */
export function loadProviderErrors(handle: DatabaseHandle): Map<string, { code: string; at: number }> {
  const rows = handle.db.query("SELECT provider, failed_at, code FROM provider_error").all() as {
    provider: string;
    failed_at: number;
    code: string;
  }[];

  return new Map(rows.map((row) => [row.provider, { code: row.code, at: row.failed_at }]));
}

export function saveFetchInterval(handle: DatabaseHandle, provider: string, intervalMs: number): void {
  handle.db
    .query(`
      INSERT INTO fetch_interval (provider, interval_ms) VALUES (?, ?)
      ON CONFLICT(provider) DO UPDATE SET interval_ms = excluded.interval_ms
    `)
    .run(provider, intervalMs);
}

/** 成功した 1 回分を 1 transaction で書く。snapshot と sample と error が食い違う中間状態を残さない。 */
export function saveProviderSnapshot(handle: DatabaseHandle, sourceId: string, snapshot: ProviderSnapshot): void {
  const upsert = handle.db.query(`
    INSERT INTO provider_snapshot (provider, captured_at, snapshot_json) VALUES (?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET captured_at = excluded.captured_at, snapshot_json = excluded.snapshot_json
  `);
  const insertSample = handle.db.query(`
    INSERT OR REPLACE INTO usage_sample (provider, window_id, captured_at, used_percent, resets_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const clearError = handle.db.query("DELETE FROM provider_error WHERE provider = ?");

  handle.db.transaction(() => {
    upsert.run(sourceId, snapshot.capturedAt, JSON.stringify(snapshot));

    for (const window of snapshot.windows) {
      insertSample.run(sourceId, window.id, snapshot.capturedAt, window.usedPercent, window.resetsAt);
    }

    clearError.run(sourceId);
  })();
}

/** snapshot は触らない。取得できなかった間も最後に成功した値を出し続ける。 */
export function saveProviderError(handle: DatabaseHandle, sourceId: string, error: UsageError): void {
  handle.db
    .query(`
      INSERT INTO provider_error (provider, failed_at, code, message) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET failed_at = excluded.failed_at, code = excluded.code, message = excluded.message
    `)
    .run(sourceId, error.at, error.code, error.message);
}

/** source を消すと sample も消す。残すと、同じ uuid で作り直したときに前の履歴が混ざる。 */
export function deleteProviderUsage(handle: DatabaseHandle, sourceId: string): void {
  deleteUsageRows(handle, "provider = ?", [sourceId]);
}

/** snapshot と error だけを消し、sample は残す。Codex のサインアウトで推移を引き継ぐために使う。 */
export function deleteProviderState(handle: DatabaseHandle, sourceId: string): void {
  deleteUsageRows(handle, "provider = ?", [sourceId], STATE_TABLES);
}

/**
 * 旧キー `codex` の snapshot と sample を、いまサインインしているアカウントへ引き継ぐ。
 * error は移さない。base キーの error はサインアウト中の未接続を表し、サインイン中のアカウントには当てはまらない。
 * 旧キーは同時に 1 アカウントぶんしか無い（サインアウトで消していた）ため、衝突したら新しい側を残す。
 */
export function migrateCodexUsage(handle: DatabaseHandle, sourceId: string): void {
  if (sourceId === LEGACY_CODEX_SOURCE_ID) {
    return;
  }

  handle.db.transaction(() => {
    handle.db
      .query(
        "INSERT OR IGNORE INTO provider_snapshot (provider, captured_at, snapshot_json) SELECT ?, captured_at, snapshot_json FROM provider_snapshot WHERE provider = ?",
      )
      .run(sourceId, LEGACY_CODEX_SOURCE_ID);
    handle.db
      .query(
        "INSERT OR IGNORE INTO usage_sample (provider, window_id, captured_at, used_percent, resets_at) SELECT ?, window_id, captured_at, used_percent, resets_at FROM usage_sample WHERE provider = ?",
      )
      .run(sourceId, LEGACY_CODEX_SOURCE_ID);

    for (const table of USAGE_TABLES) {
      handle.db.query(`DELETE FROM ${table} WHERE provider = ?`).run(LEGACY_CODEX_SOURCE_ID);
    }
  })();
}

/**
 * 単一キー時代の `opencode-go` 行を消す。Codex の行は残す。
 * 旧キーは `CREDENTIAL_DIR` に残るが、読み手がもう居ないので同じ行を引き継がない。
 */
export function deleteLegacyOpenCodeUsage(handle: DatabaseHandle): number {
  return deleteUsageRows(handle, "provider = ?", [LEGACY_OPENCODE_SOURCE_ID]);
}

/** アカウントを消したあとに残った `opencode-go:<uuid>` の行を掃除する（プロセスが落ちた場合の回収）。 */
export function pruneOpenCodeUsage(handle: DatabaseHandle, validSourceIds: readonly string[]): number {
  const placeholders = validSourceIds.map(() => "?").join(", ");
  const condition =
    validSourceIds.length === 0 ? "provider LIKE ?" : `provider LIKE ? AND provider NOT IN (${placeholders})`;

  return deleteUsageRows(handle, condition, ["opencode-go:%", ...validSourceIds]);
}

export function loadProviderUsage(
  handle: DatabaseHandle,
  sourceIds: readonly string[],
): Map<string, StoredProviderUsage> {
  const snapshots = new Map<string, ProviderSnapshot>();
  const errors = new Map<string, UsageError>();

  for (const row of handle.db.query("SELECT provider, snapshot_json FROM provider_snapshot").all() as {
    provider: string;
    snapshot_json: string;
  }[]) {
    const snapshot = parseSnapshot(row.snapshot_json);

    if (snapshot) {
      snapshots.set(row.provider, snapshot);
    }
  }

  for (const row of handle.db.query("SELECT provider, failed_at, code, message FROM provider_error").all() as {
    provider: string;
    failed_at: number;
    code: string;
    message: string;
  }[]) {
    errors.set(row.provider, { code: row.code as UsageError["code"], message: row.message, at: row.failed_at });
  }

  return new Map(
    sourceIds.map((sourceId) => [
      sourceId,
      { snapshot: snapshots.get(sourceId) ?? null, error: errors.get(sourceId) ?? null },
    ]),
  );
}

export function loadSamples(handle: DatabaseHandle, sourceId: string, windowId: string, since: number): SamplePoint[] {
  const rows = handle.db
    .query(
      "SELECT captured_at, used_percent FROM usage_sample WHERE provider = ? AND window_id = ? AND captured_at >= ? ORDER BY captured_at",
    )
    .all(sourceId, windowId, since) as { captured_at: number; used_percent: number }[];

  return rows.map((row) => ({ at: row.captured_at, usedPercent: row.used_percent }));
}

/** 保持期間を過ぎた sample だけを消す。snapshot と error は最新 1 行なので対象外。 */
export function pruneSamples(handle: DatabaseHandle, olderThan: number): number {
  return handle.db.query("DELETE FROM usage_sample WHERE captured_at < ?").run(olderThan).changes;
}

function deleteUsageRows(
  handle: DatabaseHandle,
  condition: string,
  values: readonly string[],
  tables: readonly string[] = USAGE_TABLES,
): number {
  const statements = tables.map((table) => handle.db.query(`DELETE FROM ${table} WHERE ${condition}`));

  return handle.db.transaction(() =>
    statements.reduce((total, statement) => total + statement.run(...values).changes, 0),
  )();
}

/** 予約の設定と実行の状態。設定は検証前の JSON のまま返し、読み手が検証する。 */
export type StoredClaudeStart = {
  settingsJson: string;
  enabled: boolean;
  failures: number;
  stoppedCode: string | null;
  lastSentAt: number | null;
  /** オンにした・設定を保存した時刻。これより前の枠は、再起動後も送らず見送りとしても残さない。 */
  armedAt: number;
};

export type ClaudeStartRunRow = {
  kind: "auto" | "manual";
  slotAt: number | null;
  ranAt: number;
  outcome: "ok" | "skipped" | "failed";
  code: string | null;
  resetsAt: number | null;
};

export function loadClaudeStart(handle: DatabaseHandle): StoredClaudeStart | null {
  const row = handle.db
    .query(
      "SELECT settings_json, enabled, failures, stopped_code, last_sent_at, armed_at FROM claude_start WHERE id = 1",
    )
    .get() as {
    settings_json: string;
    enabled: number;
    failures: number;
    stopped_code: string | null;
    last_sent_at: number | null;
    armed_at: number;
  } | null;

  if (row === null) {
    return null;
  }

  return {
    settingsJson: row.settings_json,
    enabled: row.enabled === 1,
    failures: row.failures,
    stoppedCode: row.stopped_code,
    lastSentAt: row.last_sent_at,
    armedAt: row.armed_at,
  };
}

export function saveClaudeStart(handle: DatabaseHandle, state: StoredClaudeStart): void {
  handle.db
    .query(`
      INSERT INTO claude_start (id, settings_json, enabled, failures, stopped_code, last_sent_at, armed_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, enabled = excluded.enabled,
        failures = excluded.failures, stopped_code = excluded.stopped_code, last_sent_at = excluded.last_sent_at,
        armed_at = excluded.armed_at
    `)
    .run(state.settingsJson, state.enabled ? 1 : 0, state.failures, state.stoppedCode, state.lastSentAt, state.armedAt);
}

export function insertClaudeStartRun(handle: DatabaseHandle, run: ClaudeStartRunRow): void {
  handle.db
    .query("INSERT INTO claude_start_run (kind, slot_at, ran_at, outcome, code, resets_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(run.kind, run.slotAt, run.ranAt, run.outcome, run.code, run.resetsAt);
}

/** 新しい順。 */
export function loadClaudeStartRuns(handle: DatabaseHandle, limit: number): ClaudeStartRunRow[] {
  const rows = handle.db
    .query(
      "SELECT kind, slot_at, ran_at, outcome, code, resets_at FROM claude_start_run ORDER BY ran_at DESC, id DESC LIMIT ?",
    )
    .all(limit) as {
    kind: ClaudeStartRunRow["kind"];
    slot_at: number | null;
    ran_at: number;
    outcome: ClaudeStartRunRow["outcome"];
    code: string | null;
    resets_at: number | null;
  }[];

  return rows.map((row) => ({
    kind: row.kind,
    slotAt: row.slot_at,
    ranAt: row.ran_at,
    outcome: row.outcome,
    code: row.code,
    resetsAt: row.resets_at,
  }));
}

/** 予約の枠を処理済みか。再起動や二重の timer で同じ枠を 2 回送らないために使う。 */
export function hasClaudeStartRunForSlot(handle: DatabaseHandle, slotAt: number): boolean {
  return (
    handle.db.query("SELECT 1 FROM claude_start_run WHERE kind = 'auto' AND slot_at = ? LIMIT 1").get(slotAt) !== null
  );
}

export function pruneClaudeStartRuns(handle: DatabaseHandle, olderThan: number): number {
  return handle.db.query("DELETE FROM claude_start_run WHERE ran_at < ?").run(olderThan).changes;
}

function parseSnapshot(json: string): ProviderSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(json);

    if (typeof parsed !== "object" || parsed === null || !("provider" in parsed) || !("windows" in parsed)) {
      return null;
    }

    return parsed as ProviderSnapshot;
  } catch {
    return null;
  }
}

function migrate(db: Database): void {
  const current = userVersion(db);

  if (current > SCHEMA_VERSION) {
    throw new Error(`SQLite の schema version が未知です: ${current} > ${SCHEMA_VERSION}`);
  }

  MIGRATIONS.slice(current).forEach((migration, index) => {
    const version = current + index + 1;

    db.transaction(() => {
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
  });
}

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;

  return row?.user_version ?? 0;
}
