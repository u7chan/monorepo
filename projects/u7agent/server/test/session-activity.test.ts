// 実行状況 (全スペース横断) が使う一覧の値: 開始 / 終了 / 所要時間 / 圧縮開始 / 回答待ち開始と、
// 終了から 120 分の保持。時刻の正は live な実行だけとし、未ロードの会話と `lastUsedAt` を代用しない。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { AskUserAnswer, AskUserQuestion } from "../src/schema";
import { FINISHED_RETENTION_MS } from "../src/sessions";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const QUESTIONS: AskUserQuestion[] = [{ question: "進めますか", options: [{ label: "はい" }] }];
const ANSWERS: AskUserAnswer[] = [{ index: 0, selected: ["はい"] }];

function fixtureWorkspace(): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    statFile: async (path) => ({ path }),
    listFiles: async (path) => ({ path, entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path) => ({ path }),
    renameEntry: async (path, name) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-activity-"));
  const options = {
    cwd: "/tmp/activity-workspace",
    sessionStoreDir: dir,
    workspace: fixtureWorkspace(),
    pi: asPiBff(createStubPi({ chunkDelayMs: 5 })),
  };
  let bff = await createBffApp(options);
  t.after(async () => {
    await bff.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    get bff() {
      return bff;
    },
    /** 会話を 1 件作り、live な record を返す (POST /api/sessions は payload を返す) */
    async session() {
      const res = await bff.app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 201);
      const payload = (await res.json()) as { sessionId: string };
      const record = bff.store.get(payload.sessionId);
      assert.ok(record, "作成直後は live な record がある");
      return record;
    },
    /** 実行を 1 回完了させる (終了行の受入に使う) */
    async runToCompletion() {
      const record = await this.session();
      bff.store.postMessage(record, "こんにちは");
      await waitFor(() => bff.store.statusOf(record) === "completed", 5000, "run completion");
      return record;
    },
    async restart() {
      await bff.close();
      bff = await createBffApp(options);
    },
  };
}

test("一覧の summary は実行の開始・終了・所要時間を載せ、lastUsedAt を開始時刻に使わない", async (t) => {
  const f = await setup(t);
  const record = await f.runToCompletion();
  const summary = f.bff.store.summary(record);
  assert.equal(summary.status, "completed");
  assert.equal(typeof summary.runStartedAt, "number");
  assert.equal(typeof summary.finishedAt, "number");
  assert.ok(summary.finishedAt !== undefined && summary.runStartedAt !== undefined);
  assert.ok(summary.finishedAt >= summary.runStartedAt, "終了は開始より後");
  assert.equal(
    summary.lastRunDurationMs,
    record.runOutcomes.get(record.run?.id ?? "")?.durationMs,
    "所要時間は runOutcomes の控えと同じ",
  );

  // lastUsedAt は開く・回答でも動く。開始時刻の代用にしない
  record.lastUsedAt = summary.finishedAt + 60_000;
  const after = f.bff.store.summary(record);
  assert.equal(after.runStartedAt, summary.runStartedAt, "lastUsedAt を変えても開始時刻は動かない");
  assert.equal(after.lastUsedAt, record.lastUsedAt);

  // HTTP の一覧 (全スペース) にも同じ値が載る
  const list = (await (await f.bff.app.request("/api/sessions?scope=all")).json()) as {
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].runStartedAt, summary.runStartedAt);
  assert.equal(list.sessions[0].finishedAt, summary.finishedAt);
  assert.equal(list.sessions[0].lastRunDurationMs, summary.lastRunDurationMs);
});

test("回答待ちの開始は最も古い未 settle の質問で、回答すると消える", async (t) => {
  const f = await setup(t);
  const record = await f.session();
  const before = Date.now();
  const first = f.bff.store.askQuestion(record, "call-1", QUESTIONS, undefined);
  const opened = f.bff.store.summary(record);
  assert.equal(opened.awaitingAnswer, true);
  assert.ok(opened.awaitingSince !== undefined && opened.awaitingSince >= before);

  // 2 枚目が後から開いても、表示する経過時間の起点は古いほうのまま
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = f.bff.store.askQuestion(record, "call-2", QUESTIONS, undefined);
  assert.equal(f.bff.store.summary(record).awaitingSince, opened.awaitingSince);

  assert.equal(f.bff.store.answerQuestion(record, "call-1", ANSWERS).status, "ok");
  assert.equal(f.bff.store.answerQuestion(record, "call-2", ANSWERS).status, "ok");
  await Promise.all([first, second]);
  const settled = f.bff.store.summary(record);
  assert.equal(settled.awaitingAnswer, false);
  assert.equal(settled.awaitingSince, undefined, "settle 済みの tombstone は待機に数えない");
});

