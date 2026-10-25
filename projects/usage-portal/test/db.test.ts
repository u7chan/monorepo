// SQLite の open / migration と、データの置き場の権限を固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION, verifyDatabase, type DatabaseHandle } from "../src/server/db";

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
  test("v1 のテーブルを作り、user_version を 1 にする", () => {
    const { db, path } = open();

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(["provider_error", "provider_snapshot", "usage_sample"]);
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
