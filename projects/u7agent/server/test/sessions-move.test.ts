// セッションの引っ越し (POST /api/sessions/:id/move) が、所属・作業フォルダ・添付・cwd キーの行を
// 移動先へ移し、会話履歴を破棄することを検証する。サンドボックスは実ファイルシステムのスタブ。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { AppDb } from "../src/app-db";
import { sessionUploadsRel, sessionWorkdirRel, spaceDirRel } from "../src/app-paths";
import type { SandboxHandoffClient, SandboxMoveClient, SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import { HANDOFF_FILE_NAME } from "../src/handoff-memo";
import { SessionMoveResponseSchema } from "../src/schema";
import { createAgentCatalog } from "../src/agents";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { sessionJsonlPath, sessionMetaPath, sessionSendsPath } from "../src/session-store";
import { SessionStore } from "../src/sessions";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";
import { createServeSandboxStub } from "./serve-stub";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonPatch = (payload: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** 引き継ぎメモの上限。サンドボックスのプレビュー上限とは別に持つ */
const HANDOFF_MAX_BYTES = 2 * 1024 * 1024;

// root は検索権限の無いディレクトリでも読めるため、権限の検証は非 root のときだけ行う
const IS_ROOT = process.getuid?.() === 0;

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * 実ファイルシステムを workspace root にして、サンドボックスの move の 404 / 409 と、引き継ぎメモの
 * 読み書き (上限・冪等化) を再現するスタブ。`failures` / `handoffFailures` へ入れた操作だけを失敗させ、
 * ロールバックのテストに使う。
 */
function createFsSandbox(root: string) {
  const abs = (path: string) => (path ? join(root, path) : root);
  const moves: Array<{ from: string; to: string }> = [];
  const failures: Array<{ from: string; error: Error }> = [];
  const handoffWrites: Array<{ path: string; section: string }> = [];
  const handoffRollbacks: Array<{ path: string; expected: string; deleted: boolean }> = [];
  const handoffFailures: Array<{ path: string; error: Error }> = [];
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => {
      const entries = await readdir(abs(path), { withFileTypes: true });
      return {
        path: path || ".",
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("dir" as const) : ("file" as const),
        })),
        truncated: false,
      };
    },
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => {
      await mkdir(abs(path), { recursive: true });
      return { path };
    },
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async (path: string) => {
      await rm(abs(path), { force: true });
    },
    deleteDirectory: async (path: string) => {
      await rm(abs(path), { recursive: true, force: true });
    },
    uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
  const move: SandboxMoveClient = {
    moveEntry: async (from: string, to: string) => {
      moves.push({ from, to });
      const failure = failures.find((item) => item.from === from);
      if (failure) throw failure.error;
      // 実サンドボックスと同じ順 (移動元の存在 → 移動先の競合) で 404 / 409 を返す
      const source = abs(from);
      if (!(await pathExists(source))) throw new SandboxRequestError(`Path not found: ${from}`, 404);
      const destination = abs(to);
      if (await pathExists(destination)) throw new SandboxRequestError(`Already exists: ${to}`, 409);
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new SandboxRequestError(`Path not found: ${from}`, 404);
        }
        throw error;
      }
      return { path: to };
    },
  };
  const handoff: SandboxHandoffClient = {
    readHandoff: async (path: string) => {
      const text = await readFile(abs(path), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new SandboxRequestError(`Path not found: ${path}`, 404);
        throw error;
      });
      if (Buffer.byteLength(text, "utf8") > HANDOFF_MAX_BYTES) {
        throw new SandboxRequestError("HANDOFF.md は 2 MiB 以下にしてください", 400);
      }
      return { text };
    },
    writeHandoff: async ({ path, section, dedupeKey }) => {
      const failure = handoffFailures.find((item) => item.path === path);
      if (failure) throw failure.error;
      const target = abs(path);
      const existing = await readFile(target, "utf8").catch(() => undefined);
      const firstLine = existing === undefined ? "" : (existing.split("\n", 1)[0] ?? "");
      if (dedupeKey !== "" && firstLine.includes(dedupeKey)) {
        return { path, written: false, created: false };
      }
      handoffWrites.push({ path, section });
      await writeFile(target, `${section}${existing ?? ""}`, "utf8");
      return { path, written: true, created: existing === undefined };
    },
    rollbackHandoff: async ({ path, expected }) => {
      // 実サンドボックスと同じく、「読む → 照合 → 消す」の全体を 1 回の呼び出しで行う
      const target = abs(path);
      const current = await readFile(target, "utf8").catch(() => undefined);
      const deleted = current !== undefined && current === expected;
      if (deleted) await rm(target, { force: true });
      handoffRollbacks.push({ path, expected, deleted });
      return { deleted };
    },
  };
  return {
    workspace,
    move,
    handoff,
    serve: createServeSandboxStub(),
    moves,
    failures,
    handoffWrites,
    handoffFailures,
    handoffRollbacks,
  };
}

async function withPaths<T>(run: (paths: { root: string; store: string }) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-sessions-move-"));
  try {
    return await run({ root: join(base, "workspace"), store: join(base, "store") });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function openBff(
  paths: { root: string; store: string },
  options: { pi?: ReturnType<typeof createStubPi> | null; sandbox?: ReturnType<typeof createFsSandbox> | null } = {},
) {
  const sandbox = options.sandbox === undefined ? createFsSandbox(paths.root) : options.sandbox;
  const bff = await createBffApp({
    cwd: paths.root,
    sessionStoreDir: paths.store,
    pi: options.pi === undefined ? asPiBff(createStubPi()) : options.pi === null ? null : asPiBff(options.pi),
    workspace: sandbox?.workspace ?? null,
    moveSandbox: sandbox?.move ?? null,
    handoffSandbox: sandbox?.handoff ?? null,
    serveSandbox: sandbox?.serve.sandbox ?? null,
    // 停止中の状態を既定にする (このファイルはサービスの稼働を扱わない)
    serveProbe: async () => false,
  });
  return { bff, sandbox };
}

type Harness = Awaited<ReturnType<typeof openBff>>["bff"];

async function createSpace(bff: Harness, name: string): Promise<string> {
  const response = await bff.app.request("/api/spaces", jsonPost({ name }));
  assert.equal(response.status, 201);
  return (await jsonBody(response)).space.id as string;
}

async function createSession(bff: Harness, body: Record<string, unknown> = {}): Promise<any> {
  const response = await bff.app.request("/api/sessions", jsonPost(body));
  assert.equal(response.status, 201);
  return response.json();
}

async function moveTo(
  bff: Harness,
  id: string,
  target: string,
  options: { fromSpace?: string; agentId?: string; memo?: boolean } = {},
) {
  const query = !options.fromSpace || options.fromSpace === "default" ? "" : `?spaceId=${options.fromSpace}`;
  return bff.app.request(
    `/api/sessions/${id}/move${query}`,
    jsonPost({
      spaceId: target,
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      ...(options.memo === undefined ? {} : { memo: options.memo }),
    }),
  );
}

async function readMeta(id: string, store: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionMetaPath(id, store), "utf8")) as Record<string, unknown>;
}

/** 注入の前に、飛んでいる保存を待つ (直後の rename と競合させない) */
async function settleWrites(bff: Harness, id: string): Promise<void> {
  const record = bff.store.get(id);
  if (record) await bff.store.flush(record);
}

/**
 * meta.json をディレクトリへ差し替えて保存を失敗させる。非同期な保存 (temp + rename) が直後に作り直す
 * ことがあるため、差し替えが収束するまで試す (注入と競合して EEXIST で落ちないようにする)。
 */
async function replaceMetaWithDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await rm(path, { recursive: true, force: true });
    try {
      await mkdir(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`meta.json をディレクトリに差し替えられませんでした: ${path}`);
}

