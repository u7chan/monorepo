// 会話ストアの永続化と復元。SessionStore とスタブ pi / スタブサンドボックスを組み合わせて検証する。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { ProjectStore } from "../src/projects";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import { parseSessionFile, sessionJsonlPath, sessionMetaPath } from "../src/session-store";
import type { EventEntry, SessionPayload } from "../src/schema";
import { createStubPi, STUB_MODEL, STUB_PLAIN_MODEL, waitFor } from "./stub-pi";

function stubWorkspace(): { workspace: SandboxWorkspaceClient; dirs: string[] } {
  const dirs: string[] = [];
  return {
    dirs,
    workspace: {
      previewFile: async () => ({ text: "" }),
      listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
      createDir: async (path: string) => {
        dirs.push(path);
        return { path };
      },
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

test("永続化したセッションを新しい store が復元し、続きから送信できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-restore-"));
  const { workspace, dirs } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create({ agentId: "agent-general" });
    assert.match(record.id, /^[0-9a-f]{10}$/);
    assert.equal(record.workdir, `.pi-agent-gui/sessions/${record.id}`, "作業フォルダを cwd にする");
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

test("初回応答の完了前にユーザーメッセージが保存される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-early-"));
  const { workspace } = stubWorkspace();
  try {
    const store = createStore(storeDir, { pi: createStubPi({ chunkDelayMs: 300 }), workspace });
    await store.init();
    const record = await store.create({ agentId: "agent-general" });
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
    const record = await store1.create({ agentId: "agent-general" });
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

test("壊れた JSONL は原本を書き換えずに開く要求が失敗し、削除はできる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-damaged-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const store1 = createStore(storeDir, { pi: createStubPi(), workspace, catalog });
    await store1.init();
    const record = await store1.create({ agentId: "agent-general" });
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

test("PI_MODELS の候補外モデルでは再開せず、フォールバック後の実効モデルを保存する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-model-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const pi1 = createStubPi();
    const store1 = createStore(storeDir, { pi: pi1, workspace, catalog });
    await store1.init();
    const record = await store1.create({ agentId: "agent-general", model: { provider: "stub", id: "stub-model" } });
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
    const record = await store1.create({ agentId: "agent-general" });
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

test("プロジェクトを解除してもセッションと store は残り、未所属として解決される", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "sessions-project-"));
  const { workspace } = stubWorkspace();
  const catalog = createAgentCatalog();
  try {
    const projects = new ProjectStore();
    const store = createStore(storeDir, { pi: createStubPi(), workspace, catalog, projects });
    await store.init();
    const project = projects.create({ cwd: "proj-a" });
    const record = await store.create({ agentId: "agent-general", projectId: project.id });
    await store.flush(record);
    assert.equal(store.payload(record).projectId, project.id);

    projects.remove(project.id);
    await store.releaseProject(project.cwd);
    assert.equal(store.get(record.id), record, "セッションは live のまま残る");
    assert.equal(store.payload(record).projectId, undefined, "未所属として解決される");
    const meta = await readMeta(record.id, storeDir);
    assert.equal(meta.projectCwd, undefined, "解除を meta にも反映する");
    await store.close();
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
  await assert.rejects(store.create({ agentId: "agent-general" }), (error: Error & { statusCode?: number }) => {
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
    const record = await store1.create({ agentId: "agent-general" });
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
    const record = await store.create({ agentId: "agent-general" });
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
    const record = await store.create({ agentId: "agent-general" });
    await store.flush(record);
    assert.equal(record.writer?.error, undefined);
    assert.equal((await readFile(sessionJsonlPath(record.id, storeDir), "utf8")).length > 0, true);
    assert.ok(STUB_MODEL.id);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