test("終了から 120 分以内のレコードは sweep で消さず、超えたら消す", async (t) => {
  const f = await setup(t);
  const record = await f.runToCompletion();
  assert.ok(record.run?.endedAt !== undefined);
  // TTL (60 分) を超えた最終使用でも、終了から 120 分以内は実行状況の行として残す
  record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
  record.run.endedAt = Date.now() - (FINISHED_RETENTION_MS - 60_000);
  await f.bff.store.sweep();
  assert.equal(f.bff.store.get(record.id), record, "120 分以内は残す");

  record.run.endedAt = Date.now() - (FINISHED_RETENTION_MS + 60_000);
  await f.bff.store.sweep();
  assert.equal(f.bff.store.get(record.id), undefined, "120 分を超えたら sweep の対象に戻る");
});

test("未ロードの会話の summary は実行の時刻を載せず、idle として返す", async (t) => {
  const f = await setup(t);
  const record = await f.runToCompletion();
  await f.bff.store.flush(record);
  await f.restart();
  assert.equal(f.bff.store.get(record.id), undefined, "再起動後は未ロード (descriptor) になる");
  const list = (await (await f.bff.app.request("/api/sessions")).json()) as {
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].status, "idle");
  assert.equal("runStartedAt" in list.sessions[0], false);
  assert.equal("finishedAt" in list.sessions[0], false);
  assert.equal("lastRunDurationMs" in list.sessions[0], false);
  assert.equal("awaitingSince" in list.sessions[0], false);
  assert.equal(typeof list.sessions[0].lastUsedAt, "number");
});

test("summary は serve の成功実績を workdir 単位で載せ、無い会話は null にする", async (t) => {
  const f = await setup(t);
  const live = await f.session();
  assert.equal(f.bff.store.summary(live).serveCommand, null, "実績が無い会話は null");

  f.bff.appDb.saveServeCommand({ cwd: live.workdir, command: "python3 -m http.server 8080", updatedAt: 1 });
  assert.deepEqual(f.bff.store.summary(live).serveCommand, {
    cwd: live.workdir,
    command: "python3 -m http.server 8080",
  });

  // 未ロード (再起動後) も descriptor から同じ workdir を引いて同じ値を返す
  await f.bff.store.flush(live);
  await f.restart();
  assert.equal(f.bff.store.get(live.id), undefined);
  const unloaded = (await (await f.bff.app.request("/api/sessions?scope=all")).json()) as {
    sessions: Array<{ sessionId: string; serveCommand: { cwd: string; command: string } | null }>;
  };
  assert.deepEqual(unloaded.sessions.find((item) => item.sessionId === live.id)?.serveCommand, {
    cwd: live.workdir,
    command: "python3 -m http.server 8080",
  });
});

test("serveCommand は cwd を共有するプロジェクト会話で同じ値になり、別ディレクトリへは漏れない", async (t) => {
  const f = await setup(t);
  const post = (path: string, body: unknown) =>
    f.bff.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const project = (await (await post("/api/projects", { cwd: "proj-a", name: "demo" })).json()) as {
    project: { id: string; cwd: string };
  };
  const create = async (body: unknown) => (await (await post("/api/sessions", body)).json()) as { sessionId: string };
  const first = await create({ projectId: project.project.id });
  const second = await create({ projectId: project.project.id });
  const other = await create({});
  f.bff.appDb.saveServeCommand({ cwd: project.project.cwd, command: "pnpm dev", updatedAt: 1 });

  const list = (await (await f.bff.app.request("/api/sessions?scope=all")).json()) as {
    sessions: Array<{ sessionId: string; serveCommand: { cwd: string; command: string } | null }>;
  };
  const serveCommandOf = (id: string) => list.sessions.find((item) => item.sessionId === id)?.serveCommand;
  assert.deepEqual(serveCommandOf(first.sessionId), { cwd: project.project.cwd, command: "pnpm dev" });
  assert.deepEqual(
    serveCommandOf(second.sessionId),
    { cwd: project.project.cwd, command: "pnpm dev" },
    "同じ cwd のプロジェクト会話は実績を共有する",
  );
  assert.equal(serveCommandOf(other.sessionId), null, "実績の無い workdir へは漏れない");
});
