// 会話ストアの永続化と復元。SessionStore とスタブ pi / スタブサンドボックスを組み合わせて検証する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { ProjectStore } from "../src/projects";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import {
  parseSessionFile,
  serializeSession,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionMetaPath,
} from "../src/session-store";
import type { EventEntry, SessionPayload } from "../src/schema";
import { createStubPi, STUB_MODEL, STUB_PLAIN_MODEL, waitFor, type StubSession } from "./stub-pi";

function stubWorkspace(): { workspace: SandboxWorkspaceClient; dirs: string[]; listings: string[] } {
  const dirs: string[] = [];
  const listings: string[] = [];
  return {
    dirs,
    listings,
    workspace: {
      previewFile: async () => ({ text: "" }),
      listFiles: async (path: string) => {
        listings.push(path);
        return { path: path || ".", entries: [], truncated: false };
      },
      // ファイルスキルの発見はこのテストでは扱わない
      listSkills: async () => ({ skills: [] }),
      createDir: async (path: string) => {
        dirs.push(path);
        return { path };
      },
      // 削除 / リネーム / アップロード / 生配信はこのテストでは扱わない
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
      // ダウンロードはこのテストでは扱わない
      downloadEntry: async () => ({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
        body: null,
      }),
      checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
    },
  };
}

function createStore(
  storeDir: string,
  options: {
    pi?: ReturnType<typeof createStubPi> | null;
    workspace: SandboxWorkspaceClient;
    catalog?: ReturnType<typeof createAgentCatalog>;
    projects?: ProjectStore;
  },
): SessionStore {
  return new SessionStore({
    pi: (options.pi ?? null) as never,
    catalog: options.catalog ?? createAgentCatalog(),
    projects: options.projects ?? null,
    storeDir,
    workspace: options.workspace,
    rootCwd: "/tmp/project",
  });
}

async function readMeta(id: string, storeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionMetaPath(id, storeDir), "utf8")) as Record<string, unknown>;
}

/**
 * スキル読み込み (read + SKILL.md) を、本文を持たない assistant ターンとして JSONL へ足す。
 * 復元後に導出行が繰り上げ先 (同ターン内の次の表示メッセージ) へ出ることを固定するための入力。
 */
async function appendSkillReadTurn(id: string, storeDir: string): Promise<void> {
  const file = sessionJsonlPath(id, storeDir);
  const parsed = parseSessionFile(await readFile(file, "utf8"), id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const at = new Date().toISOString();
  const turn = [
    {
      type: "message",
      id: "entry-skill-user",
      parentId: parsed.entries.at(-1)?.id ?? null,
      timestamp: at,
      message: { role: "user", content: "スキルを読んで", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "entry-skill-call",
      parentId: "entry-skill-user",
      timestamp: at,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-skill",
            name: "read",
            arguments: { path: ".agents/skills/gh/SKILL.md", offset: 3, limit: 4 },
          },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-skill-result",
      parentId: "entry-skill-call",
      timestamp: at,
      message: {
        role: "toolResult",
        toolCallId: "call-skill",
        toolName: "read",
        content: [{ type: "text", text: "スキル本文" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-skill-answer",
      parentId: "entry-skill-result",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "読みました" }], timestamp: Date.now() },
    },
  ];
  await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));
}

/**
 * 本文を持たない (ツール呼び出しだけの) assistant ターンを JSONL へ足す。
 * 履歴には残るが表示メッセージには数えないため、messageCount が 2 つの定義でずれる入力になる。
 */
async function appendToolOnlyTurn(id: string, storeDir: string): Promise<void> {
  const file = sessionJsonlPath(id, storeDir);
  const parsed = parseSessionFile(await readFile(file, "utf8"), id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const at = new Date().toISOString();
  const turn = [
    {
      type: "message",
      id: "entry-tool-user",
      parentId: parsed.entries.at(-1)?.id ?? null,
      timestamp: at,
      message: { role: "user", content: "ファイルを読んで", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "entry-tool-call",
      parentId: "entry-tool-user",
      timestamp: at,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "entry-tool-answer",
      parentId: "entry-tool-call",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "読んだ結果です" }], timestamp: Date.now() },
    },
  ];
  await writeFile(file, serializeSession(parsed.header, [...parsed.entries, ...turn]));
}

