import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId, ProviderSnapshot } from "./providers/types";
import type { SamplePoint } from "./trend";
import type { UsageError } from "./state";

export const SCHEMA_VERSION = 1;

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
];

export type DatabaseHandle = {
  db: Database;
  path: string;
  close: () => void;
};

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

/** 成功した 1 回分を 1 transaction で書く。snapshot と sample と error が食い違う中間状態を残さない。 */
export function saveProviderSnapshot(handle: DatabaseHandle, snapshot: ProviderSnapshot): void {
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
    upsert.run(snapshot.provider, snapshot.capturedAt, JSON.stringify(snapshot));

    for (const window of snapshot.windows) {
      insertSample.run(snapshot.provider, window.id, snapshot.capturedAt, window.usedPercent, window.resetsAt);
    }

    clearError.run(snapshot.provider);
  })();
}

/** snapshot は触らない。取得できなかった間も最後に成功した値を出し続ける。 */
export function saveProviderError(handle: DatabaseHandle, provider: ProviderId, error: UsageError): void {
  handle.db
    .query(`
      INSERT INTO provider_error (provider, failed_at, code, message) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET failed_at = excluded.failed_at, code = excluded.code, message = excluded.message
    `)
    .run(provider, error.at, error.code, error.message);
}

export function deleteProviderUsage(handle: DatabaseHandle, provider: ProviderId): void {
  handle.db.transaction(() => {
    handle.db.query("DELETE FROM provider_snapshot WHERE provider = ?").run(provider);
    handle.db.query("DELETE FROM provider_error WHERE provider = ?").run(provider);
  })();
}

export function loadProviderUsage(
  handle: DatabaseHandle,
  providers: readonly ProviderId[],
): Map<ProviderId, StoredProviderUsage> {
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
    providers.map((provider) => [
      provider,
      { snapshot: snapshots.get(provider) ?? null, error: errors.get(provider) ?? null },
    ]),
  );
}

export function loadSamples(
  handle: DatabaseHandle,
  provider: ProviderId,
  windowId: string,
  since: number,
): SamplePoint[] {
  const rows = handle.db
    .query(
      "SELECT captured_at, used_percent FROM usage_sample WHERE provider = ? AND window_id = ? AND captured_at >= ? ORDER BY captured_at",
    )
    .all(provider, windowId, since) as { captured_at: number; used_percent: number }[];

  return rows.map((row) => ({ at: row.captured_at, usedPercent: row.used_percent }));
}

/** 保持期間を過ぎた sample だけを消す。snapshot と error は最新 1 行なので対象外。 */
export function pruneSamples(handle: DatabaseHandle, olderThan: number): number {
  return handle.db.query("DELETE FROM usage_sample WHERE captured_at < ?").run(olderThan).changes;
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