test("moves a session to another space with its workdir and uploads, and drops the history", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "引っ越し前の会話" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      await bff.app.request(`/api/sessions/${id}/title`, jsonPatch({ title: "引っ越す会話" }));
      await bff.app.request(`/api/sessions/${id}/pin`, jsonPatch({ pinned: true }));
      await bff.app.request(`/api/sessions/${id}/notify`, jsonPatch({ notify: true }));
      const before = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      await mkdir(join(paths.root, sessionUploadsRel(id)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id), "note.txt"), "添付");

      const response = await moveTo(bff, id, space);
      assert.equal(response.status, 200);
      assert.deepEqual(SessionMoveResponseSchema.parse(await response.json()), {
        sessionId: id,
        title: "引っ越す会話",
        spaceId: space,
        memo: false,
        cleanupPending: false,
      });

      // 作業フォルダと添付が移動先へ移り、履歴のファイルは消える (開き直すと空の履歴で作り直される)
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), false);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), true);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id, "default"))), false);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id, space), "note.txt")), true);
      assert.equal(existsSync(sessionJsonlPath(id, paths.store)), false);
      assert.equal(existsSync(sessionSendsPath(id, paths.store)), false);

      // 所属は meta / 一覧 / payload のすべてで移動先になる
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.spaceId, space);
      assert.equal(meta.title, "引っ越す会話");
      assert.equal(meta.pinned, true);
      assert.equal(meta.notify, true);
      assert.equal(meta.model, before.model, "モデルが変わった");
      assert.equal(meta.messageCount, 0);
      assert.ok((meta.lastUsedAt as number) >= (before.lastUsedAt as number), "最終使用時刻が更新されない");
      const defaultList = await jsonBody(bff.app.request("/api/sessions"));
      assert.equal(
        defaultList.sessions.some((item: { sessionId: string }) => item.sessionId === id),
        false,
      );
      const list = await jsonBody(bff.app.request(`/api/sessions?spaceId=${space}`));
      const summary = list.sessions.find((item: { sessionId: string }) => item.sessionId === id);
      assert.equal(summary.spaceId, space);
      assert.equal(summary.canHandoff, true);
      assert.equal(summary.handoffCleanup, undefined);
      assert.equal(summary.messageCount, 0);
      const payload = await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${space}`));
      assert.equal(payload.spaceId, space);
      assert.equal(payload.cwd, sessionWorkdirRel(id, space));
      assert.equal(payload.title, "引っ越す会話");
      assert.equal(payload.pinned, true);
      assert.equal(payload.notify, true);
      assert.equal(payload.model, before.model);
      assert.deepEqual(payload.messages, []);
      assert.equal(bff.store.workdirOfId(id), sessionWorkdirRel(id, space));
    } finally {
      await bff.close();
    }
  });
});

test("moves between additional spaces and back to the default space", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const created = await createSession(bff, { spaceId: spaceA });
      const id = created.sessionId as string;
      assert.equal(created.cwd, sessionWorkdirRel(id, spaceA));
      await writeFile(join(paths.root, sessionWorkdirRel(id, spaceA), "work.txt"), "作業中");

      assert.equal((await moveTo(bff, id, spaceB, { fromSpace: spaceA })).status, 200);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt")), true);
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${spaceB}`))).spaceId, spaceB);

      assert.equal((await moveTo(bff, id, "default", { fromSpace: spaceB })).status, 200);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"), "work.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB))), false);
      const payload = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(payload.spaceId, "default");
      assert.equal(payload.cwd, sessionWorkdirRel(id, "default"));
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
    } finally {
      await bff.close();
    }
  });
});

test("answers 404 for unknown sessions, other spaces and unknown destination spaces", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;

      const unknownSession = await moveTo(bff, "deadbeef00", space);
      assert.equal(unknownSession.status, 404);
      // 他会話 (要求元スペースの不一致) は SDK を開く前に 404
      const otherSpace = await moveTo(bff, id, space, { fromSpace: space });
      assert.equal(otherSpace.status, 404);
      // 未知の移動先スペース
      const unknownSpace = await moveTo(bff, id, "space-0000000000000000");
      assert.equal(unknownSpace.status, 404);
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
    } finally {
      await bff.close();
    }
  });
});

