// SQLite の open / migration と、データの置き場の権限を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteClaudeResetCredits,
  loadClaudeResetCredits,
  loadFetchIntervals,
  openDatabase,
  saveClaudeResetCredits,
  saveClaudeResetCreditsError,
  saveFetchInterval,
  saveProviderError,
  loadProviderErrors,
  SCHEMA_VERSION,
  verifyDatabase,
  type DatabaseHandle,
} from "../src/server/db";

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-db-"));

  dirs.push(dir);

  return dir;
}

function open(dataDir = tempDir()): DatabaseHandle {
  const handle = openDatabase(dataDir);

  handles.push(handle);

  return handle;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  test("v4 のテーブルを作り、user_version を 4 にする", () => {
    const { db, path } = open();

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "claude_reset_credits",
      "claude_start",
      "claude_start_run",
      "fetch_interval",
      "provider_error",
      "provider_snapshot",
      "usage_sample",
    ]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(path.endsWith("usage.sqlite")).toBe(true);
  });

  test("WAL と busy_timeout を設定する", () => {
    const { db } = open();

    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  test("データディレクトリを 0700、DB ファイルを 0600 にする", () => {
    const dataDir = tempDir();
    const { path } = open(dataDir);

    expect(mode(dataDir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  test("開き直しても migration を繰り返さず、既存の行を残す", () => {
    const dataDir = tempDir();
    const first = openDatabase(dataDir);

    first.db.exec(
      "INSERT INTO provider_error (provider, failed_at, code, message) VALUES ('codex', 1, 'upstream', 'x')",
    );
    first.close();

    const second = openDatabase(dataDir);

    handles.push(second);

    expect(second.db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(second.db.query("SELECT provider FROM provider_error").all()).toEqual([{ provider: "codex" }]);
  });

  test("未知の schema version では開かない", () => {
    const dataDir = tempDir();
    const handle = openDatabase(dataDir);

    handle.db.exec("PRAGMA user_version = 99");
    handle.close();

    expect(() => openDatabase(dataDir)).toThrow();
  });

  test("verifyDatabase は close 後に false を返す", () => {
    const handle = open();

    expect(verifyDatabase(handle)).toBe(true);

    handle.close();
    handles.splice(handles.indexOf(handle), 1);

    expect(verifyDatabase(handle)).toBe(false);
  });
});

describe("v1 からの migration", () => {
  test("既存の行を残したまま v2 の fetch_interval と v3 の開始予約を足す", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "usage.sqlite");
    const legacy = new Database(path, { create: true });

    legacy.exec(`
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

      INSERT INTO provider_snapshot (provider, captured_at, snapshot_json) VALUES ('codex', 1, '{}');
      INSERT INTO provider_error (provider, failed_at, code, message) VALUES ('codex', 1, 'upstream', 'x');
      INSERT INTO usage_sample (provider, window_id, captured_at, used_percent, resets_at)
        VALUES ('codex', 'weekly', 1, 50, NULL);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const handle = openDatabase(dataDir);

    handles.push(handle);

    const tables = handle.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "claude_reset_credits",
      "claude_start",
      "claude_start_run",
      "fetch_interval",
      "provider_error",
      "provider_snapshot",
      "usage_sample",
    ]);
    expect(handle.db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(handle.db.query("SELECT provider, code FROM provider_error").get()).toEqual({
      provider: "codex",
      code: "upstream",
    });
    expect(handle.db.query("SELECT COUNT(*) AS count FROM provider_snapshot").get()).toEqual({ count: 1 });
    expect(handle.db.query("SELECT COUNT(*) AS count FROM usage_sample").get()).toEqual({ count: 1 });
  });
});

describe("fetch_interval", () => {
  test("provider ごとに保存し、上書きできる", () => {
    const handle = open();

    expect(loadFetchIntervals(handle).size).toBe(0);

    saveFetchInterval(handle, "codex", 300_000);
    saveFetchInterval(handle, "opencode-go", 1_800_000);
    saveFetchInterval(handle, "codex", 600_000);

    expect(loadFetchIntervals(handle)).toEqual(
      new Map([
        ["codex", 600_000],
        ["opencode-go", 1_800_000],
      ]),
    );
  });
});

describe("provider_error の一括読み出し", () => {
  test("停止判定に使う分類と時刻を source ごとに返す", () => {
    const handle = open();

    saveProviderError(handle, "opencode-go:11111111-1111-4111-8111-111111111111", {
      code: "subscription_required",
      message: "契約が必要です",
      at: 1234,
    });
    saveProviderError(handle, "codex", { code: "upstream", message: "取得できません", at: 5678 });

    expect(loadProviderErrors(handle)).toEqual(
      new Map([
        ["opencode-go:11111111-1111-4111-8111-111111111111", { code: "subscription_required", at: 1234 }],
        ["codex", { code: "upstream", at: 5678 }],
      ]),
    );
  });
});

describe("claude_reset_credits", () => {
  test("成功で値を置き換え、失敗では前回の値を残して error だけを書く", () => {
    const handle = open();

    expect(loadClaudeResetCredits(handle)).toBeNull();

    saveClaudeResetCredits(handle, { capturedAt: 1000, credits: { available: 2, expiries: [2000, 3000] } });

    expect(loadClaudeResetCredits(handle)).toEqual({
      credits: { available: 2, expiries: [2000, 3000] },
      capturedAt: 1000,
      error: null,
    });

    saveClaudeResetCreditsError(handle, { code: "upstream", message: "取得できませんでした", at: 1500 });

    expect(loadClaudeResetCredits(handle)).toEqual({
      credits: { available: 2, expiries: [2000, 3000] },
      capturedAt: 1000,
      error: { code: "upstream", message: "取得できませんでした", at: 1500 },
    });

    saveClaudeResetCredits(handle, { capturedAt: 2000, credits: { available: 1, expiries: [4000] } });

    expect(loadClaudeResetCredits(handle)).toEqual({
      credits: { available: 1, expiries: [4000] },
      capturedAt: 2000,
      error: null,
    });
  });

  test("失敗だけのときは値を持たず、ログアウトで消せる", () => {
    const handle = open();

    saveClaudeResetCreditsError(handle, { code: "reauth_required", message: "再サインイン", at: 1 });

    expect(loadClaudeResetCredits(handle)).toEqual({
      credits: null,
      capturedAt: null,
      error: { code: "reauth_required", message: "再サインイン", at: 1 },
    });

    deleteClaudeResetCredits(handle);

    expect(loadClaudeResetCredits(handle)).toBeNull();
  });
});
