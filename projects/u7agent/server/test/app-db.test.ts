// アプリデータの SQLite (server/src/app-db.ts) の単体テスト。実ファイルは一時ディレクトリに作る。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppDb, APP_DB_FILENAME, APP_DB_SCHEMA_VERSION } from "../src/app-db";
import type { AgentDef, Project, SkillDef } from "../src/schema";

function tempStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "u7agent-app-db-"));
}

function isServiceUnavailable(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 503;
}

const agent = (id: string, skillIds: string[] = []): AgentDef => ({
  id,
  name: id,
  description: "",
  systemPrompt: "",
  skillIds,
});

const skill = (id: string): SkillDef => ({ id, name: id, description: "", body: "body" });

const project = (id: string, cwd: string): Project => ({ id, name: id, cwd, createdAt: 1 });

test("an in-memory db has no path and holds the seed", () => {
  const db = AppDb.open({ storeDir: null });
  assert.deepEqual(db.status(), { path: null, ok: true });
  assert.deepEqual(
    db.listAgents().map((entry) => entry.id),
    ["agent-zundamon"],
  );
  db.close();
});

test("a new file db is seeded once and a deleted sample does not come back", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    assert.deepEqual(first.status(), { path: join(dir, APP_DB_FILENAME), ok: true });
    assert.deepEqual(
      first.listAgents().map((entry) => entry.id),
      ["agent-zundamon"],
    );
    assert.equal(first.deleteAgent("agent-zundamon"), true);
    first.close();

    // 同じディレクトリを開き直す = 再起動。既存の DB なので seed しない
    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.listAgents(), []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps projects, skills and agents across reopen", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    first.deleteAgent("agent-zundamon");
    first.insertProject(project("p1", "proj-a"));
    first.saveSkill(skill("s1"));
    first.saveAgent({ ...agent("a1", ["s1"]), icon: "data:image/png;base64,AA==", thinkingLevel: "high" });
    first.close();

    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.listProjects(), [project("p1", "proj-a")]);
    assert.deepEqual(second.listSkills(), [skill("s1")]);
    assert.deepEqual(second.listAgents(), [
      { ...agent("a1", ["s1"]), icon: "data:image/png;base64,AA==", thinkingLevel: "high" },
    ]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recreates the tables without the seed when the schema version differs", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    first.insertProject(project("p1", "proj-a"));
    first.saveAgent(agent("a1"));
    first.close();

    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION + 1}`);
    raw.close();

    const second = AppDb.open({ storeDir: dir });
    // 作り直してもサンプルは入れない (消した定義が復活しない)
    assert.deepEqual(second.listAgents(), []);
    assert.deepEqual(second.listProjects(), []);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rolls back a transaction that fails in the middle", () => {
  const db = AppDb.open({ storeDir: null });
  db.deleteAgent("agent-zundamon");
  db.saveAgent(agent("kept"));

  // name は NOT NULL。2 件目の書き込みで失敗させ、1 件目が残らないことを見る
  const broken = { ...agent("broken"), name: null as unknown as string };
  assert.throws(
    () =>
      db.transaction(() => {
        db.saveAgent(agent("rolled-back"));
        db.saveAgent(broken);
      }),
    isServiceUnavailable,
  );

  assert.deepEqual(
    db.listAgents().map((entry) => entry.id),
    ["kept"],
  );
  db.close();
});

test("a failing skill delete leaves the references untouched", () => {
  const db = AppDb.open({ storeDir: null });
  db.saveSkill(skill("s1"));
  db.saveAgent(agent("a1", ["s1"]));

  // 存在しないスキルの削除は false。参照も触らない
  assert.equal(db.deleteSkillAndDetach("missing"), false);
  assert.deepEqual(db.getAgent("a1")?.skillIds, ["s1"]);

  assert.equal(db.deleteSkillAndDetach("s1"), true);
  assert.equal(db.getSkill("s1"), undefined);
  assert.deepEqual(db.getAgent("a1")?.skillIds, []);
  db.close();
});

test("an unusable path makes the db unavailable and every query a 503", () => {
  const dir = tempStoreDir();
  try {
    // ディレクトリではなくファイルを store dir に指定する (open が失敗する)
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "");

    const db = AppDb.open({ storeDir: filePath });
    const status = db.status();
    assert.equal(status.ok, false);
    assert.equal(status.path, join(filePath, APP_DB_FILENAME));
    assert.ok(status.error);
    assert.throws(() => db.listProjects(), isServiceUnavailable);
    // 失敗を握って空のカタログを返さない
    assert.throws(() => db.listAgents(), isServiceUnavailable);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transient failure clears on the next successful query", () => {
  const db = AppDb.open({ storeDir: null });
  assert.throws(() => db.saveAgent({ ...agent("broken"), name: null as unknown as string }), isServiceUnavailable);
  assert.equal(db.status().ok, false);

  assert.equal(db.probe(), true);
  assert.equal(db.status().ok, true);
  db.close();
});

test("a failing recreate leaves the previous state and makes the db unavailable", () => {
  const dir = tempStoreDir();
  try {
    AppDb.open({ storeDir: dir }).close();

    // DROP TABLE が失敗する状態を作る (agents を view に差し替える) + 版を上げる
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec("DROP TABLE agents; CREATE VIEW agents AS SELECT 1 AS id;");
    raw.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION + 1}`);
    raw.close();

    const db = AppDb.open({ storeDir: dir });
    assert.equal(db.status().ok, false);
    assert.throws(() => db.listAgents(), isServiceUnavailable);
    db.close();

    // rollback で view は残り、版も変わっていない (部分適用なし)
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    assert.equal(check.prepare("SELECT type FROM sqlite_master WHERE name = 'agents'").get()?.type, "view");
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), APP_DB_SCHEMA_VERSION + 1);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recreating the schema does not touch the conversation files", () => {
  const dir = tempStoreDir();
  try {
    AppDb.open({ storeDir: dir }).close();
    const sessionDir = join(dir, "a1b2c3d4e5");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "session.jsonl"), '{"type":"header"}\n');

    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION + 1}`);
    raw.close();

    const db = AppDb.open({ storeDir: dir });
    assert.deepEqual(db.listAgents(), []);
    db.close();
    // 会話は session.jsonl のままで、DB の作り直しに巻き込まれない
    assert.equal(readFileSync(join(sessionDir, "session.jsonl"), "utf8"), '{"type":"header"}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** v1 相当のスキーマ (notification_settings が無い状態) */
const V1_TABLES = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, systemPrompt TEXT NOT NULL,
  icon TEXT, model TEXT, thinkingLevel TEXT, skillIds TEXT NOT NULL, suggestions TEXT
);
`;