test("永続化したセッションを新しい store が復元し、続きから送信できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-restore-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create();
    assert.match(record.id, /^[0-9a-f]{10}$/);
    assert.equal(record.workdir, `.u7agent/sessions/${record.id}`, "作業フォルダを cwd にする");
    assert.deepEqual(dirs, [record.workdir], "作業フォルダはサンドボックスに作らせる");

    store1.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);

    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(text, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("unreachable");
    assert.equal(parsed.entries.length, 2, "user と assistant が保存される");
    const meta = await readMeta(record.id, storeDir);
    assert.equal(meta.title, "こんにちは");
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.workdir, undefined, "作業フォルダは id から導出する (meta には保存しない)");
    await store1.close();

    // 2 つ目の store はストアを走査して descriptor を作り、開いたときに SDK を復元する
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const list = store2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, record.id);
    assert.equal(list[0].title, "こんにちは");
    assert.equal(list[0].status, "idle");
    assert.equal(list[0].messageCount, 2);

    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const payload = store2.payload(restored);
    assert.equal(payload.cwd, record.workdir);
    assert.equal(payload.eventGeneration.length > 0, true);
    assert.deepEqual(
      payload.messages.map((message) => message.text),
      ["こんにちは", "スタブの返答です"],
      "履歴が復元される",
    );
    const input = pi2.createInputs.at(-1);
    assert.equal(input?.sessionId, record.id, "SDK へアプリの id を渡す");
    assert.equal(input?.cwd, record.workdir);
    assert.equal(input?.entries?.length, 2, "JSONL の entry を SDK へ渡す");
    assert.match(input?.promptSnapshot?.agent ?? "", /<agent_profile/);

    store2.postMessage(restored, "続き");
    await waitFor(() => restored.run?.status === "completed", 3000, "resumed run");
    await store2.flush(restored);
    const resumed = parseSessionFile(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), record.id);
    assert.equal(resumed.kind, "ok");
    if (resumed.kind === "ok") {
      // 復元時に実効モデルの model_change が 1 件追記され、その後に user + assistant が続く
      assert.equal(resumed.entries.length, 5, "追記が連結しない");
      assert.equal(resumed.entries.at(-1)?.type, "message");
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("カタログスキルの本文と説明は作成時に固定され、定義を消しても復元後に残る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-restore-catalog-"));
  const { workspace } = stubWorkspace();
  try {
    const catalog = createAgentCatalog();
    const skill = catalog.createSkill({ name: "writer", description: "文章を書く", body: "作成時の本文" });
    const agent = catalog.createAgent({ name: "書き手", skillIds: [skill.id] });

    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    const record = await store1.create({ agentId: agent.id });
    const created = pi1.createInputs.at(-1);
    // 本文はスナップショットへ固定し、索引 (read / 一覧) の説明はエージェントスナップショットから渡す
    assert.deepEqual(created?.promptSnapshot?.skills, ['<agent_skill name="writer">\n作成時の本文\n</agent_skill>']);
    assert.deepEqual(
      created?.agentSkills?.map((item) => [item.name, item.description]),
      [["writer", "文章を書く"]],
    );
    await store1.flush(record);
    await store1.close();

    // 定義を削除しても、復元は meta のスナップショットから同じ本文 / 説明を渡す (遡及させない)
    catalog.removeSkill(skill.id);
    catalog.removeAgent(agent.id);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    await store2.resolve(record.id);
    const restored = pi2.createInputs.at(-1);
    assert.deepEqual(restored?.promptSnapshot?.skills, ['<agent_skill name="writer">\n作成時の本文\n</agent_skill>']);
    assert.deepEqual(
      restored?.agentSkills?.map((item) => [item.name, item.description]),
      [["writer", "文章を書く"]],
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("ツール呼び出しだけのターンを含んでも meta / 一覧 / 復元後の messageCount が一致する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-count-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    // 保存済みの履歴へ、本文を持たない (ツール呼び出しだけの) assistant ターンを足す
    await appendToolOnlyTurn(created.id, storeDir);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const record = await store2.resolve(created.id);
    assert.ok(record);
    const events: EventEntry[] = [];
    store2.subscribe(record, `${record.generation}:0`, (entry) => events.push(entry));
    store2.postMessage(record, "続き");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store2.flush(record);

    // 表示メッセージは「ファイルを読んで」「読んだ結果です」「続き」「スタブの返答です」の 4 件
    const live = store2.summary(record).messageCount;
    assert.equal(live, 4, "live summary は表示メッセージ数");
    assert.equal(record.session.messages.length, live + 1, "ツール呼び出しのターンは履歴には残る");
    assert.equal((await readMeta(created.id, storeDir)).messageCount, live, "meta も同じ定義");
    assert.equal(store2.payload(record).messages.length, live, "本文と件数が同じ集合");
    const runEnd = events.find((entry) => entry.type === "run_end");
    assert.ok(runEnd);
    assert.equal(runEnd.data.messageCount, live, "run_end も一覧 / meta と同じ定義");
    await store2.close();

    const store3 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store3.init();
    assert.equal(store3.list()[0]?.messageCount, live, "未ロードの一覧も meta の同じ値");
    const restored = await store3.resolve(created.id);
    assert.ok(restored);
    assert.equal(store3.summary(restored).messageCount, live, "復元後の summary も同じ値");
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("store 経由で復元してもスキル読み込みが同じ位置に出る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-skill-load-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    await appendSkillReadTurn(created.id, storeDir);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const record = await store2.resolve(created.id);
    assert.ok(record);
    const payload = store2.payload(record);

    assert.deepEqual(
      payload.messages.map((message) => [message.role, message.text]),
      [
        ["user", "スキルを読んで"],
        ["assistant", "読みました"],
      ],
      "本文を持たない read ターンはバブルにしない",
    );
    assert.deepEqual(payload.messages[1].skillLoads, [
      {
        id: "call-skill",
        name: "gh",
        path: `/tmp/project/${record.workdir}/.agents/skills/gh/SKILL.md`,
        offset: 3,
        limit: 4,
      },
    ]);
    assert.equal(store2.summary(record).messageCount, payload.messages.length, "復元後も表示メッセージ数は同じ");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("古い定義で保存された meta の messageCount は、セッションを開いたときに書き戻す", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-backfill-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    // 実効モデルと一致する model_change を先に保存しておく。これが無いと復元時に
    // recordEffectiveModel が追記側で true を返し、messageCount の補正条件を検証できない
    await store1.updateSettings(created, { model: STUB_MODEL });
    store1.postMessage(created, "最初の質問");
    await waitFor(() => created.run?.status === "completed", 3000, "run completed");
    await store1.flush(created);
    await store1.close();

    await appendToolOnlyTurn(created.id, storeDir);
    // 表示は 4 件に対して生の履歴は 5 件。古い定義で書かれた meta を再現する
    const staleCount = 5;
    await writeFile(
      sessionMetaPath(created.id, storeDir),
      `${JSON.stringify({ ...(await readMeta(created.id, storeDir)), messageCount: staleCount }, null, 2)}\n`,
    );

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    assert.equal(store2.list()[0]?.messageCount, staleCount, "走査は meta の保存値を使う");

    const file = sessionJsonlPath(created.id, storeDir);
    const before = await stat(file);
    const record = await store2.resolve(created.id);
    assert.ok(record);
    await store2.flush(record);
    assert.equal((await readMeta(created.id, storeDir)).messageCount, 4, "開いたときに書き戻す");
    assert.equal((await stat(file)).ino, before.ino, "履歴を書き直さず meta だけを補正する");
    await store2.close();

    const store3 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store3.init();
    assert.equal(store3.list()[0]?.messageCount, 4, "再起動後の一覧も書き戻した値");
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("初回応答の完了前にユーザーメッセージが保存される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-early-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi({ chunkDelayMs: 300 }), workspace });
    await store.init();
    const record = await store.create();
    store.postMessage(record, "先に保存される");

    let persisted = false;
    for (let attempt = 0; attempt < 200 && !persisted; attempt += 1) {
      const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8").catch(() => "");
      persisted = text.includes('"role":"user"');
      if (!persisted) await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
    assert.equal(persisted, true, "assistant の完了を待たずに user entry が書かれる");
    assert.equal(record.run?.status, "running", "ランの完了前に保存されている");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未ロードのセッションを SDK なしで削除でき、作業フォルダは残る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-delete-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // pi なしでも削除できる (モデル未認証・破損と無関係)
    const store2 = createStore(storeDir, { pi: null, workspace, catalog });
    await store2.init();
    assert.equal(store2.list().length, 1);
    assert.equal(await store2.deleteSession(record.id), true);
    assert.equal(store2.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    assert.equal(await store2.deleteSession(record.id), false);
    // 作業フォルダは BFF からは作っただけで、削除では触らない
    assert.deepEqual(dirs, [record.workdir]);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

// SDK 0.87 はリトライ / overflow recovery で context_edit、cache warming で usage を追記する。
// 未知 type を破損扱いにしていたため、これらの entry を含む履歴が再起動後に 409 で開けなくなっていた
test("リトライや cache warming が追記した entry を含む履歴も復元できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-context-edit-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const timestamp = new Date().toISOString();
    const text = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "context_edit",
        id: "entry-2",
        parentId: "entry-1",
        timestamp,
        targetId: "entry-1",
        replacement: null,
      },
      {
        type: "usage",
        id: "entry-3",
        parentId: "entry-2",
        timestamp,
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-6-luna",
        usage: { input: 1, output: 0, cacheRead: 9, cacheWrite: 0 },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), text);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored, "409 にならずに復元できる");
    const entries = (restored.session as StubSession).entries;
    const ids = entries.map((entry) => entry.id);
    for (const id of ["entry-1", "entry-2", "entry-3"]) {
      assert.ok(ids.includes(id), `${id} が SDK へ渡る`);
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

// SDK 0.87 は tool 構成や system prompt の section 差分を role: "system" の message として追記する。
// role を未知として扱っていたため、それを含む履歴が再起動後に 409 で開けなくなっていた
test("system prompt の差分を追記した履歴も復元できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-system-message-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const timestamp = new Date().toISOString();
    const text = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        timestamp,
        // SDK が書く形: 本文は空で、差分は sections に入る
        message: { role: "system", content: "", sections: { skills: "<skills>…</skills>" }, timestamp: 2 },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), text);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored, "409 にならずに復元できる");
    const ids = (restored.session as StubSession).entries.map((entry) => entry.id);
    for (const id of ["entry-1", "entry-2"]) {
      assert.ok(ids.includes(id), `${id} が SDK へ渡る`);
    }
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("壊れた JSONL は原本を書き換えずに開く要求が失敗し、削除はできる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-damaged-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const broken = '{"broken"\n';
    await writeFile(sessionJsonlPath(record.id, storeDir), broken);
    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      return true;
    });
    // 原本はそのまま (読み込みで書き換えない)
    assert.equal(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), broken);
    assert.equal(await store2.deleteSession(record.id), true);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("content part が壊れた履歴は 409 で拒否し、原本を書き換えない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-damaged-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const broken = serializeSession(sessionHeaderOf({ id: record.id, createdAt: Date.now() }, record.workdir), [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text" }], timestamp: Date.now() },
      },
    ]);
    await writeFile(sessionJsonlPath(record.id, storeDir), broken);

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /session.jsonl/);
      return true;
    });
    assert.equal(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), broken, "原本は変わらない");
    assert.equal(await store2.deleteSession(record.id), true);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("PI_MODELS の候補外モデルでは再開せず、フォールバック後の実効モデルを保存する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-model-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create({ model: { provider: "stub", id: "stub-model" } });
    store1.postMessage(record, "モデルを記録する");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store1.flush(record);
    assert.equal((await readMeta(record.id, storeDir)).model, "stub/stub-model");
    await store1.close();

    // 復元側の候補は stub-plain だけ。保存値は選ばれず、実効値が JSONL に追記される
    const pi2 = createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(pi2.createInputs.at(-1)?.model, undefined, "候補外の保存値は渡さない (アプリ既定へ任せる)");
    await store2.flush(restored);
    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(text, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") {
      const last = [...parsed.entries].reverse().find((entry) => entry.type === "model_change");
      assert.equal(last?.provider, "stub", "フォールバック後の実効モデルを記録する");
      assert.equal(last?.modelId, "stub-plain");
    }
    await store2.close();

    // 3 つ目の store は両方使えても、最後に記録された stub-plain で再開する
    const pi3 = createStubPi();
    const store3 = createStore(storeDir, { pi: pi3, workspace, catalog });
    await store3.init();
    const again = await store3.resolve(record.id);
    assert.ok(again);
    assert.deepEqual(pi3.createInputs.at(-1)?.model, { provider: "stub", id: "stub-plain" });
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("復元後の SSE は世代が違うカーソルを resync へ寄せる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sse-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);

    // 古い世代のカーソル (再起動前のタブ) は resync
    const stale: EventEntry[] = [];
    store2.subscribe(restored, "deadbeef:3", (entry) => stale.push(entry));
    const first = stale[0];
    assert.ok(first);
    assert.equal(first.type, "resync");
    assert.equal((first.data as SessionPayload).sessionId, record.id);

    // 現在の世代で最新まで読んでいるタブには何も送らない
    const current: EventEntry[] = [];
    store2.subscribe(restored, `${restored.generation}:${restored.seq}`, (entry) => current.push(entry));
    assert.deepEqual(current, []);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("compaction を保存し、復元後も区切りが再現される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-compaction-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, {
      // 1 通目の後で圧縮する (空の履歴は実 SDK でも圧縮しない)
      pi: createStubPi({ preflightCompactions: [null, { summary: "これまでの要約", summarizeCount: 1 }] }),
      workspace,
      catalog,
    });
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "圧縮される会話");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    store1.postMessage(record, "圧縮後の会話");
    await waitFor(() => store1.statusOf(record) === "completed", 3000, "second run completed");
    await store1.flush(record);
    assert.equal(store1.payload(record).compactions.length, 1);

    const parsed = parseSessionFile(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind === "ok") assert.ok(parsed.entries.some((entry) => entry.type === "compaction"));
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    const payload = store2.payload(restored);
    assert.equal(payload.compactions.length, 1, "compaction entry を復元する");
    assert.equal(payload.compactions[0].summary, "これまでの要約");
    assert.equal(payload.compactions[0].tokensBefore, 68_000);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("復元時のモデル能力に合わせて Effort を clamp する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-effort-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // 推論レベル max を要求した履歴を作る
    const file = sessionJsonlPath(record.id, storeDir);
    const parsed = parseSessionFile(await readFile(file, "utf8"), record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") return;
    const last = parsed.entries[parsed.entries.length - 1];
    const thinking = {
      type: "thinking_level_change",
      id: "entry-thinking",
      parentId: (last?.id as string) ?? null,
      timestamp: new Date().toISOString(),
      thinkingLevel: "max",
    };
    await writeFile(file, serializeSession(parsed.header, [...parsed.entries, thinking]));

    // 非推論モデルで復元すると off へ補正される
    const pi2 = createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).thinkingLevel, "off");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("ロードと DELETE が競合しても store を復活させない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-race-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const results = await Promise.allSettled([store2.resolve(record.id), store2.deleteSession(record.id)]);
    assert.equal(results[1].status, "fulfilled");
    assert.equal(store2.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    assert.equal(store2.status().dirty, 0);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("保存中に DELETE しても store を復活させない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-race-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    const write = store.persist(record);
    const removed = store.deleteSession(record.id);
    await Promise.allSettled([write, removed]);
    assert.equal(await removed, true);
    assert.equal(store.list().length, 0);
    await assert.rejects(readFile(sessionMetaPath(record.id, storeDir), "utf8"));
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("sweep 中の同時 resolve は同じ record を共有する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const created = await store1.create();
    await store1.flush(created);
    await store1.close();

    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store2.init();
    const live = await store2.resolve(created.id);
    assert.ok(live);
    live.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;

    const sweeping = store2.sweep();
    const first = store2.resolve(created.id);
    const second = store2.resolve(created.id);
    await sweeping;
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a);
    assert.equal(a, b, "同じ record を共有する");
    assert.notEqual(a, live, "eviction 後は再ロードする");
    assert.equal(store2.status().dirty, 0);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクト解除は待機メッセージを破棄して実行しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-release-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const store = createStore(storeDir, {
      pi: createStubPi({ chunkDelayMs: 40 }),
      workspace,
      catalog,
      projects,
    });
    await store.init();
    const project = projects.create({ cwd: "proj-a" });
    const record = await store.create({ projectId: project.id });
    const stub = record.session as StubSession;
    store.postMessage(record, "実行中");
    await waitFor(() => record.run?.status === "running", 2000, "running");
    store.postMessage(record, "待機中");
    assert.equal(record.queue.length, 1);

    projects.remove(project.id);
    await store.releaseProject(project.cwd);
    assert.equal(record.queue.length, 0, "待機メッセージを破棄する");
    await waitFor(() => record.run?.status !== "running", 3000, "run settled");
    await new Promise((resolveTick) => setTimeout(resolveTick, 300));

    const userTexts = stub.messages.filter((message) => message.role === "user").map((message) => message.content);
    assert.deepEqual(userTexts, ["実行中"], "解除後に待機メッセージを実行しない");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("保存に成功すると persistError が消える", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-persist-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();

    // meta.json をディレクトリへ置き換えて rename を失敗させる
    const metaPath = sessionMetaPath(record.id, storeDir);
    await rm(metaPath, { force: true });
    await mkdir(metaPath, { recursive: true });
    await store.persist(record);
    assert.ok(record.persistError, "今回の失敗を記録する");
    assert.equal(store.status().dirty, 1);

    await rm(metaPath, { recursive: true, force: true });
    await store.persist(record);
    assert.equal(record.persistError, undefined, "成功で失敗を消す");
    assert.equal(store.status().dirty, 0);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("設定変更中のセッションは sweep の対象外にする", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    await store.flush(record);
    record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
    record.changingSettings = true;
    await store.sweep();
    assert.equal(store.get(record.id), record, "設定変更中は残す");
    record.changingSettings = false;
    await store.sweep();
    assert.equal(store.get(record.id), undefined);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクトを解除してもセッションと store は残り、未所属として解決される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const store = createStore(storeDir, { pi: createStubPi(), workspace, catalog, projects });
    await store.init();
    const project = projects.create({ cwd: "proj-a" });
    const record = await store.create({ projectId: project.id });
    await store.flush(record);
    assert.equal(store.payload(record).projectId, project.id);

    projects.remove(project.id);
    await store.releaseProject(project.cwd);
    assert.equal(store.get(record.id), record, "セッションは live のまま残る");
    assert.equal(store.payload(record).projectId, undefined, "未所属として解決される");
    assert.equal((await readMeta(record.id, storeDir)).projectCwd, "proj-a", "所属の保存値は残す");
    // 同じ cwd を再登録すると、再起動をまたぐ場合と同じく所属が戻る
    const again = projects.create({ cwd: "proj-a" });
    assert.equal(store.payload(record).projectId, again.id);

    // 再起動後（新しい store）も保存値から所属を復元し、未登録なら未所属として解決する
    await store.flush(record);
    await store.close();
    const projects2 = new ProjectStore();
    const store2 = createStore(storeDir, { pi: createStubPi(), workspace, catalog, projects: projects2 });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).projectId, undefined, "未登録なら未所属");
    assert.equal(restored.workdir, "proj-a", "登録が無くても projectCwd をそのまま cwd に使う");
    projects2.create({ cwd: "proj-a" });
    assert.ok(store2.payload(restored).projectId, "再登録で所属が戻る");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("store がワークスペース内ならセッション作成を拒否する", async () => {
  const { workspace } = stubWorkspace();
  const store = new SessionStore({
    pi: createStubPi() as never,
    catalog: createAgentCatalog(),
    storeDir: null,
    storeError: "PI_SESSION_STORE はワークスペースの外を指定してください",
    workspace,
    rootCwd: "/tmp/project",
  });
  await assert.rejects(store.create(), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 503);
    return true;
  });
  await store.close();
});

test("モデルの候補が無いときの復元は 503 になり、一覧からは消えない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-nomodel-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // selectedModel も availableModels も無い = アプリ既定が無い状態を再現する
    const pi2 = createStubPi({ availableModels: [], selectedModel: null });
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    assert.equal(store2.list().length, 1, "一覧には meta から出る");
    await assert.rejects(store2.resolve(record.id), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 503);
      return true;
    });
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("sweep は購読者がいるセッションを破棄しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-sweep-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
    const unsubscribe = store.subscribe(record, undefined, () => {});
    await store.sweep();
    assert.equal(store.get(record.id), record, "購読中は残す");

    unsubscribe();
    await store.sweep();
    assert.equal(store.get(record.id), undefined, "購読解除後はメモリから外れる");
    // メモリから外れても store は残る
    assert.equal(store.list().length, 1);
    const restored = await store.resolve(record.id);
    assert.ok(restored);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("persist は file の失敗を error に残し、次の保存で再試行できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-retry-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    await store.flush(record);
    assert.equal(record.writer?.error, undefined);
    assert.equal((await readFile(sessionJsonlPath(record.id, storeDir), "utf8")).length > 0, true);
    assert.ok(STUB_MODEL.id);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("プロジェクト所属セッションは登録ディレクトリを cwd にし、作成も復元も mkdir しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-cwd-"));
  const { workspace, dirs, listings } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const project = projects.create({ cwd: "repos/app" });
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog, projects });
    await store1.init();
    const record = await store1.create({ projectId: project.id });
    assert.equal(record.workdir, "repos/app", "cwd は登録ディレクトリそのもの");
    assert.equal(pi1.createInputs.at(-1)?.cwd, "repos/app", "SDK セッションへも同じ cwd を渡す");
    assert.deepEqual(listings, ["repos/app"], "存在確認だけを行う");
    assert.deepEqual(dirs, [], "プロジェクトのディレクトリは作らない");
    await store1.flush(record);

    // JSONL の header にも実際の cwd (絶対パス) が残る
    const file = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = parseSessionFile(file, record.id);
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("unreachable");
    assert.equal(parsed.header.cwd, "/tmp/project/repos/app");
    await store1.close();

    // 復元は meta.projectCwd から解決し、未登録でも同じディレクトリを使う (mkdir しない)
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, { pi: pi2, workspace, catalog });
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.equal(store2.payload(restored).cwd, "repos/app");
    assert.equal(pi2.createInputs.at(-1)?.cwd, "repos/app");
    assert.equal(restored.projectCwd, "repos/app");
    assert.equal(restored.projectId, undefined, "未登録なので所属は未解決");
    assert.deepEqual(dirs, [], "復元でもプロジェクトのディレクトリは作らない");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("同一プロジェクトの別セッションは同じ作業ディレクトリを共有する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-share-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const project = projects.create({ cwd: "repos/app" });
    const pi = createStubPi();
    const store = createStore(storeDir, { pi, workspace, catalog, projects });
    await store.init();
    const first = await store.create({ projectId: project.id });
    const second = await store.create({ projectId: project.id });
    assert.notEqual(first.id, second.id);
    assert.equal(store.payload(first).cwd, store.payload(second).cwd);
    assert.equal(store.payload(first).cwd, "repos/app");
    assert.deepEqual(dirs, [], "どちらのセッションもディレクトリを作らない");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未所属セッションは従来どおりスクラッチを作る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-scratch-"));
  const { workspace, dirs } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi(), workspace });
    await store.init();
    const record = await store.create();
    assert.equal(record.workdir, `.u7agent/sessions/${record.id}`);
    assert.deepEqual(dirs, [record.workdir]);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
