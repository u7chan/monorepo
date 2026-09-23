// アプリデータの SQLite (server/src/app-db.ts) の単体テスト。実ファイルは一時ディレクトリに作る。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
