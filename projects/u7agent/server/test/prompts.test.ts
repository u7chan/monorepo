// 定型プロンプトのマスタとエージェント参照 (server/src/app-db.ts / prompts.ts) の永続化テスト。
// 新規 DB・移行・再起動を通し、外部キーとトランザクションの契約を実接続 (node:sqlite) で確かめる。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppDb, APP_DB_FILENAME, APP_DB_SCHEMA_VERSION } from "../src/app-db";
import { createAgentCatalog } from "../src/agents";
import { BUILTIN_AGENT_PROMPT_IDS, BUILTIN_PROMPTS } from "../src/builtin-catalog";
import { createPromptCatalog } from "../src/prompts";
import { AGENT_PROMPT_LIMIT } from "../src/schema";

function tempStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "u7agent-prompts-"));
}

function isServiceUnavailable(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 503;
}

/** 同じメモリ DB を共有するカタログ一式 (API と同じ組み方) */
function memoryCatalog() {
  const db = AppDb.open({ storeDir: null });
  const prompts = createPromptCatalog({ db });
  return { db, prompts, catalog: createAgentCatalog({ db, prompts }) };
}

test("a new db ships the built-in masters once and never duplicates them on reopen", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    assert.deepEqual(
      first.listPrompts().map((prompt) => [prompt.kind, prompt.id]),
      BUILTIN_PROMPTS.map((prompt) => ["builtin", prompt.id]),
    );
    first.close();

    // 再起動しても組み込み行は増えない (固定 ID への同期)
    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(
      second.listPrompts().map((prompt) => prompt.id),
      [...BUILTIN_AGENT_PROMPT_IDS],
    );
    second.close();

    // 古いビルドが作り直す経路 (#recreate) でも同じ
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec(`PRAGMA user_version = ${APP_DB_SCHEMA_VERSION + 1}`);
    raw.close();
    const recreated = AppDb.open({ storeDir: dir });
    assert.deepEqual(
      recreated.listPrompts().map((prompt) => prompt.id),
      [...BUILTIN_AGENT_PROMPT_IDS],
    );
    recreated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("built-in rows keep the bundled content and are never overwritten or removed through the catalog", () => {
  const dir = tempStoreDir();
  try {
    const [first] = BUILTIN_PROMPTS;
    // 組み込み ID の行が手で custom に変えられていても、起動時の同期は上書きしない (種別が違えば触らない)
    AppDb.open({ storeDir: dir }).close();
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw
      .prepare("UPDATE prompts SET kind = 'custom', label = ?, prompt = ? WHERE id = ?")
      .run("手元の行", "手元の本文", first.id);
    raw.close();

    const reopened = AppDb.open({ storeDir: dir });
    assert.deepEqual(reopened.getPrompt(first.id), {
      id: first.id,
      kind: "custom",
      label: "手元の行",
      prompt: "手元の本文",
    });
    reopened.close();

    const memory = AppDb.open({ storeDir: null });
    const catalog = createPromptCatalog({ db: memory });
    assert.throws(
      () => catalog.update(BUILTIN_PROMPTS[0].id, { label: "書き換え" }),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
    );
    assert.throws(
      () => catalog.remove(BUILTIN_PROMPTS[0].id),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
    );
    assert.deepEqual(
      catalog.list().map((prompt) => prompt.prompt),
      BUILTIN_PROMPTS.map((prompt) => prompt.prompt),
    );
    memory.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt references keep their order across reopen and never merge same-content masters", () => {
  const dir = tempStoreDir();
  try {
    const first = AppDb.open({ storeDir: dir });
    const prompts = createPromptCatalog({ db: first });
    const a = prompts.create({ label: "同じ", prompt: "同じ本文" });
    const b = prompts.create({ label: "同じ", prompt: "同じ本文" });
    const c = prompts.create({ label: "別", prompt: "別の本文" });
    first.saveAgent({
      id: "agent-order",
      name: "並び",
      description: "",
      systemPrompt: "",
      promptIds: [c.id, a.id, b.id],
    });
    first.close();

    const second = AppDb.open({ storeDir: dir });
    assert.deepEqual(second.getAgent("agent-order")?.promptIds, [c.id, a.id, b.id]);
    assert.equal(new Set(second.listPrompts().map((prompt) => prompt.id)).size, 3 + BUILTIN_PROMPTS.length);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting an agent cascades only its references and keeps masters and other agents", () => {
  const { db, prompts, catalog } = memoryCatalog();
  const shared = prompts.create({ label: "共有", prompt: "共有の本文" });
  const keep = catalog.createAgent({ name: "残す", promptIds: [shared.id] });
  const drop = catalog.createAgent({ name: "消す", promptIds: [shared.id] });

  assert.equal(catalog.removeAgent(drop.id), true);
  assert.equal(db.listAgentPromptLinks().filter((link) => link.agentId === drop.id).length, 0);
  assert.deepEqual(prompts.get(shared.id)?.usedBy, [{ agentId: keep.id, agentName: "残す", builtin: false }]);
  assert.deepEqual(
    catalog.getAgent(keep.id)?.prompts?.map((prompt) => prompt.id),
    [shared.id],
  );
  db.close();
});

test("the database enforces the reference constraints (foreign keys, positions, duplicates, restrict)", () => {
  const { db, prompts } = memoryCatalog();
  const prompt = prompts.create({ label: "L", prompt: "P" });

  // 存在しないマスタへの参照は外部キーで拒否され、エージェント行も残らない (1 トランザクション)
  assert.throws(() =>
    db.saveAgent({ id: "agent-x", name: "x", description: "", systemPrompt: "", promptIds: ["prompt-missing"] }),
  );
  assert.equal(db.getAgent("agent-x"), undefined, "失敗した保存はエージェント行も残さない");

  // 位置の範囲外・重複は保存できない (途中失敗で参照が部分適用されない)
  assert.throws(() =>
    db.saveAgent({
      id: "agent-dup",
      name: "x",
      description: "",
      systemPrompt: "",
      promptIds: [prompt.id, prompt.id],
    }),
  );
  db.saveAgent({ id: "agent-x", name: "x", description: "", systemPrompt: "", promptIds: [prompt.id] });
  const tooMany = Array.from({ length: AGENT_PROMPT_LIMIT + 1 }, (_, index) =>
    prompts.create({ label: `L${index}`, prompt: `P${index}` }),
  );
  assert.throws(() =>
    db.saveAgent({
      id: "agent-x",
      name: "x",
      description: "",
      systemPrompt: "",
      promptIds: tooMany.map((entry) => entry.id),
    }),
  );
  assert.deepEqual(db.getAgent("agent-x")?.promptIds, [prompt.id], "失敗した保存は以前の並びを保つ");

  // 使用中のマスタは ON DELETE RESTRICT で消えない (サービス側の 409 の裏付け)
  assert.throws(() => db.deletePrompt(prompt.id));
  assert.equal(db.getPrompt(prompt.id)?.id, prompt.id);
  db.close();
});

test("a migration turns existing suggestions into separate custom masters in their order", () => {
  const dir = tempStoreDir();
  try {
    AppDb.open({ storeDir: dir }).close();
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec("DROP TABLE agent_prompts");
    raw.exec("DROP TABLE prompts");
    raw.exec("ALTER TABLE agents ADD COLUMN suggestions TEXT");
    const insert = raw.prepare(
      "INSERT INTO agents (id, name, description, systemPrompt, sortOrder, suggestions) VALUES (?, ?, '', '', ?, ?)",
    );
    // 同じ本文でも別エージェントの項目同士・組み込みとは統合しない
    insert.run(
      "agent-a",
      "A",
      1,
      JSON.stringify([
        { label: "同じ", prompt: "同じ本文" },
        { label: "二番目", prompt: "二番目の本文" },
      ]),
    );
    insert.run("agent-b", "B", 2, JSON.stringify([{ label: "同じ", prompt: "同じ本文" }]));
    insert.run("agent-empty", "空", 3, "[]");
    insert.run("agent-null", "未設定", 4, null);
    raw.exec("PRAGMA user_version = 33");
    raw.close();

    const db = AppDb.open({ storeDir: dir });
    assert.equal(db.status().ok, true);
    const custom = db.listPrompts().filter((prompt) => prompt.kind === "custom");
    assert.equal(custom.length, 3, "同文の既存項目もエージェントごとに別マスタになる");
    assert.deepEqual(
      db.getAgent("agent-a")?.promptIds,
      custom.slice(0, 2).map((prompt) => prompt.id),
    );
    assert.deepEqual(db.getAgent("agent-b")?.promptIds, [custom[2].id]);
    assert.equal(db.getAgent("agent-empty")?.promptIds, undefined);
    assert.equal(db.getAgent("agent-null")?.promptIds, undefined);
    // 内容と順序を保持する
    assert.deepEqual(
      db.getAgent("agent-a")?.promptIds?.map((id) => db.getPrompt(id)),
      [
        { ...custom[0], label: "同じ", prompt: "同じ本文" },
        { ...custom[1], label: "二番目", prompt: "二番目の本文" },
      ],
    );
    assert.deepEqual(
      custom.map((prompt) => prompt.label),
      ["同じ", "二番目", "同じ"],
    );
    db.close();

    // 旧列は落ち、版は上がり、組み込みも重複しない
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const columns = (check.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.equal(columns.includes("suggestions"), false);
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), APP_DB_SCHEMA_VERSION);
    check.close();

    // 開き直してもマスタと紐づけが重複しない
    const reopened = AppDb.open({ storeDir: dir });
    assert.equal(reopened.listPrompts().filter((prompt) => prompt.kind === "custom").length, 3);
    assert.equal(reopened.getAgent("agent-a")?.promptIds?.length, 2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken suggestions value fails the migration, keeps the old state and retries after the fix", () => {
  const dir = tempStoreDir();
  try {
    AppDb.open({ storeDir: dir }).close();
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec("DROP TABLE agent_prompts");
    raw.exec("DROP TABLE prompts");
    raw.exec("ALTER TABLE agents ADD COLUMN suggestions TEXT");
    raw
      .prepare(
        "INSERT INTO agents (id, name, description, systemPrompt, sortOrder, suggestions) VALUES (?, ?, '', '', ?, ?)",
      )
      .run("agent-a", "A", 1, "{not json");
    raw.exec("PRAGMA user_version = 33");
    raw.close();

    // 黙って捨てて移行成功にしない (DB 障害として 503 相当になる)
    const broken = AppDb.open({ storeDir: dir });
    assert.equal(broken.status().ok, false);
    assert.throws(() => broken.listPrompts(), isServiceUnavailable);
    broken.close();

    // 旧列・データ・版は残っているので、直して開き直せば移行が再試行できる
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const columns = (check.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.equal(columns.includes("suggestions"), true);
    assert.equal(Number(check.prepare("PRAGMA user_version").get()?.user_version), 33);
    check
      .prepare("UPDATE agents SET suggestions = ? WHERE id = 'agent-a'")
      .run(JSON.stringify([{ label: "直した", prompt: "直した本文" }]));
    check.close();

    const migrated = AppDb.open({ storeDir: dir });
    assert.equal(migrated.status().ok, true);
    assert.deepEqual(
      migrated.getAgent("agent-a")?.promptIds?.map((id) => migrated.getPrompt(id)?.label),
      ["直した"],
    );
    assert.equal(migrated.listPrompts().filter((prompt) => prompt.kind === "custom").length, 1);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a too-long or empty stored suggestion fails the migration instead of being trimmed away", () => {
  const dir = tempStoreDir();
  try {
    AppDb.open({ storeDir: dir }).close();
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.exec("DROP TABLE agent_prompts");
    raw.exec("DROP TABLE prompts");
    raw.exec("ALTER TABLE agents ADD COLUMN suggestions TEXT");
    raw
      .prepare(
        "INSERT INTO agents (id, name, description, systemPrompt, sortOrder, suggestions) VALUES (?, ?, '', '', ?, ?)",
      )
      .run("agent-a", "A", 1, JSON.stringify([{ label: " ", prompt: "本文" }]));
    raw.exec("PRAGMA user_version = 33");
    raw.close();

    const broken = AppDb.open({ storeDir: dir });
    assert.equal(broken.status().ok, false);
    broken.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the prompt catalog rejects unknown, duplicate and over-limit references without saving", () => {
  const { db, prompts, catalog } = memoryCatalog();
  const known = prompts.create({ label: "既知", prompt: "既知の本文" });
  assert.deepEqual(prompts.resolve([known.id]), [
    { id: known.id, kind: "custom", label: "既知", prompt: "既知の本文" },
  ]);
  assert.throws(
    () => prompts.resolve(["prompt-missing"]),
    (error: Error & { statusCode?: number }) => error.statusCode === 400,
  );

  const agent = catalog.createAgent({ name: "検証", promptIds: [known.id] });
  const ids = Array.from({ length: AGENT_PROMPT_LIMIT }, (_, index) =>
    prompts.create({ label: `L${index}`, prompt: `P${index}` }),
  ).map((prompt) => prompt.id);
  for (const promptIds of [["prompt-missing"], [known.id, known.id], [...ids, known.id]]) {
    assert.throws(
      () => catalog.updateAgent(agent.id, { promptIds }),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
      JSON.stringify(promptIds),
    );
    assert.deepEqual(
      catalog.getAgent(agent.id)?.prompts?.map((prompt) => prompt.id),
      [known.id],
    );
  }
  // 拒否しても消えない
  assert.equal(db.getPrompt(known.id)?.id, known.id);
  db.close();
});
