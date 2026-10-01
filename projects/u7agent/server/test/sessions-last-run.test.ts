// 最後に終わったラン (SessionSummary.lastRun / SessionMeta.lastRun) の永続化と復元。
// サイドバーの未見表示は「最後に終わったラン」だけを見るため、実行中のランで上書きしないこと
// (再起動で走っていないランが残らないこと) と、SWEEP / 再起動後も meta から同じ値が返ることを固定する。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import { readSessionMeta, sessionMetaPath } from "../src/session-store";
import type { LastRunSummary } from "../src/schema";
import { createStubPi, waitFor } from "./stub-pi";

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
}

function createStore(storeDir: string, pi: ReturnType<typeof createStubPi>): SessionStore {
  return new SessionStore({
    pi: pi as never,
    catalog: createAgentCatalog(),
    projects: null,
    storeDir,
    workspace: stubWorkspace(),
    rootCwd: "/tmp/project",
  });
}

async function readMeta(id: string, storeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionMetaPath(id, storeDir), "utf8")) as Record<string, unknown>;
}

function lastRunOf(value: unknown): LastRunSummary | undefined {
  return (value as { lastRun?: LastRunSummary } | undefined)?.lastRun;
}

test("list() と meta は最後に終わったランを lastRun に持つ", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-last-run-"));
  try {
    const store = createStore(storeDir, createStubPi());
    const record = await store.create();
    // 一度も終わっていない会話は lastRun を持たない (未見なしとして扱う)
    assert.equal(lastRunOf(store.list()[0]), undefined);

    store.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store.flush(record);

    const finished = record.run;
    assert.ok(finished?.endedAt, "終端した run に endedAt が無い");
    const expected: LastRunSummary = { id: finished.id, status: "completed", endedAt: finished.endedAt };
    assert.deepEqual(lastRunOf(store.list()[0]), expected, "live な一覧が lastRun を返していない");
    assert.deepEqual((await readMeta(record.id, storeDir)).lastRun, expected, "meta に保存されていない");
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("persist は終端したランだけを書き、実行中は前回の lastRun を保つ", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-last-run-running-"));
  try {
    // 2 本目のランを実行中に捕まえるため、応答を遅らせる
    const store = createStore(storeDir, createStubPi({ chunkDelayMs: 200 }));
    const record = await store.create();
    store.postMessage(record, "1 本目");
    await waitFor(() => record.run?.status === "completed", 3000, "first run completed");
    await store.flush(record);

    const first = record.run;
    assert.ok(first);
    const afterFirst = await readMeta(record.id, storeDir);

    // 実行中は persist が呼ばれても meta.lastRun を running で上書きしない
    store.postMessage(record, "2 本目");
    const second = record.run;
    assert.ok(second);
    assert.equal(record.run?.endedAt, undefined, "2 本目が実行中になっていない");
    await store.persist(record);
    assert.deepEqual((await readMeta(record.id, storeDir)).lastRun, afterFirst.lastRun, "実行中のランで上書きしている");
    assert.equal(lastRunOf(store.list()[0])?.id, first.id, "一覧が実行中のランを lastRun にしている");

    // 停止で終端したら、そのランが lastRun になる
    await store.stop(record);
    await store.flush(record);
    const stopped: LastRunSummary = {
      id: second.id,
      status: "stopped",
      endedAt: record.run?.endedAt ?? 0,
    };
    assert.equal(stopped.endedAt > 0, true, "停止した run に endedAt が無い");
    assert.deepEqual((await readMeta(record.id, storeDir)).lastRun, stopped);
    assert.deepEqual(lastRunOf(store.list()[0]), stopped);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("保存キューが詰まっていても、次のランが始まる前に終わったランを lastRun として保つ", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-last-run-queued-"));
  try {
    const store = createStore(storeDir, createStubPi({ chunkDelayMs: 120 }));
    const record = await store.create();
    // 保存キューを保留し、A の終了保存が実行されないまま次のランが始まる状況を作る (実際は保存が
    // 詰まっているときの順序)
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    record.persistTail = held;

    const runA = store.postMessage(record, "A").runId;
    // 実行中に送った B はキューに積まれ、A の終了の 200ms 後に次のランとして始まる
    const runB = store.postMessage(record, "B").runId;
    assert.ok(runA && runB && runA !== runB);

    await waitFor(() => record.run?.id === runB, 4000, "run B started");
    assert.equal(record.run?.status, "running");
    // 保存が終わっていなくても、一覧は直前に終わった A を返す
    assert.equal(store.list()[0].lastRun?.id, runA, "次のランで lastRun が消えている");

    // 保留した保存を解放すると、B の実行中でも A が meta へ書かれる (実行中のランで上書きしない)
    release();
    await store.flush(record);
    assert.equal(lastRunOf(await readMeta(record.id, storeDir))?.id, runA, "実行中の保存で A が消えている");

    // B が終われば lastRun は B に進む
    await waitFor(() => record.run?.status === "completed", 4000, "run B completed");
    await store.flush(record);
    assert.equal(lastRunOf(await readMeta(record.id, storeDir))?.id, runB);
    assert.equal(store.list()[0].lastRun?.id, runB);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("再起動後は meta.lastRun から一覧が復元され、live な record でも run は null のまま保たれる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-last-run-restart-"));
  try {
    const first = createStore(storeDir, createStubPi());
    const record = await first.create();
    first.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await first.flush(record);
    const finished = record.run;
    assert.ok(finished);
    const expected: LastRunSummary = { id: finished.id, status: "completed", endedAt: finished.endedAt ?? 0 };
    await first.close();

    const second = createStore(storeDir, createStubPi());
    await second.init();
    // 未ロード (summaryOfMeta) でも lastRun を返す
    assert.deepEqual(lastRunOf(second.list()[0]), expected, "再起動で lastRun が消えている");
    // ロード直後の live な record は run: null で作られる。ここで meta.lastRun へ落ちないと未見が消える
    const restored = await second.resolve(record.id);
    assert.ok(restored);
    assert.equal(restored.run, null);
    assert.deepEqual(lastRunOf(second.list()[0]), expected, "live な record の summary に lastRun が無い");
    assert.equal(second.statusOf(restored), "idle", "再起動後の状態は idle (running を復元しない)");
    await second.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("壊れた lastRun は読み込みで捨てる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-last-run-broken-"));
  try {
    const store = createStore(storeDir, createStubPi());
    const record = await store.create();
    store.postMessage(record, "こんにちは");
    await waitFor(() => record.run?.status === "completed", 3000, "run completed");
    await store.flush(record);
    await store.close();

    const path = sessionMetaPath(record.id, storeDir);
    const base = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const valid: LastRunSummary = { id: "run-1", status: "completed", endedAt: 1 };

    // 正しい値はそのまま読む
    await writeFile(path, JSON.stringify({ ...base, lastRun: valid }));
    assert.deepEqual((await readSessionMeta(storeDir, record.id))?.lastRun, valid);

    for (const broken of [
      "run-1",
      null,
      {},
      { id: "", status: "completed", endedAt: 1 },
      { id: 1, status: "completed", endedAt: 1 },
      // 実行中は lastRun に載せない (再起動で走っていないランを復元しない)
      { id: "run-1", status: "running", endedAt: 1 },
      { id: "run-1", status: "queued", endedAt: 1 },
      { id: "run-1", status: "idle", endedAt: 1 },
      { id: "run-1", status: "completed", endedAt: "1" },
      { id: "run-1", status: "completed", endedAt: Number.NaN },
      { id: "run-1", status: "completed" },
    ]) {
      await writeFile(path, JSON.stringify({ ...base, lastRun: broken }));
      const meta = await readSessionMeta(storeDir, record.id);
      assert.ok(meta, `${JSON.stringify(broken)} で meta ごと読めなくなっている`);
      assert.equal(meta.lastRun, undefined, `${JSON.stringify(broken)} を lastRun として読んでいる`);
    }
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