test("allows the same space, restricts project sessions to it, and keeps the scratch invariant", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;

      // 同じスペースへの引き継ぎは成立する (作業フォルダはその場に残る)
      const sameSpace = await moveTo(bff, id, "default");
      assert.equal(sameSpace.status, 200);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), true);

      // プロジェクト所属は projectCwd で判定する。同じスペースへの引き継ぎは通り、別スペースは 400
      await mkdir(join(paths.root, "proj"), { recursive: true });
      const project = await jsonBody(bff.app.request("/api/projects", jsonPost({ cwd: "proj", name: "P" })));
      const projectSession = await createSession(bff, { projectId: project.project.id });
      const projectSummary = (await jsonBody(bff.app.request("/api/sessions"))).sessions.find(
        (item: { sessionId: string }) => item.sessionId === projectSession.sessionId,
      );
      assert.equal(projectSummary.canHandoff, true);
      assert.equal(projectSummary.projectSession, true);
      assert.equal((await moveTo(bff, projectSession.sessionId, "default")).status, 200);
      assert.equal((await moveTo(bff, projectSession.sessionId, space)).status, 400);
      // 登録解除しても meta の projectCwd は残るため、別スペースは 400 のまま (同じスペースは通る)
      assert.equal((await bff.app.request(`/api/projects/${project.project.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await moveTo(bff, projectSession.sessionId, space)).status, 400);
      assert.equal((await moveTo(bff, projectSession.sessionId, "default")).status, 200);

      // workdir がスクラッチでない record は動かさない (不変条件)
      (await bff.store.resolve(id))!.workdir = ".u7agent/sessions/other";
      const nonScratch = await moveTo(bff, id, space);
      assert.equal(nonScratch.status, 400);
      assert.match((await jsonBody(nonScratch)).error, /セッション専用の作業フォルダ/);
    } finally {
      await bff.close();
    }
  });
});

test("answers 409 while the session is busy or changing settings", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths, { pi: createStubPi({ chunkDelayMs: 200 }) });
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "実行中" }));
      assert.equal(bff.store.statusOf(bff.store.get(id)!), "running");
      const busy = await moveTo(bff, id, space);
      assert.equal(busy.status, 409);
      assert.match((await jsonBody(busy)).error, /実行中・キュー中・設定変更中/);

      // キュー中 / 圧縮中 / 設定変更中 (model / thinkingLevel の変更中) も同じ 409 (busy 判定は statusOf が正)
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      const record = bff.store.get(id)!;
      record.queue.push({ text: "待機", runId: "a1b2c3d4" });
      assert.equal(bff.store.statusOf(record), "queued");
      assert.equal((await moveTo(bff, id, space)).status, 409);
      record.queue = [];
      record.compacting = true;
      assert.equal((await moveTo(bff, id, space)).status, 409);
      record.compacting = false;
      record.changingSettings = true;
      assert.equal((await moveTo(bff, id, space)).status, 409);
      record.changingSettings = false;
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
    } finally {
      await bff.close();
    }
  });
});

test("moves a damaged session without the runtime and restores it empty after a restart", async () => {
  await withPaths(async (paths) => {
    const first = await openBff(paths);
    const created = await createSession(first.bff);
    const id = created.sessionId as string;
    await first.bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "壊れる前の会話" }));
    await waitFor(() => first.bff.store.statusOf(first.bff.store.get(id)!) === "completed", 5000, "run completion");
    await first.bff.close();

    // JSONL を壊し、モデル未認証 (pi なし) で開き直す。移動は SDK を開かないため通る
    await writeFile(sessionJsonlPath(id, paths.store), "壊れた行\n");
    const offline = await openBff(paths, { pi: null });
    const space = await createSpace(offline.bff, "デモ");
    try {
      const response = await moveTo(offline.bff, id, space);
      assert.equal(response.status, 200);
    } finally {
      await offline.bff.close();
    }

    // 再起動後も移動先の所属と新しい cwd で復元し、空の履歴から送信を続けられる
    const restarted = await openBff(paths);
    try {
      const list = await jsonBody(restarted.bff.app.request(`/api/sessions?spaceId=${space}`));
      assert.equal(list.sessions[0].sessionId, id);
      const payload = await jsonBody(restarted.bff.app.request(`/api/sessions/${id}?spaceId=${space}`));
      assert.deepEqual(payload.messages, []);
      assert.equal(payload.cwd, sessionWorkdirRel(id, space));
      const posted = await restarted.bff.app.request(
        `/api/sessions/${id}/messages?spaceId=${space}`,
        jsonPost({ text: "移動後の送信" }),
      );
      assert.equal(posted.status, 202);
      await waitFor(
        () => restarted.bff.store.statusOf(restarted.bff.store.get(id)!) === "completed",
        5000,
        "post-move run",
      );
      const after = await jsonBody(restarted.bff.app.request(`/api/sessions/${id}?spaceId=${space}`));
      assert.deepEqual(
        after.messages.map((message: { role: string }) => message.role),
        ["user", "assistant"],
      );
    } finally {
      await restarted.bff.close();
    }
  });
});

test("does not revive unsent sends after the move", async () => {
  await withPaths(async (paths) => {
    const first = await openBff(paths);
    const created = await createSession(first.bff);
    const id = created.sessionId as string;
    await first.bff.close();

    await writeFile(
      sessionSendsPath(id, paths.store),
      `${JSON.stringify({ unsent: [{ runId: "a1b2c3d4", text: "未送信", at: 1 }] })}\n`,
    );

    const { bff } = await openBff(paths);
    const space = await createSpace(bff, "デモ");
    try {
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${id}`))).pendingSends.length, 1);
      assert.equal((await moveTo(bff, id, space)).status, 200);
      assert.equal(existsSync(sessionSendsPath(id, paths.store)), false);
      const payload = await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${space}`));
      assert.deepEqual(payload.pendingSends, []);
      assert.deepEqual(payload.messages, []);
    } finally {
      await bff.close();
    }
  });
});

test("moves secrets and serve commands to the new cwd", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      const fromCwd = sessionWorkdirRel(id, "default");
      const toCwd = sessionWorkdirRel(id, space);
      const secret = await bff.app.request(
        "/api/secrets",
        jsonPost({ sessionId: id, kind: "variable", name: "FOO", value: "bar" }),
      );
      assert.equal(secret.status, 200);
      bff.appDb.saveServeCommand({ cwd: fromCwd, command: "pnpm dev", updatedAt: 1 });

      assert.equal((await moveTo(bff, id, space)).status, 200);

      assert.deepEqual(
        bff.appDb.listSecrets(toCwd).map((row) => row.name),
        ["FOO"],
      );
      assert.deepEqual(bff.appDb.listSecrets(fromCwd), []);
      assert.equal(bff.appDb.getServeCommand(toCwd)?.command, "pnpm dev");
      assert.equal(bff.appDb.getServeCommand(fromCwd), undefined);
      // 移動後の会話から見た環境変数の一覧にも同じ値が出る
      const listed = await jsonBody(bff.app.request(`/api/secrets?sessionId=${id}&spaceId=${space}`));
      assert.equal(
        listed.items.some((row: { name: string }) => row.name === "FOO"),
        true,
      );
    } finally {
      await bff.close();
    }
  });
});

test("answers 503 without a store or a sandbox", async () => {
  await withPaths(async (paths) => {
    const sandbox = createFsSandbox(paths.root);
    const noStore = await createBffApp({
      cwd: paths.root,
      sessionStoreDir: null,
      pi: asPiBff(createStubPi()),
      workspace: sandbox.workspace,
      moveSandbox: sandbox.move,
    });
    try {
      const space = await createSpace(noStore, "デモ");
      const created = await createSession(noStore);
      const response = await moveTo(noStore, created.sessionId, space);
      assert.equal(response.status, 503);
      assert.match((await jsonBody(response)).error, /会話ストア/);
    } finally {
      await noStore.close();
    }

    const first = await openBff(paths);
    const created = await createSession(first.bff);
    const id = created.sessionId as string;
    const space = await createSpace(first.bff, "デモ");
    await first.bff.close();

    const noSandbox = await createBffApp({
      cwd: paths.root,
      sessionStoreDir: paths.store,
      pi: asPiBff(createStubPi()),
      workspace: null,
      moveSandbox: null,
      handoffSandbox: null,
    });
    try {
      const response = await moveTo(noSandbox, id, space);
      assert.equal(response.status, 503);
      assert.match((await jsonBody(response)).error, /サンドボックスが設定されていません/);
    } finally {
      await noSandbox.close();
    }

    // アプリ DB が使えないときは変更系の契約 (503 + state: not_stored) で止める
    await rm(join(paths.store, "u7agent.db"), { force: true });
    await mkdir(join(paths.store, "u7agent.db"));
    const noDb = await createBffApp({
      cwd: paths.root,
      sessionStoreDir: paths.store,
      pi: asPiBff(createStubPi()),
      workspace: sandbox.workspace,
      moveSandbox: sandbox.move,
    });
    try {
      const response = await moveTo(noDb, id, space);
      assert.equal(response.status, 503);
      assert.equal((await jsonBody(response)).state, "not_stored");
    } finally {
      await noDb.close();
    }
  });
});

test("rolls back the workdir when the uploads move conflicts", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await writeFile(join(paths.root, sessionWorkdirRel(id, "default"), "work.txt"), "作業中");
      // 移動先に既存の添付がある = マージせずエラー (退避先の削除を案内する)
      await mkdir(join(paths.root, sessionUploadsRel(id, space)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id, space), "old.txt"), "先客");
      await mkdir(join(paths.root, sessionUploadsRel(id)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id), "new.txt"), "移動する添付");

      const response = await moveTo(bff, id, space);
      assert.equal(response.status, 409);
      assert.match((await jsonBody(response)).error, /退避先を削除/);
      // 移動先の添付が競合した後、移動済みの作業フォルダを逆順で戻す
      assert.deepEqual(sandbox!.moves, [
        { from: sessionWorkdirRel(id, "default"), to: sessionWorkdirRel(id, space) },
        { from: sessionUploadsRel(id), to: sessionUploadsRel(id, space) },
        { from: sessionWorkdirRel(id, space), to: sessionWorkdirRel(id, "default") },
      ]);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"), "work.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), false);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id), "new.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id, space), "old.txt")), true);
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
    } finally {
      await bff.close();
    }
  });
});

test("rolls back the workdir when the cwd-key move fails", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      const fromCwd = sessionWorkdirRel(id, "default");
      const toCwd = sessionWorkdirRel(id, space);
      await bff.app.request("/api/secrets", jsonPost({ sessionId: id, kind: "variable", name: "FOO", value: "bar" }));
      bff.appDb.saveServeCommand({ cwd: fromCwd, command: "pnpm dev", updatedAt: 1 });
      // 移動先の cwd に既存の実績があると PRIMARY KEY で失敗する (部分適用させない)
      bff.appDb.saveServeCommand({ cwd: toCwd, command: "pnpm start", updatedAt: 2 });

      const response = await moveTo(bff, id, space);
      assert.equal(response.status, 500);
      assert.equal(existsSync(join(paths.root, fromCwd)), true);
      assert.equal(existsSync(join(paths.root, toCwd)), false);
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");

      // トランザクションなので secrets / serve_commands のどちらも移動前のまま
      const fresh = AppDb.open({ storeDir: paths.store });
      try {
        assert.deepEqual(
          fresh.listSecrets(fromCwd).map((row) => row.name),
          ["FOO"],
        );
        assert.deepEqual(fresh.listSecrets(toCwd), []);
        assert.equal(fresh.getServeCommand(fromCwd)?.command, "pnpm dev");
        assert.equal(fresh.getServeCommand(toCwd)?.command, "pnpm start");
      } finally {
        fresh.close();
      }
    } finally {
      await bff.close();
    }
  });
});

test("rolls back the workdir when the meta write fails", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      // meta.json をディレクトリに差し替え、temp + rename の rename を失敗させる
      await rm(sessionMetaPath(id, paths.store));
      await mkdir(sessionMetaPath(id, paths.store));

      const response = await moveTo(bff, id, space);
      assert.equal(response.status, 500);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), false);
      assert.equal(bff.store.spaceOfId(id), "default");
    } finally {
      await bff.close();
    }
  });
});

test("is idempotent on retry: already moved, both present, neither present", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");

      // 元なし先あり = 移動済みとして続行する
      const moved = await createSession(bff);
      await writeFile(join(paths.root, sessionWorkdirRel(moved.sessionId, "default"), "work.txt"), "作業中");
      await mkdir(join(paths.root, sessionWorkdirRel(moved.sessionId, space)), { recursive: true });
      await rename(
        join(paths.root, sessionWorkdirRel(moved.sessionId, "default")),
        join(paths.root, sessionWorkdirRel(moved.sessionId, space)),
      );
      assert.equal((await moveTo(bff, moved.sessionId, space)).status, 200);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(moved.sessionId, space), "work.txt")), true);
      assert.equal((await readMeta(moved.sessionId, paths.store)).spaceId, space);

      // 元と先が両方ある = マージせずエラー (何も変えない)
      const both = await createSession(bff);
      await writeFile(join(paths.root, sessionWorkdirRel(both.sessionId, "default"), "source.txt"), "元");
      await mkdir(join(paths.root, sessionWorkdirRel(both.sessionId, space)), { recursive: true });
      await writeFile(join(paths.root, sessionWorkdirRel(both.sessionId, space), "dest.txt"), "先客");
      assert.equal((await moveTo(bff, both.sessionId, space)).status, 409);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(both.sessionId, "default"), "source.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(both.sessionId, space), "dest.txt")), true);
      assert.equal((await readMeta(both.sessionId, paths.store)).spaceId, "default");

      // どちらも無い = 何もせず meta の更新だけ続行する
      const neither = await createSession(bff);
      await rm(join(paths.root, sessionWorkdirRel(neither.sessionId, "default")), { recursive: true, force: true });
      assert.equal((await moveTo(bff, neither.sessionId, space)).status, 200);
      assert.equal((await readMeta(neither.sessionId, paths.store)).spaceId, space);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(neither.sessionId, space))), false);
    } finally {
      await bff.close();
    }
  });
});

test("closes SSE subscribers without a deleted event", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      const record = bff.store.get(id)!;
      const events: Array<{ type: string }> = [];
      let closed = false;
      bff.store.subscribe(
        record,
        undefined,
        (entry) => events.push(entry),
        () => {
          closed = true;
        },
      );

      assert.equal((await moveTo(bff, id, space)).status, 200);
      assert.equal(closed, true);
      assert.equal(
        events.some((entry) => entry.type === "session_deleted"),
        false,
      );
    } finally {
      await bff.close();
    }
  });
});

test("rejects a live record whose workdir is not the scratch path", async () => {
  await withPaths(async (paths) => {
    const sandbox = createFsSandbox(paths.root);
    const store = new SessionStore({
      pi: createStubPi(),
      catalog: createAgentCatalog(),
      storeDir: paths.store,
      workspace: sandbox.workspace,
      moveSandbox: sandbox.move,
      handoffSandbox: sandbox.handoff,
    });
    try {
      await store.init();
      const record = await store.create({ spaceId: "space-0000000000000001" });
      record.workdir = ".u7agent/sessions/other";
      await assert.rejects(store.move(record.id, "default"), /セッション専用の作業フォルダ/);
      assert.deepEqual(sandbox.moves, []);
    } finally {
      await store.close();
    }
  });
});

// 引っ越しの meta 書換えが済んだ後に deleteSession が届いても、所属が変わっていたら消さない (What)
test("deleteSession keeps a conversation that moved to another space while it was waiting", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const created = await createSession(bff, { spaceId: spaceA });
      const id = created.sessionId as string;
      await writeFile(join(paths.root, sessionWorkdirRel(id, spaceA), "work.txt"), "作業中");

      // move は meta を書き換えた後にもう一度 drain する。その 2 回目の flush を止め、
      // 「所属が変わった後、move の完了前」に deleteSession が入る窓を再現する
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const enteredFlush = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writer = bff.store.get(id)!.writer!;
      const flush = writer.flush.bind(writer);
      let flushes = 0;
      writer.flush = async () => {
        flushes += 1;
        if (flushes === 2) {
          entered();
          await gate;
        }
        return flush();
      };

      const moving = moveTo(bff, id, spaceB, { fromSpace: spaceA });
      await enteredFlush;
      assert.equal(flushes, 2);
      // 確かに meta は移動済み (最後の中断確認より後)
      assert.equal(JSON.parse(await readFile(sessionMetaPath(id, paths.store), "utf8")).spaceId, spaceB);
      const deleting = bff.store.deleteSession(id, { expectSpaceId: spaceA });
      assert.equal(bff.store.deleting.has(id), true);
      release();

      assert.equal((await moving).status, 200);
      assert.equal(await deleting, false);
      // 移動先の会話は履歴フォルダを含めて残る
      assert.equal(bff.store.spaceOfId(id), spaceB);
      assert.equal(existsSync(sessionMetaPath(id, paths.store)), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt")), true);
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${spaceB}`))).sessionId, id);
    } finally {
      await bff.close();
    }
  });
});

