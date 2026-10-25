import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