test("migrates a v1 db additively without touching agents, skills and projects", () => {
  const dir = tempStoreDir();
  try {
    // v1 の DB を直接作る (このリリースより前の実ファイルと同じ形)
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(V1_TABLES);
    raw.exec("PRAGMA user_version = 1");
    raw.prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)").run("p1", "p1", "proj-a", 1);
    raw.prepare("INSERT INTO skills (id, name, description, body) VALUES (?, ?, ?, ?)").run("s1", "s1", "", "body");
    raw
      .prepare("INSERT INTO agents (id, name, description, systemPrompt, skillIds) VALUES (?, ?, ?, ?, ?)")
      .run("a1", "a1", "", "", '["s1"]');
    raw.close();

    const db = AppDb.open({ storeDir: dir });
    // 加算的な移行で既存の定義は消えない
    assert.deepEqual(db.listProjects(), [project("p1", "proj-a")]);
    assert.deepEqual(db.listSkills(), [skill("s1")]);
    assert.deepEqual(db.listAgents(), [agent("a1", ["s1"])]);
    assert.equal(db.getNotificationSettings(), undefined);
    db.saveNotificationSettings({ enabled: true, mention: "here", webhookUrl: "https://discord.com/api/webhooks/1/t" });
    db.close();

    // 版が上がっている (開き直しても作り直されない)
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), APP_DB_SCHEMA_VERSION);
    check.close();

    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.listProjects(), [project("p1", "proj-a")]);
    assert.deepEqual(second.listSkills(), [skill("s1")]);
    assert.deepEqual(second.listAgents(), [agent("a1", ["s1"])]);
    assert.equal(second.getNotificationSettings()?.mention, "here");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notification settings round-trip through the sqlite row", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    assert.equal(first.getNotificationSettings(), undefined);
    const settings = {
      enabled: true,
      mention: "here" as const,
      webhookUrl: "https://discord.com/api/webhooks/1/t",
      baseUrl: "http://127.0.0.1:5173",
      lastResult: { ok: false, status: 404, latencyMs: 98, message: "Unknown Webhook", code: 10015, at: 1 },
    };
    first.saveNotificationSettings(settings);
    // 設定は 1 行を上書きする
    first.saveNotificationSettings({ ...settings, enabled: false, lastResult: undefined });
    first.close();

    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.getNotificationSettings(), {
      enabled: false,
      mention: "here",
      webhookUrl: "https://discord.com/api/webhooks/1/t",
      baseUrl: "http://127.0.0.1:5173",
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** v2 相当のスキーマ (archive_settings が無い状態)。v2 の実ファイルと同じ形 */
const V2_TABLES = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, systemPrompt TEXT NOT NULL,
  icon TEXT, model TEXT, thinkingLevel TEXT, skillIds TEXT NOT NULL, suggestions TEXT
);
CREATE TABLE notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, webhookUrl TEXT, baseUrl TEXT,
  mention TEXT NOT NULL, lastResult TEXT
);
`;

test("migrates a v2 db additively and keeps archive settings across reopen", () => {
  const dir = tempStoreDir();
  try {
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(V2_TABLES);
    raw.exec("PRAGMA user_version = 2");
    raw.prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)").run("p1", "p1", "proj-a", 1);
    raw.prepare("INSERT INTO notification_settings (id, enabled, mention) VALUES (1, 1, 'here')").run();
    raw.close();

    const first = AppDb.open({ storeDir: dir });
    // 加算移行なので既存 4 テーブルは消えない。行が無い = 未設定
    assert.deepEqual(first.listProjects(), [project("p1", "proj-a")]);
    assert.equal(first.getNotificationSettings()?.mention, "here");
    assert.equal(first.readArchiveExcludeNames(), undefined);
    first.saveArchiveExcludeNames(["node_modules", "dist"]);
    first.close();

    // 開き直しても残り、リセットで行ごと消える (既定名を保存し直さない)
    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.readArchiveExcludeNames(), ["node_modules", "dist"]);
    assert.equal(second.resetArchiveExcludeNames(), true);
    assert.equal(second.readArchiveExcludeNames(), undefined);
    // 行が無い状態のリセットは false (存在しない削除を成功と見せない)
    assert.equal(second.resetArchiveExcludeNames(), false);
    second.close();

    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), APP_DB_SCHEMA_VERSION);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive settings keep an explicit empty list and reject a broken JSON value", () => {
  const dir = tempStoreDir();
  try {
    const db = AppDb.open({ storeDir: dir });
    // 明示空 ([]) は未設定 (undefined) と別の状態として残る
    db.saveArchiveExcludeNames([]);
    assert.deepEqual(db.readArchiveExcludeNames(), []);
    db.close();

    // 壊れた JSON は黙って既定へ落とさず、他の列と同じく 503 にする
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.prepare("UPDATE archive_settings SET excludeNames = ?").run("not json");
    raw.close();
    const broken = AppDb.open({ storeDir: dir });
    assert.throws(() => broken.readArchiveExcludeNames(), isServiceUnavailable);
    // 配列でない JSON も同じ扱い
    broken.probe();
    const rawAgain = new DatabaseSync(join(dir, APP_DB_FILENAME));
    rawAgain.prepare("UPDATE archive_settings SET excludeNames = ?").run('{"a":1}');
    rawAgain.close();
    assert.throws(() => broken.readArchiveExcludeNames(), isServiceUnavailable);
    broken.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unavailable() keeps the reason for health", () => {
  const dir = tempStoreDir();
  try {
    const db = AppDb.unavailable({ storeDir: dir, error: "path is inside the workspace" });
    assert.deepEqual(db.status(), {
      path: join(dir, APP_DB_FILENAME),
      ok: false,
      error: "path is inside the workspace",
    });
    assert.throws(() => db.saveAgent(agent("a1")), isServiceUnavailable);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** v3 相当のスキーマ (provider_credentials が無い状態)。v3 の実ファイルと同じ形 */
const V3_TABLES = `
${V2_TABLES}
CREATE TABLE archive_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  excludeNames TEXT NOT NULL
);
`;

test("migrates a v3 db additively and keeps provider credentials across reopen", () => {
  const dir = tempStoreDir();
  try {
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(V3_TABLES);
    raw.exec("PRAGMA user_version = 3");
    raw.prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)").run("p1", "p1", "proj-a", 1);
    raw.prepare("INSERT INTO archive_settings (id, excludeNames) VALUES (1, ?)").run('["dist"]');
    raw.close();

    const first = AppDb.open({ storeDir: dir });
    // 加算移行なので既存テーブルは消えない。新しいテーブルは空で始まる
    assert.deepEqual(first.listProjects(), [project("p1", "proj-a")]);
    assert.deepEqual(first.readArchiveExcludeNames(), ["dist"]);
    assert.deepEqual(first.listProviderCredentials(), []);
    first.saveProviderCredential("anthropic", "sk-ant-1");
    // 同じ provider への保存は上書き (行を増やさない)
    first.saveProviderCredential("anthropic", "sk-ant-2");
    first.saveProviderCredential("openai", "sk-openai-1");
    first.close();

    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.listProviderCredentials(), [
      { provider: "anthropic", apiKey: "sk-ant-2" },
      { provider: "openai", apiKey: "sk-openai-1" },
    ]);
    assert.deepEqual(second.getProviderCredential("anthropic"), { provider: "anthropic", apiKey: "sk-ant-2" });
    assert.equal(second.getProviderCredential("ghost"), undefined);
    assert.equal(second.deleteProviderCredential("anthropic"), true);
    assert.equal(second.deleteProviderCredential("anthropic"), false, "無い行の削除は false");
    second.close();

    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), APP_DB_SCHEMA_VERSION);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitizeError masks both the query log and the error kept for health", () => {
  const dir = tempStoreDir();
  const key = "sk-ant-dummy-key-0123456789abcdef";
  try {
    const db = AppDb.open({ storeDir: dir, sanitizeError: (text) => text.split(key).join("[REDACTED]") });
    db.saveProviderCredential("anthropic", key);
    // SQLite の例外文言にキーが載る経路を作り、境界を通す (#query は成功でエラーを解除する)
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(
      `CREATE TRIGGER leak BEFORE UPDATE ON provider_credentials
       BEGIN SELECT RAISE(ABORT, 'boom ' || NEW.apiKey); END`,
    );
    raw.close();

    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      assert.throws(() => db.saveProviderCredential("anthropic", key), isServiceUnavailable);
    } finally {
      console.error = originalError;
    }
    const status = db.status();
    assert.equal(status.ok, false);
    assert.ok(status.error && !status.error.includes(key), `status.error をマスクする: ${status.error}`);
    assert.ok(status.error?.includes("[REDACTED]"));
    assert.ok(logged.length > 0 && !logged.join("\n").includes(key), "ログにも生のキーを出さない");
    assert.throws(
      () => db.saveProviderCredential("anthropic", key),
      (error: unknown) => !String((error as Error).message).includes(key),
      "503 の本文にもキーを出さない",
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open() failure messages pass through sanitizeError", () => {
  const dir = tempStoreDir();
  try {
    // ディレクトリの位置に通常ファイルを置き、DB を開けない失敗を作る
    mkdirSync(join(dir, "store"));
    const fileAsDir = join(dir, "store", "u7agent.db");
    writeFileSync(fileAsDir, "x");
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    let db: AppDb;
    try {
      db = AppDb.open({ storeDir: fileAsDir, sanitizeError: (text) => `masked: ${text}` });
    } finally {
      console.error = originalError;
    }
    assert.equal(db.status().ok, false);
    assert.ok(db.status().error?.startsWith("masked: "), `sanitizeError を通す: ${db.status().error}`);
    assert.ok(logged.length > 0 && logged[0]?.includes("masked: "), "起動時のログもマスクする");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