// 削除対象へ向かう引っ越しの失敗 (ロールバック) が、根の削除より先に終わることを見る (What)
test("deleting a space waits for a move into it so the rollback keeps the other space's files", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const created = await createSession(bff, { spaceId: spaceB });
      const id = created.sessionId as string;
      // B 側に作業フォルダと添付、A 側に同じ会話 ID の添付を置き、添付の移動を 409 にする
      await writeFile(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt"), "作業中");
      await mkdir(join(paths.root, sessionUploadsRel(id, spaceB)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id, spaceB), "note.txt"), "添付");
      await mkdir(join(paths.root, sessionUploadsRel(id, spaceA)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id, spaceA), "old.txt"), "先客");

      // 作業フォルダの移動後、添付の移動で止める (409 を返す直前)
      const moveEntry = sandbox!.move.moveEntry;
      let entered = () => {};
      const enteredUploads = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sandbox!.move.moveEntry = async (from, to) => {
        if (to === sessionUploadsRel(id, spaceA)) {
          entered();
          await gate;
        }
        return moveEntry(from, to);
      };
      // 根の削除は実ファイルへ行い、呼び出しを記録する (同期していないとこの時点でファイルが消える)
      const roots: string[] = [];
      sandbox!.workspace.deleteDirectory = async (path) => {
        roots.push(path);
        await rm(join(paths.root, path), { recursive: true, force: true });
      };

      const moved = moveTo(bff, id, spaceA, { fromSpace: spaceB });
      await enteredUploads;
      const deleting = bff.app.request(`/api/spaces/${spaceA}`, { method: "DELETE" });
      try {
        // 引っ越しが止まっている間に根へ触れない (同期していなければこの間に消える)
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(roots, []);
      } finally {
        release();
      }

      // ロールバック (作業フォルダを B へ戻す) の後に根を消す = 引っ越しは 409 で B のファイルは残る
      const movedResponse = await moved;
      assert.equal(movedResponse.status, 409);
      assert.match((await jsonBody(movedResponse)).error, /退避先を削除/);
      assert.equal((await deleting).status, 200);
      assert.deepEqual(roots, [spaceDirRel(spaceA)]);
      assert.equal((await readMeta(id, paths.store)).spaceId, spaceB);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id, spaceB), "note.txt")), true);
      assert.equal(existsSync(join(paths.root, spaceDirRel(spaceA))), false);
      assert.equal(bff.store.spaceOfId(id), spaceB);
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${spaceB}`))).sessionId, id);
    } finally {
      await bff.close();
    }
  });
});

// 削除対象へ向かう引っ越しが完了した場合も、根の削除より先に完了させて回収する (What)
test("deleting a space collects a conversation that finished moving into it, leaving no files behind", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const created = await createSession(bff, { spaceId: spaceB });
      const id = created.sessionId as string;
      await writeFile(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt"), "作業中");

      // 作業フォルダの移動で止める (移動元の親が消えていれば 404 を「運ぶものが無い」と読み替える)
      const moveEntry = sandbox!.move.moveEntry;
      let entered = () => {};
      const enteredWorkdir = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sandbox!.move.moveEntry = async (from, to) => {
        if (to === sessionWorkdirRel(id, spaceA)) {
          entered();
          await gate;
        }
        return moveEntry(from, to);
      };
      const roots: string[] = [];
      sandbox!.workspace.deleteDirectory = async (path) => {
        roots.push(path);
        await rm(join(paths.root, path), { recursive: true, force: true });
      };

      const moved = moveTo(bff, id, spaceA, { fromSpace: spaceB });
      await enteredWorkdir;
      const deleting = bff.app.request(`/api/spaces/${spaceA}`, { method: "DELETE" });
      try {
        // 引っ越しが止まっている間に根へ触れない (同期していなければこの間に消える)
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(roots, []);
      } finally {
        release();
      }

      // 引っ越しは完了し、対象スペースの会話として回収される (どちらのスペースにもファイルは残らない)
      assert.equal((await moved).status, 200);
      assert.equal((await deleting).status, 200);
      assert.equal(bff.store.spaceOfId(id), undefined);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB))), false);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceA))), false);
      assert.equal(existsSync(join(paths.root, spaceDirRel(spaceA))), false);
      assert.equal(existsSync(sessionMetaPath(id, paths.store)), false);
      assert.deepEqual(
        (await jsonBody(bff.app.request("/api/spaces"))).spaces.map((space: { id: string }) => space.id),
        ["default", spaceB],
      );
    } finally {
      await bff.close();
    }
  });
});

// 同じ会話に複数の引っ越しが重なっても、対象スペースへ向かう先行を隠さず待つことを見る (What)
test("deleting a space waits for an earlier move of the same conversation, not only the latest one", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const spaceC = await createSpace(bff, "C");
      const created = await createSession(bff, { spaceId: spaceB });
      const id = created.sessionId as string;
      await writeFile(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt"), "作業中");
      await mkdir(join(paths.root, sessionUploadsRel(id, spaceB)), { recursive: true });
      await writeFile(join(paths.root, sessionUploadsRel(id, spaceB), "note.txt"), "添付");
      // A / C の両方に同じ会話 ID の添付を置き、どちらへ送っても添付の移動が 409 になるようにする
      for (const spaceId of [spaceA, spaceC]) {
        await mkdir(join(paths.root, sessionUploadsRel(id, spaceId)), { recursive: true });
        await writeFile(join(paths.root, sessionUploadsRel(id, spaceId), "old.txt"), "先客");
      }

      // 先行 B → A の添付の移動で止める (409 を返す直前)
      const moveEntry = sandbox!.move.moveEntry;
      let entered = () => {};
      const enteredUploads = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sandbox!.move.moveEntry = async (from, to) => {
        if (to === sessionUploadsRel(id, spaceA)) {
          entered();
          await gate;
        }
        return moveEntry(from, to);
      };
      const roots: string[] = [];
      sandbox!.workspace.deleteDirectory = async (path) => {
        roots.push(path);
        await rm(join(paths.root, path), { recursive: true, force: true });
      };

      const first = moveTo(bff, id, spaceA, { fromSpace: spaceB });
      await enteredUploads;
      // 後続 (B → C) が store.move に登録されるのを待ってから削除する (先行の登録を上書きする位置)
      const firstLifecycle = bff.store.lifecycle.get(id);
      const second = moveTo(bff, id, spaceC, { fromSpace: spaceB });
      await waitFor(() => bff.store.lifecycle.get(id) !== firstLifecycle, 3000, "second move registration");
      const deleting = bff.app.request(`/api/spaces/${spaceA}`, { method: "DELETE" });
      try {
        // 先行が止まっている間に根へ触れない (先行の待機対象が失われていればこの間に消える)
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(roots, []);
      } finally {
        release();
      }

      // 先行のロールバックが終わってから根を消す = 先行は 409 で B のファイルは残る (後続も 409)
      const firstResponse = await first;
      assert.equal(firstResponse.status, 409);
      assert.match((await jsonBody(firstResponse)).error, /退避先を削除/);
      assert.equal((await second).status, 409);
      assert.equal((await deleting).status, 200);
      assert.deepEqual(roots, [spaceDirRel(spaceA)]);
      assert.equal((await readMeta(id, paths.store)).spaceId, spaceB);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceB), "work.txt")), true);
      assert.equal(existsSync(join(paths.root, sessionUploadsRel(id, spaceB), "note.txt")), true);
      assert.equal(existsSync(join(paths.root, spaceDirRel(spaceA))), false);
      assert.equal(bff.store.spaceOfId(id), spaceB);
      assert.equal((await jsonBody(bff.app.request(`/api/sessions/${id}?spaceId=${spaceB}`))).sessionId, id);
    } finally {
      await bff.close();
    }
  });
});

// 対象スペースからの引っ越し中に DELETE が来ても、移動先 (他会話スペース) の会話を壊さない (What)
test("deleting a space during a move out of it keeps the other space intact", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const spaceA = await createSpace(bff, "A");
      const spaceB = await createSpace(bff, "B");
      const moving = await createSession(bff, { spaceId: spaceA });
      const keep = await createSession(bff, { spaceId: spaceB });
      await writeFile(join(paths.root, sessionWorkdirRel(moving.sessionId, spaceA), "work.txt"), "作業中");
      await writeFile(join(paths.root, sessionWorkdirRel(keep.sessionId, spaceB), "keep.txt"), "残す");

      // 引っ越しの物理移動を止め、DELETE が claim と deleteSession の待ちに入る状態を作る
      let entered = () => {};
      const enteredMove = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const moveEntry = sandbox!.move.moveEntry;
      sandbox!.move.moveEntry = async (from, to) => {
        entered();
        await gate;
        return moveEntry(from, to);
      };

      const moved = moveTo(bff, moving.sessionId, spaceB, { fromSpace: spaceA });
      await enteredMove;
      const deleting = bff.app.request(`/api/spaces/${spaceA}`, { method: "DELETE" });
      try {
        await waitFor(() => bff.store.deleting.has(moving.sessionId), 3000, "delete wait");
      } finally {
        release();
      }

      assert.equal((await deleting).status, 200);
      // 引っ越しは中断され、移動元に戻った会話はスペースごと消える
      assert.equal((await moved).status, 404);
      assert.equal(bff.store.spaceOfId(moving.sessionId), undefined);
      // 移動先スペースの会話とファイルは無傷
      assert.equal(bff.store.spaceOfId(keep.sessionId), spaceB);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(keep.sessionId, spaceB), "keep.txt")), true);
      assert.equal(
        (await jsonBody(bff.app.request(`/api/sessions/${keep.sessionId}?spaceId=${spaceB}`))).sessionId,
        keep.sessionId,
      );
      assert.deepEqual(
        (await jsonBody(bff.app.request("/api/spaces"))).spaces.map((space: { id: string }) => space.id),
        ["default", spaceB],
      );
    } finally {
      await bff.close();
    }
  });
});

test("hands off within the same space: new agent, memo, identity kept, and the chip is consumed by the first send", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const agent = (await jsonBody(await bff.app.request("/api/agents", jsonPost({ name: "調査と実装" })))).agent;
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "最初の依頼" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      await bff.app.request(`/api/sessions/${id}/title`, jsonPatch({ title: "引き継ぐ会話" }));
      await bff.app.request(`/api/sessions/${id}/pin`, jsonPatch({ pinned: true }));
      await bff.app.request(`/api/sessions/${id}/notify`, jsonPatch({ notify: true }));
      const before = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      await writeFile(join(paths.root, sessionWorkdirRel(id), "note.md"), "作業ファイル");

      const response = await moveTo(bff, id, "default", { agentId: agent.id, memo: true });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        sessionId: id,
        title: "引き継ぐ会話",
        spaceId: "default",
        memo: true,
        cleanupPending: false,
      });

      // 作業フォルダはその場のまま、履歴だけが消える
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id), "note.md")), true);
      assert.equal(existsSync(sessionJsonlPath(id, paths.store)), false);
      assert.equal(existsSync(sessionSendsPath(id, paths.store)), false);

      const payload = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.deepEqual(payload.messages, []);
      assert.equal(payload.agent.id, agent.id);
      assert.equal(payload.agent.name, "調査と実装");
      assert.equal(payload.model, before.model);
      assert.equal(payload.thinkingLevel, before.thinkingLevel);
      assert.equal(payload.title, "引き継ぐ会話");
      assert.equal(payload.pinned, true);
      assert.equal(payload.notify, true);
      assert.equal(payload.createdAt, before.createdAt);
      assert.equal(payload.handoff.memo, true);
      assert.equal(payload.handoff.consumed, false);
      assert.equal(payload.handoff.cleanupPending, false);
      assert.equal(payload.handoff.operationId.length, 8);

      const memo = await readFile(join(paths.root, sessionWorkdirRel(id), HANDOFF_FILE_NAME), "utf8");
      assert.match(memo, /^# 引き継ぎメモ \(本文ハッシュ: [0-9a-f]{16}\)\n/, "見出しと本文ハッシュが先頭に無い");
      assert.ok(memo.includes("引き継ぎ: 汎用アシスタント → 調査と実装"), "引き継ぎ元 → 先が出ていない");
      assert.ok(memo.includes("元の会話タイトル: 引き継ぐ会話"), "元のタイトルが無い");
      assert.ok(memo.includes("### user\n\n最初の依頼"), "user の発言が無い");
      assert.ok(memo.includes("### assistant\n\nスタブの返答です"), "assistant の応答が無い");
      assert.ok(memo.endsWith("この続きをお願いします。\n\n"), "末尾の依頼行が無い");

      // 送信で消費済みが立ち、その場で保存される (未送信の破棄では戻らない)
      assert.equal((await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "続き" }))).status, 202);
      const accepted = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(accepted.handoff.consumed, true);
      // 消費の印はその場で保存する (書込みは実行と同じ直列に乗るため、drain してからファイルを見る)
      await bff.store.flush(bff.store.get(id)!);
      assert.equal(((await readMeta(id, paths.store)).handoff as { consumed: boolean }).consumed, true);

      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "post-handoff run");
      const after = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(after.agent.id, agent.id, "引き継ぎ後の会話が新しいエージェントで動いていない");
      assert.deepEqual(
        after.messages.map((message: { role: string }) => message.role),
        ["user", "assistant"],
      );
      const summary = (await jsonBody(bff.app.request("/api/sessions"))).sessions.find(
        (item: { sessionId: string }) => item.sessionId === id,
      );
      assert.equal(summary.title, "引き継ぐ会話");
      assert.equal(summary.pinned, true);
      assert.equal(summary.notify, true);
      assert.equal(summary.canHandoff, true);
      assert.equal(summary.handoffCleanup, undefined);
      assert.equal((await readMeta(id, paths.store)).handoffCleanup, undefined);
    } finally {
      await bff.close();
    }
  });
});

test("rejects unknown agents and a memo without material before any side effect", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;

      const unknown = await moveTo(bff, id, space, { agentId: "agent-0000000000000000" });
      assert.equal(unknown.status, 400);
      assert.match((await jsonBody(unknown)).error, /Agent not found/);

      const noMaterial = await moveTo(bff, id, space, { memo: true });
      assert.equal(noMaterial.status, 400);
      assert.match((await jsonBody(noMaterial)).error, /メモにできる会話がまだありません/);

      // どちらも会話の状態とファイルを変えない
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
      assert.equal((await readMeta(id, paths.store)).handoff, undefined);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), false);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"), HANDOFF_FILE_NAME)), false);

      // メモ OFF の 0 件は既存どおり移せる
      assert.equal((await moveTo(bff, id, space)).status, 200);
    } finally {
      await bff.close();
    }
  });
});

test(
  "rejects an unreadable existing memo before moving anything",
  { skip: IS_ROOT && "root can read a directory without search permission" },
  async () => {
    await withPaths(async (paths) => {
      const { bff, sandbox } = await openBff(paths);
      try {
        const space = await createSpace(bff, "デモ");
        const created = await createSession(bff);
        const id = created.sessionId as string;
        await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
        await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
        const workdir = join(paths.root, sessionWorkdirRel(id));
        await writeFile(join(workdir, HANDOFF_FILE_NAME), "# 既存のメモ\n");
        // 検索権限を外すと、既存メモの読み取りが EACCES になる
        await chmod(workdir, 0o600);
        try {
          const response = await moveTo(bff, id, space, { memo: true });
          assert.equal(response.status, 400);
          assert.match((await jsonBody(response)).error, /読めないためメモを作れません/);
        } finally {
          await chmod(workdir, 0o700);
        }
        // 下準備で止まる: フォルダを動かさず、meta も変えない (移動は rollback も含めて 0 回)
        assert.equal(sandbox!.moves.length, 0, "メモを読めないのに移動を始めている");
        assert.equal((await readMeta(id, paths.store)).spaceId, "default");
        assert.equal(await readFile(join(workdir, HANDOFF_FILE_NAME), "utf8"), "# 既存のメモ\n");
        // メモを外せば同じ要求を通せる (利用者の逃げ道)
        assert.equal((await moveTo(bff, id, space, { memo: false })).status, 200);
      } finally {
        await bff.close();
      }
    });
  },
);

test("rejects a memo from a damaged history but still moves without a memo", async () => {
  await withPaths(async (paths) => {
    const first = await openBff(paths);
    const created = await createSession(first.bff);
    const id = created.sessionId as string;
    await first.bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "壊れる前の会話" }));
    await waitFor(() => first.bff.store.statusOf(first.bff.store.get(id)!) === "completed", 5000, "run completion");
    await first.bff.close();
    await writeFile(sessionJsonlPath(id, paths.store), "壊れた行\n");

    const offline = await openBff(paths, { pi: null });
    const space = await createSpace(offline.bff, "デモ");
    try {
      const damaged = await moveTo(offline.bff, id, space, { memo: true });
      assert.equal(damaged.status, 400);
      assert.match((await jsonBody(damaged)).error, /メモ/);
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
      // メモ OFF は SDK を開かず、未認証・壊れた JSONL でも移せる (既存の契約)
      assert.equal((await moveTo(offline.bff, id, space)).status, 200);
    } finally {
      await offline.bff.close();
    }
  });
});

test("resolves an explicitly named agent again, even when it is the current one", async () => {
  await withPaths(async (paths) => {
    const pi = createStubPi();
    const { bff } = await openBff(paths, { pi });
    try {
      const agent = (await jsonBody(await bff.app.request("/api/agents", jsonPost({ name: "調査と実装" })))).agent;
      const created = await createSession(bff, { agentId: agent.id });
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "最初の依頼" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");

      // 定義を更新してから、同じ id を明示して引き継ぐ。保存済みの古いスナップショットは使わない
      assert.equal(
        (await bff.app.request(`/api/agents/${agent.id}`, jsonPatch({ name: "調査と実装 (改)" }))).status,
        200,
      );
      const same = await moveTo(bff, id, "default", { agentId: agent.id });
      assert.equal(same.status, 200);
      const payload = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(payload.agent.name, "調査と実装 (改)", "明示した id が解決し直されていない");

      // 復元で SDK セッションを作るときも新しいスナップショットを使う
      const restored = pi.createInputs.at(-1) as { promptSnapshot?: { agent: string } } | undefined;
      assert.match(restored?.promptSnapshot?.agent ?? "", /調査と実装 \(改\)/, "スナップショットが古いまま");

      // 削除済みの id を明示した要求は 400 (省略なら保存済みを維持できる)
      assert.equal((await bff.app.request(`/api/agents/${agent.id}`, { method: "DELETE" })).status, 200);
      const missing = await moveTo(bff, id, "default", { agentId: agent.id });
      assert.equal(missing.status, 400);
      assert.match((await jsonBody(missing)).error, /Agent not found/);
    } finally {
      await bff.close();
    }
  });
});

test("retries a memo at the size limit when the same hash is already at the head", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");

      // 既存のメモへの追記は、meta の書換えが失敗しても残る (rollback の対象は新規作成だけ)
      const memoPath = join(paths.root, sessionWorkdirRel(id), HANDOFF_FILE_NAME);
      await writeFile(memoPath, "# 手書き\n");
      const metaPath = sessionMetaPath(id, paths.store);
      const metaText = await readFile(metaPath, "utf8");
      await settleWrites(bff, id);
      await replaceMetaWithDirectory(metaPath);
      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 500);
      await rm(metaPath, { recursive: true });
      await writeFile(metaPath, metaText);

      // 全文をちょうど上限まで膨らませる (以前は再試行の事前判定が追記分を足して 400 になっていた)
      const memo = await readFile(memoPath, "utf8");
      await writeFile(memoPath, memo + "x".repeat(HANDOFF_MAX_BYTES - Buffer.byteLength(memo, "utf8")));
      assert.equal((await readFile(memoPath)).byteLength, HANDOFF_MAX_BYTES);

      const writes = sandbox!.handoffWrites.length;
      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 200);
      // 先頭の見出しが同じなので追記せず、上限も唯の読取りとして満たす
      assert.equal(sandbox!.handoffWrites.length, writes, "同じハッシュの節を追記している");
      assert.equal((await readFile(memoPath)).byteLength, HANDOFF_MAX_BYTES);
      assert.equal((await readFile(memoPath, "utf8")).split("# 引き継ぎメモ").length - 1, 1, "節が二重になっている");
    } finally {
      await bff.close();
    }
  });
});

test("keeps a memo that another conversation appended to before the rollback", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    // 共有 cwd (プロジェクト) の別の会話が、メモの新規作成と rollback の間に追記を成功させた状態を作る
    const handoff = sandbox!.handoff;
    const write = handoff.writeHandoff;
    handoff.writeHandoff = async (input) => {
      const result = await write(input);
      if (result.created) {
        const other = "# 引き継ぎメモ (本文ハッシュ: 9999)\n\n別の会話\n\nこの続きをお願いします。\n\n";
        await writeFile(
          join(paths.root, input.path),
          `${other}${await readFile(join(paths.root, input.path), "utf8")}`,
        );
      }
      return result;
    };
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");

      // meta の書換えを失敗させ、新規作成したメモの rollback を走らせる
      const metaPath = sessionMetaPath(id, paths.store);
      const metaText = await readFile(metaPath, "utf8");
      await settleWrites(bff, id);
      await replaceMetaWithDirectory(metaPath);
      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 500);
      await rm(metaPath, { recursive: true });
      await writeFile(metaPath, metaText);

      // 内容が変わっているので削除しない (別の会話の追記を巻き戻さない)
      const memo = await readFile(join(paths.root, sessionWorkdirRel(id), HANDOFF_FILE_NAME), "utf8");
      assert.ok(memo.includes("別の会話"), "別の会話の追記が消えている");
      assert.equal(sandbox!.handoffRollbacks.at(-1)?.deleted, false, "内容が変わっているのに削除している");
    } finally {
      await bff.close();
    }
  });
});

test("keeps the consumed mark on disk before answering, so a discard cannot revive the chip", async () => {
  await withPaths(async (paths) => {
    // 1) 材料のある会話を作る (この BFF は正常に走る)
    const first = await openBff(paths);
    const created = await createSession(first.bff);
    const id = created.sessionId as string;
    await first.bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
    await waitFor(() => first.bff.store.statusOf(first.bff.store.get(id)!) === "completed", 5000, "run completion");
    await first.bff.close();

    // 2) 受理した送信が user entry を積む前に失敗する状態で引き継ぎと送信を行う
    const failing = await openBff(paths, {
      pi: createStubPi({ promptFailureBeforeUser: "No API key for stub/model", promptFailuresBeforeUser: 1 }),
    });
    try {
      assert.equal((await moveTo(failing.bff, id, "default", { memo: true })).status, 200);
      const sent = await failing.bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "続き" }));
      assert.equal(sent.status, 202);
      const runId = ((await sent.json()) as { runId: string }).runId;
      // ディスクの meta は応答の時点で消費済み (flush を待たない)
      assert.equal(((await readMeta(id, paths.store)).handoff as { consumed: boolean }).consumed, true);
      await waitFor(() => failing.bff.store.statusOf(failing.bff.store.get(id)!) !== "running", 5000, "run failure");
      assert.equal(
        (await failing.bff.app.request(`/api/sessions/${id}/unsent/${runId}`, { method: "DELETE" })).status,
        200,
      );
      assert.equal(((await readMeta(id, paths.store)).handoff as { consumed: boolean }).consumed, true);
    } finally {
      await failing.bff.close();
    }

    // 3) 再起動してもチップは戻らない
    const second = await openBff(paths);
    try {
      const payload = await jsonBody(second.bff.app.request(`/api/sessions/${id}`));
      assert.equal(payload.handoff.consumed, true, "再起動でチップが戻っている");
    } finally {
      await second.bff.close();
    }
  });
});

test("waits for the running consumed-mark save before answering a later send", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 200);
      // 引き継ぎは live の記録を捨てるため、開き直してから送信する (送信はこの記録の保存を待つ)
      assert.equal((await bff.app.request(`/api/sessions/${id}`)).status, 200);

      // 保存キューを止める。印の保存が終わらない間に別タブ相当の送信を入れても、後続は 202 を返せない
      const record = bff.store.get(id)!;
      assert.ok(record, "引き継ぎ後の会話が live に残っていない");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      record.persistTail = gate;
      const first = bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "1 通目" }));
      let laterAnswered = false;
      const later = Promise.resolve(bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "2 通目" }))).then(
        (response) => {
          laterAnswered = true;
          return response;
        },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(laterAnswered, false, "後続の送信が保存を待たずに 202 を返している");
      } finally {
        // 失敗しても close が止まらないように待ちを解く
        release();
      }
      assert.equal((await first).status, 202);
      assert.equal((await later).status, 202);
      assert.equal(((await readMeta(id, paths.store)).handoff as { consumed: boolean }).consumed, true);
    } finally {
      await bff.close();
    }
  });
});

test("answers 500 instead of 202 when the consumed mark cannot be saved", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 200);

      // meta の保存を失敗させる。印を保存できないまま受理を返すと、再起動でチップが戻る
      const metaPath = sessionMetaPath(id, paths.store);
      const metaText = await readFile(metaPath, "utf8");
      await settleWrites(bff, id);
      await replaceMetaWithDirectory(metaPath);
      try {
        const response = await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "続き" }));
        assert.equal(response.status, 500, "保存できないのに 202 を返している");
        assert.match((await jsonBody(response)).error, /保存に失敗しました/);
      } finally {
        await rm(metaPath, { recursive: true });
        await writeFile(metaPath, metaText);
      }

      // 失敗した印は次の受理でやり直す。保存を待ってから 202 を返し、ディスクにも載る
      const record = bff.store.get(id);
      assert.ok(record, "送信後の会話が live に残っていない");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      record.persistTail = gate;
      let retryAnswered = false;
      const retry = Promise.resolve(
        bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "もう一度" })),
      ).then((response) => {
        retryAnswered = true;
        return response;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(retryAnswered, false, "失敗した印をやり直さずに 202 を返している");
      } finally {
        release();
      }
      assert.equal((await retry).status, 202);
      assert.equal(((await readMeta(id, paths.store)).handoff as { consumed: boolean }).consumed, true);
    } finally {
      await bff.close();
    }
  });
});

test("prepends the memo, keeps the existing HANDOFF.md, and masks secrets", async () => {
  await withPaths(async (paths) => {
    const previousKey = process.env[SECRET_MASTER_KEY_ENV];
    process.env[SECRET_MASTER_KEY_ENV] = `1:${Buffer.alloc(32, 9).toString("base64")}`;
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      const secret = "dummy-handoff-secret-0123456789";
      assert.equal(
        (
          await bff.app.request(
            "/api/secrets",
            jsonPost({ sessionId: id, kind: "secret", name: "API_KEY", value: secret }),
          )
        ).status,
        200,
      );
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: `キーは ${secret} です` }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      // 利用者の手書きのメモを残したまま先頭へ追記する
      const existing = "# 既存のメモ\n\n消えないでください\n";
      await writeFile(join(paths.root, sessionWorkdirRel(id), HANDOFF_FILE_NAME), existing);

      assert.equal((await moveTo(bff, id, "default", { memo: true })).status, 200);
      const memo = await readFile(join(paths.root, sessionWorkdirRel(id), HANDOFF_FILE_NAME), "utf8");
      assert.match(memo, /^# 引き継ぎメモ/);
      assert.ok(memo.indexOf("## 直近のやり取り") < memo.indexOf("# 既存のメモ"), "新しい節が先頭に無い");
      assert.ok(memo.endsWith(existing), "既存の中身が変わっている");
      assert.equal(memo.includes(secret), false, "秘密の値がメモに残っている");
      assert.ok(memo.includes("[REDACTED]"), "秘密の値がマスクされていない");
    } finally {
      if (previousKey === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
      else process.env[SECRET_MASTER_KEY_ENV] = previousKey;
      await bff.close();
    }
  });
});

test("restores the state when the memo write fails, and keeps an appended memo when the meta write fails", async () => {
  await withPaths(async (paths) => {
    const { bff, sandbox } = await openBff(paths);
    try {
      const space = await createSpace(bff, "デモ");
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "材料" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");

      // メモの書込み失敗: 作業フォルダを移さず、meta も変えずに 400 で返す
      sandbox!.handoffFailures.push({
        path: join(sessionWorkdirRel(id, space), HANDOFF_FILE_NAME),
        error: new SandboxRequestError("書けません", 400),
      });
      const failed = await moveTo(bff, id, space, { memo: true });
      assert.equal(failed.status, 400);
      assert.equal((await readMeta(id, paths.store)).spaceId, "default");
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), false);
      sandbox!.handoffFailures.length = 0;

      // meta の書込み失敗: 新規作成したメモを自分が書いた内容と一致するときだけ削除する
      const metaPath = sessionMetaPath(id, paths.store);
      const metaText = await readFile(metaPath, "utf8");
      await settleWrites(bff, id);
      await replaceMetaWithDirectory(metaPath);
      const metaFailed = await moveTo(bff, id, space, { memo: true });
      assert.equal(metaFailed.status, 500);
      await rm(metaPath, { recursive: true });
      await writeFile(metaPath, metaText);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, "default"))), true);
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, space))), false);
      assert.equal(
        existsSync(join(paths.root, sessionWorkdirRel(id, "default"), HANDOFF_FILE_NAME)),
        false,
        "新規作成したメモが残っている",
      );

      // 既存の HANDOFF.md への追記は、meta の失敗で戻さない (他の追記を巻き戻さない)
      const existing = "# 手書き\n";
      await writeFile(join(paths.root, sessionWorkdirRel(id, "default"), HANDOFF_FILE_NAME), existing);
      await settleWrites(bff, id);
      await replaceMetaWithDirectory(metaPath);
      assert.equal((await moveTo(bff, id, space, { memo: true })).status, 500);
      await rm(metaPath, { recursive: true });
      await writeFile(metaPath, metaText);
      const memo = await readFile(join(paths.root, sessionWorkdirRel(id, "default"), HANDOFF_FILE_NAME), "utf8");
      assert.ok(memo.startsWith("# 引き継ぎメモ"), "追記が残っていない");
      assert.ok(memo.endsWith(existing), "既存の中身が失われている");
    } finally {
      await bff.close();
    }
  });
});

test("answers success with cleanupPending when the history removal fails, and cleans up on the next open", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await bff.app.request(`/api/sessions/${id}/messages`, jsonPost({ text: "履歴" }));
      await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, "run completion");
      // session.jsonl をディレクトリに差し替え、rm (force・非再帰) を失敗させる
      const jsonl = sessionJsonlPath(id, paths.store);
      await rm(jsonl);
      await mkdir(jsonl);

      const response = await moveTo(bff, id, "default", { memo: false });
      assert.equal(response.status, 200);
      const result = (await response.json()) as { cleanupPending?: boolean };
      assert.equal(result.cleanupPending, true);
      const meta = await readMeta(id, paths.store);
      assert.equal(meta.handoffCleanup, true);

      // 片付けが残っている間は開けない (一覧には残る)。DELETE は可能
      assert.equal((await bff.app.request(`/api/sessions/${id}`)).status, 409);
      assert.equal(
        (await jsonBody(bff.app.request("/api/sessions"))).sessions.some(
          (item: { sessionId: string }) => item.sessionId === id,
        ),
        true,
      );
      // 新しい引き継ぎも先に片付けを求める 409
      assert.equal((await moveTo(bff, id, "default")).status, 409);

      // 障害を取り除くと、開くときに片付けてから SDK セッションを作る
      await rm(jsonl, { recursive: true });
      assert.equal((await bff.app.request(`/api/sessions/${id}`)).status, 200);
      assert.equal((await readMeta(id, paths.store)).handoffCleanup, undefined);
      // 古い履歴は残らず、空の履歴で開き直せる
      assert.deepEqual((await jsonBody(bff.app.request(`/api/sessions/${id}`))).messages, []);
    } finally {
      await bff.close();
    }
  });
});
