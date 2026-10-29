// 会話の分岐 (POST /api/sessions/:id/fork)。親の末尾までの entry を複製した独立した子を作り、
// 元の会話と作業フォルダ / 添付を共有することを検証する。サンドボックスは実ファイルシステムのスタブ。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { sessionUploadsRel, sessionWorkdirRel } from "../src/app-paths";
import { SessionMoveResponseSchema, type TitleAttempt } from "../src/schema";
import type { SandboxHandoffClient, SandboxMoveClient, SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import { HANDOFF_FILE_NAME } from "../src/handoff-memo";
import { parseSessionFile, sessionJsonlPath, sessionMetaPath } from "../src/session-store";
import { createServeSandboxStub } from "./serve-stub";
import { STUB_PLAIN_MODEL, asPiBff, createStubPi, waitFor, type StubPiOptions } from "./stub-pi";

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

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * 実ファイルシステムを workspace root にするスタブ。作業フォルダの mkdir / 一覧と、引き継ぎの
 * move / HANDOFF.md の読み書きだけを実装する (分岐はこの 2 つを共有の確認に使う)。
 */
function createFsSandbox(root: string) {
  const abs = (path: string) => (path ? join(root, path) : root);
  const created: string[] = [];
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => {
      const entries = await readdir(abs(path), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new SandboxRequestError(`Path not found: ${path}`, 404);
        throw error;
      });
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
      created.push(path);
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
      const source = abs(from);
      if (!(await pathExists(source))) throw new SandboxRequestError(`Path not found: ${from}`, 404);
      if (await pathExists(abs(to))) throw new SandboxRequestError(`Already exists: ${to}`, 409);
      await rename(source, abs(to));
      return { path: to };
    },
  };
  const handoff: SandboxHandoffClient = {
    readHandoff: async (path: string) => ({
      text: await readFile(abs(path), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new SandboxRequestError(`Path not found: ${path}`, 404);
        throw error;
      }),
    }),
    writeHandoff: async ({ path, section, dedupeKey }) => {
      const target = abs(path);
      const existing = await readFile(target, "utf8").catch(() => undefined);
      const firstLine = existing === undefined ? "" : (existing.split("\n", 1)[0] ?? "");
      if (dedupeKey !== "" && firstLine.includes(dedupeKey)) return { path, written: false, created: false };
      await writeFile(target, `${section}${existing ?? ""}`, "utf8");
      return { path, written: true, created: existing === undefined };
    },
    rollbackHandoff: async () => ({ deleted: false }),
  };
  return { workspace, move, handoff, created };
}

async function withPaths<T>(run: (paths: { root: string; store: string }) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-sessions-fork-"));
  try {
    return await run({ root: join(base, "workspace"), store: join(base, "store") });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function openBff(paths: { root: string; store: string }, options: { pi?: ReturnType<typeof createStubPi> } = {}) {
  const sandbox = createFsSandbox(paths.root);
  const pi = options.pi ?? createStubPi();
  const bff = await createBffApp({
    cwd: paths.root,
    sessionStoreDir: paths.store,
    pi: asPiBff(pi),
    workspace: sandbox.workspace,
    moveSandbox: sandbox.move,
    handoffSandbox: sandbox.handoff,
    serveSandbox: createServeSandboxStub().sandbox,
    // 停止中の状態を既定にする (このファイルはサービスの稼働を扱わない)
    serveProbe: async () => false,
  });
  return { bff, sandbox, pi };
}

type Harness = Awaited<ReturnType<typeof openBff>>["bff"];

async function createSession(bff: Harness, body: Record<string, unknown> = {}): Promise<any> {
  const response = await bff.app.request("/api/sessions", jsonPost(body));
  assert.equal(response.status, 201);
  return response.json();
}

async function sendText(bff: Harness, id: string, text: string, spaceId?: string): Promise<void> {
  const query = spaceId ? `?spaceId=${spaceId}` : "";
  const response = await bff.app.request(`/api/sessions/${id}/messages${query}`, jsonPost({ text }));
  assert.equal(response.status, 202);
  await waitFor(() => bff.store.statusOf(bff.store.get(id)!) === "completed", 5000, `run: ${text}`);
}

async function fork(bff: Harness, id: string, body: Record<string, unknown> = {}) {
  return bff.app.request(`/api/sessions/${id}/fork`, jsonPost(body));
}

async function readMeta(id: string, store: string): Promise<any> {
  return JSON.parse(await readFile(sessionMetaPath(id, store), "utf8")) as any;
}

/** JSONL の entry 列 (header を除く)。分岐の複製をそのまま比べるために使う */
async function entriesOfFile(id: string, store: string): Promise<unknown[]> {
  const parsed = parseSessionFile(await readFile(sessionJsonlPath(id, store), "utf8"), id);
  assert.equal(parsed.kind, "ok");
  return parsed.kind === "ok" ? parsed.entries : [];
}

/** 比較に使う payload.messages。metrics は揮発値なので落とす */
function comparableMessages(payload: { messages: Array<Record<string, unknown>> }): unknown[] {
  return payload.messages.map((message) => {
    const copy: Record<string, unknown> = { ...message };
    delete copy.metrics;
    return copy;
  });
}

/** 比較に使う compactions。reason / estimatedTokensAfter / durationMs は BFF のメモリ由来で揃わない */
function comparableCompactions(payload: { compactions: Array<Record<string, unknown>> }): unknown[] {
  return payload.compactions.map((compaction) => {
    const copy: Record<string, unknown> = { ...compaction };
    delete copy.reason;
    delete copy.estimatedTokensAfter;
    delete copy.durationMs;
    return copy;
  });
}

test("分岐は親の末尾までの履歴と圧縮を複製し、再起動後も両方開ける", async () => {
  await withPaths(async (paths) => {
    const pi = createStubPi({ manualCompactions: [{ summarizeCount: 2 }] });
    const { bff } = await openBff(paths, { pi });
    let id = "";
    let childId = "";
    try {
      const created = await createSession(bff);
      id = created.sessionId as string;
      await sendText(bff, id, "最初の質問");
      await sendText(bff, id, "二つ目の質問");
      // 圧縮を挟んでから、さらに 1 往復する (compaction entry と、その後の entry の両方を持つ会話)
      const compacted = await bff.app.request(`/api/sessions/${id}/compact`, { method: "POST" });
      assert.equal(compacted.status, 200);
      await sendText(bff, id, "圧縮のあとの質問");
      await bff.store.flush(bff.store.get(id)!);

      const parentBefore = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.ok(parentBefore.compactions.length > 0, "前提: 圧縮履歴を持つ会話");

      const response = await fork(bff, id);
      assert.equal(response.status, 201);
      const child = (await response.json()) as any;
      childId = child.sessionId as string;
      assert.equal(child.parentSessionId, id);
      assert.equal(child.spaceId, parentBefore.spaceId);
      assert.equal(child.cwd, parentBefore.cwd, "作業フォルダを共有する");

      // entry 列は親の接頭辞そのもの (BFF が復元時に追記する model_change は除いて比べる)
      const childEntries = await entriesOfFile(child.sessionId, paths.store);
      const parentEntries = await entriesOfFile(id, paths.store);
      const parentIds = new Set(parentEntries.map((entry) => (entry as { id: string }).id));
      assert.deepEqual(
        childEntries.filter((entry) => parentIds.has((entry as { id: string }).id)),
        parentEntries,
        "複製した entry は親と同一",
      );
      assert.deepEqual(await entriesOfFile(id, paths.store), parentEntries, "分岐で親の記録は変わらない");
      assert.deepEqual(comparableMessages(child), comparableMessages(parentBefore));
      assert.deepEqual(comparableCompactions(child), comparableCompactions(parentBefore));
      const meta = await readMeta(child.sessionId, paths.store);
      assert.equal(meta.parentSessionId, id);
      assert.equal(typeof meta.forkedAt, "number");
      assert.equal(meta.workdirOwner, id, "親の作業フォルダを指す");
      assert.equal(meta.uploadsOwner, id);
      assert.equal(meta.handoff, undefined, "引き継ぎの記録は引き継がない");
      assert.equal(meta.pinned, undefined);
      assert.equal(meta.notify, undefined);
      assert.equal(existsSync(join(paths.store, child.sessionId, "sends.json")), false, "未送信は引き継がない");

      // 親の meta は変わらない
      const parentMeta = await readMeta(id, paths.store);
      assert.equal(parentMeta.parentSessionId, undefined);
      // 応答メトリクスは派生データとして子の session_id へ複製する (失敗しても分岐は成功する)
      assert.deepEqual(
        bff.appDb.loadAssistantMetrics(child.sessionId).map((row: { assistantId: string }) => row.assistantId),
        bff.appDb.loadAssistantMetrics(id).map((row: { assistantId: string }) => row.assistantId),
      );
    } finally {
      await bff.close();
    }

    // 再起動しても両方開け、分岐関係も残る
    const reopened = await openBff(paths, { pi: createStubPi() });
    try {
      const parent = await jsonBody(reopened.bff.app.request(`/api/sessions/${id}`));
      assert.equal(parent.parentSessionId, undefined);
      const list = await jsonBody(reopened.bff.app.request("/api/sessions"));
      const listed = list.sessions.find((item: any) => item.sessionId === childId);
      assert.equal(listed.parentSessionId, id, "一覧に分岐元が載る");
      const listedParent = list.sessions.find((item: any) => item.sessionId === id);
      assert.equal(listed.messageCount, listedParent.messageCount, "一覧の表示件数も親と一致する");
      const child = await jsonBody(reopened.bff.app.request(`/api/sessions/${childId}`));
      assert.equal(child.parentSessionId, id);
      assert.deepEqual(comparableMessages(child), comparableMessages(parent));
      assert.deepEqual(comparableCompactions(child), comparableCompactions(parent));
    } finally {
      await reopened.bff.close();
    }
  });
});

test("破損した親の JSONL では分岐せず、親の記録を書き換えない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "壊す前の会話");
      await bff.store.flush(bff.store.get(id)!);
      const file = sessionJsonlPath(id, paths.store);
      // 途中の行を壊す (改行で終わる末尾は回復対象外なので、保存で上書きされ得る形にする)
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.splice(1, 1, "{壊れた行}");
      const damaged = lines.join("\n");
      await writeFile(file, damaged, "utf8");
      const before = await readFile(file, "utf8");

      const response = await fork(bff, id);
      assert.equal(response.status, 409);
      assert.match(((await jsonBody(response)) as { error: string }).error, /JSON を解析できません/);
      assert.equal(await readFile(file, "utf8"), before, "破損した原本を persist で上書きしない");
      // 半端な子を残さない (一覧にも出ない)
      const list = await jsonBody(bff.app.request("/api/sessions"));
      assert.equal(list.sessions.length, 1);
    } finally {
      await bff.close();
    }
  });
});

test("スキル展開待ちの送信は境界の後に親へ残り、子には入らない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "境界より前の質問");
      const record = bff.store.get(id)!;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // 送信ルートはスキル展開を await してから postMessage する。その待ちの間に分岐を重ねる
      const sending = (async () => {
        await gate;
        bff.store.postMessage(record, "境界より後の質問");
      })();
      const child = await bff.store.fork(record);
      release();
      await sending;
      await waitFor(() => bff.store.statusOf(record) === "completed", 5000, "run after fork");
      await bff.store.flush(record);

      const childEntries = await entriesOfFile(child.id, paths.store);
      const parentEntries = await entriesOfFile(id, paths.store);
      assert.deepEqual(
        childEntries.map((entry) => (entry as { id: string }).id),
        parentEntries.slice(0, childEntries.length).map((entry) => (entry as { id: string }).id),
        "境界までは親の接頭辞",
      );
      assert.equal(
        childEntries.some((entry) => JSON.stringify(entry).includes("境界より後の質問")),
        false,
        "境界より後の送信は子に入らない",
      );
      assert.equal(
        parentEntries.some((entry) => JSON.stringify(entry).includes("境界より後の質問")),
        true,
        "境界より後の送信は親に残る",
      );
    } finally {
      await bff.close();
    }
  });
});

test("分岐の status: busy / 片付け中 / 未知 agent / スペース不一致 / 保存失敗", async () => {
  await withPaths(async (paths) => {
    const pi = createStubPi({ chunkDelayMs: 400 });
    const { bff } = await openBff(paths, { pi });
    try {
      // 別スペースの会話を、既定スペースの要求元で分岐しようとすると 404
      const spaceId = (await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "デモ" })))).space.id as string;
      const other = await createSession(bff, { spaceId });
      assert.equal(
        (await bff.app.request(`/api/sessions/${other.sessionId}/fork`, jsonPost({}))).status,
        404,
        "スペース不一致",
      );

      const created = await createSession(bff);
      const id = created.sessionId as string;
      // 未知の agent は 400
      assert.equal((await fork(bff, id, { agentId: "no-such-agent" })).status, 400);

      // 実行中 / キュー待ちは 409
      const record = bff.store.get(id)!;
      bff.store.postMessage(record, "実行中の質問");
      bff.store.postMessage(record, "待機する質問");
      assert.equal((await fork(bff, id)).status, 409, "busy");
      await bff.store.stop(record);
      await waitFor(() => bff.store.statusOf(record) === "stopped", 5000, "stopped");

      // 片付け (handoffCleanup) が残っている会話も 409。開く経路 (resolve) は片付けを先に済ませるため、
      // 保存済みの印を持つ記録を直接渡して同じ条件を確かめる
      await bff.store.flush(record);
      const withCleanup = { ...record.meta, handoffCleanup: true as const };
      record.meta = withCleanup;
      await assert.rejects(bff.store.fork(record), /片付け/);
      assert.equal(record.meta.handoffCleanup, true, "拒否しても親の meta を変えない");
    } finally {
      await bff.close().catch(() => {});
    }
  });
});

test("保存に失敗したら 500 を返し、子を残さない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "保存に失敗させる会話");
      await bff.store.flush(bff.store.get(id)!);
      // meta.json をディレクトリへ差し替えて保存を失敗させる (非同期の保存が作り直すため収束まで試す)
      const metaPath = sessionMetaPath(id, paths.store);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await rm(metaPath, { recursive: true, force: true });
        try {
          await mkdir(metaPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await new Promise((resolveTick) => setTimeout(resolveTick, 5));
        }
      }
      const response = await fork(bff, id);
      assert.equal(response.status, 500);
      const ids = (await readdir(paths.store)).filter((name) => /^[0-9a-f]{10}$/.test(name));
      assert.deepEqual(ids, [id], "半端な子を残さない");
    } finally {
      await bff.close();
    }
  });
});

test("子への送信は親に現れず、作業フォルダと添付は共有する", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "親の質問");
      await bff.store.flush(bff.store.get(id)!);
      const parentFile = sessionJsonlPath(id, paths.store);
      const parentBytes = await readFile(parentFile, "utf8");

      const child = await jsonBody(fork(bff, id));
      const childId = child.sessionId as string;
      assert.equal(child.cwd, sessionWorkdirRel(id), "作業フォルダは親のものを共有する");

      // 子の送信は親の JSONL に現れない
      await sendText(bff, childId, "子の質問");
      await bff.store.flush(bff.store.get(childId)!);
      assert.equal(await readFile(parentFile, "utf8"), parentBytes, "子の追記が親へ混ざらない");
      const childEntries = await entriesOfFile(childId, paths.store);
      assert.equal(
        childEntries.some((entry) => JSON.stringify(entry).includes("子の質問")),
        true,
      );
      // 親の送信は子に現れない
      await sendText(bff, id, "親の続き");
      const childBytes = await readFile(sessionJsonlPath(childId, paths.store), "utf8");
      assert.equal(childBytes.includes("親の続き"), false);

      // 作業フォルダのファイルは両方から見える (同じ cwd)。添付も親の置き場へ再送できる
      const workdir = join(paths.root, sessionWorkdirRel(id));
      await writeFile(join(workdir, "shared.txt"), "共有");
      for (const sessionId of [id, childId]) {
        const listing = await jsonBody(bff.app.request(`/api/files?path=${encodeURIComponent(sessionWorkdirRel(id))}`));
        assert.equal(
          listing.entries.some((entry: { name: string }) => entry.name === "shared.txt"),
          true,
          `${sessionId} から共有フォルダが見える`,
        );
      }
      const uploadsDir = join(paths.root, sessionUploadsRel(id));
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, "photo.png"), "image");
      const attachment = `${sessionUploadsRel(id)}/photo.png`;
      for (const sessionId of [id, childId]) {
        const posted = await bff.app.request(
          `/api/sessions/${sessionId}/messages`,
          jsonPost({ text: "添付を見て", attachments: [attachment] }),
        );
        assert.equal(posted.status, 202, `${sessionId} から共有の添付を送れる`);
        await waitFor(() => bff.store.statusOf(bff.store.get(sessionId)!) === "completed", 5000, "attachment run");
      }
    } finally {
      await bff.close();
    }
  });
});

test("agentId 省略は保存済みスナップショット、指定は現在の定義から作り直す", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const agent = (await jsonBody(bff.app.request("/api/agents", jsonPost({ name: "調査役", systemPrompt: "調査" }))))
        .agent;
      const created = await createSession(bff, { agentId: agent.id });
      const id = created.sessionId as string;
      await sendText(bff, id, "調査を頼む");
      // 定義を消しても、省略時は保存済みのスナップショットで分岐できる
      assert.equal((await bff.app.request(`/api/agents/${agent.id}`, { method: "DELETE" })).status, 200);
      const kept = await jsonBody(fork(bff, id));
      const keptMeta = await readMeta(kept.sessionId, paths.store);
      assert.equal(keptMeta.agentId, agent.id);
      assert.equal(keptMeta.agent.name, "調査役");
      assert.match(keptMeta.promptSnapshot.agent, /調査/);

      // 未知 (削除済み) の id 指定は 400、既存の id 指定は新しいスナップショットになる
      assert.equal((await fork(bff, id, { agentId: agent.id })).status, 400);
      const general = (await jsonBody(bff.app.request("/api/agents"))).builtinAgent;
      const switched = await jsonBody(fork(bff, id, { agentId: general.id }));
      const switchedMeta = await readMeta(switched.sessionId, paths.store);
      assert.equal(switchedMeta.agentId, general.id);
      assert.equal(switchedMeta.agent.name, general.name);
    } finally {
      await bff.close();
    }
  });
});

test("モデル / Effort は親の実効値で始まり、子の変更は親へ波及しない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "モデルを決める会話");
      const settings = await bff.app.request(
        `/api/sessions/${id}/settings`,
        jsonPatch({ model: { provider: "stub", id: "stub-model" }, thinkingLevel: "high" }),
      );
      assert.equal(settings.status, 200);
      const parent = await jsonBody(settings);
      assert.equal(parent.model, "stub/stub-model");

      const child = await jsonBody(fork(bff, id));
      assert.equal(child.model, parent.model, "子の初期モデルは親の実効値");
      assert.equal(child.thinkingLevel, parent.thinkingLevel, "子の初期 Effort は親の実効値");

      // 子の変更は親へ波及しない
      const changed = await bff.app.request(
        `/api/sessions/${child.sessionId}/settings`,
        jsonPatch({ thinkingLevel: "low" }),
      );
      assert.equal(changed.status, 200);
      const parentAfter = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(parentAfter.thinkingLevel, parent.thinkingLevel);
      assert.equal((await readMeta(id, paths.store)).thinkingLevel, parent.thinkingLevel);
    } finally {
      await bff.close();
    }
  });
});

test("親のモデルが利用できない子は既定へ落ち、model_change を追記して再読み込みで戻らない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "使えなくなるモデル");
      assert.equal(
        (
          await bff.app.request(
            `/api/sessions/${id}/settings`,
            jsonPatch({ model: { provider: "stub", id: "stub-model" } }),
          )
        ).status,
        200,
      );
    } finally {
      await bff.close();
    }

    // 親の保存モデルを使えないランタイムで開き直す (復元と同じ規則で既定へ落ちる)
    const reopened = await openBff(paths, {
      pi: createStubPi({ availableModels: [STUB_PLAIN_MODEL], selectedModel: STUB_PLAIN_MODEL }),
    });
    try {
      const list = await jsonBody(reopened.bff.app.request("/api/sessions"));
      const parentId = list.sessions[0].sessionId as string;
      const child = await jsonBody(fork(reopened.bff, parentId));
      const entries = await entriesOfFile(child.sessionId, paths.store);
      const lastModel = [...entries].reverse().find((entry) => (entry as { type: string }).type === "model_change") as
        | { provider: string; modelId: string }
        | undefined;
      assert.ok(lastModel, "フォールバック後の実効モデルを記録する");
      assert.equal(lastModel.provider, "stub");
      assert.equal(lastModel.modelId, "stub-plain");
    } finally {
      await reopened.bff.close();
    }
  });
});

test("タイトルの試行は引き継ぎ、pending は子だけ interrupted に終端化する", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      // 試行なし: まだ 1 往復も完了していない会話は試行を持たない (子の最初の完了で 1 回だけ要約され得る)
      const fresh = await createSession(bff);
      const freshId = fresh.sessionId as string;
      await bff.app.request(`/api/sessions/${freshId}/title`, jsonPatch({ title: "継がれるタイトル" }));
      const withoutAttempt = await jsonBody(fork(bff, freshId));
      assert.equal(withoutAttempt.title, "継がれるタイトル");
      assert.equal((await readMeta(withoutAttempt.sessionId, paths.store)).titleAttempt, undefined);

      // 確定済み: そのまま複製する
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "タイトルを継ぐ会話");
      await bff.app.request(`/api/sessions/${id}/title`, jsonPatch({ title: "継がれるタイトル" }));
      await bff.store.flush(bff.store.get(id)!);
      const done: TitleAttempt = { runId: "run-done", at: 1, state: "done", trigger: "auto" };
      const record = bff.store.get(id)!;
      record.titleAttempt = done;
      record.meta = { ...record.meta, titleAttempt: done };
      const settled = await jsonBody(fork(bff, id));
      assert.equal(settled.title, "継がれるタイトル", "タイトルを引き継ぐ");
      assert.deepEqual((await readMeta(settled.sessionId, paths.store)).titleAttempt, done);

      // pending: 子だけ interrupted に終端化し、親の試行は変えない (子の最初の完了で要約し直さない)
      const pending: TitleAttempt = { runId: "run-pending", at: 2, state: "pending", trigger: "auto" };
      // 予約 (pending) のまま分岐する。fork は解決済みの record から境界と meta を読む
      record.titleAttempt = pending;
      record.meta = { ...record.meta, titleAttempt: pending };
      const pendingChild = await jsonBody(fork(bff, id));
      const childOfPending = (await readMeta(pendingChild.sessionId, paths.store)).titleAttempt;
      assert.equal(childOfPending.state, "skipped");
      assert.equal(childOfPending.skipReason, "interrupted");
      assert.equal(childOfPending.runId, "run-pending");
      assert.deepEqual(bff.store.get(id)!.meta.titleAttempt, pending, "親の試行は変えない");
    } finally {
      await bff.close();
    }
  });
});

test("workdirOwner が不正な meta は一覧に出ず、共有フォルダが無い復元は 409", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "作業フォルダを持つ会話");
      await bff.store.flush(bff.store.get(id)!);
      const meta = await readMeta(id, paths.store);
      await bff.close();

      // 10 hex 以外の owner は壊れた meta として一覧から除外する (自分の id へフォールバックしない)
      await writeFile(sessionMetaPath(id, paths.store), `${JSON.stringify({ ...meta, workdirOwner: "zzz" })}\n`);
      const broken = await openBff(paths);
      try {
        assert.deepEqual((await jsonBody(broken.bff.app.request("/api/sessions"))).sessions, []);
      } finally {
        await broken.bff.close();
      }

      // 構文上有効な owner でも、共有フォルダが無ければ空を作らず 409
      const ownerId = "ffffffffff";
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(ownerId))), false);
      await writeFile(
        sessionMetaPath(id, paths.store),
        `${JSON.stringify({ ...meta, workdirOwner: ownerId, uploadsOwner: ownerId })}\n`,
      );
      const missing = await openBff(paths);
      try {
        const response = await missing.bff.app.request(`/api/sessions/${id}`);
        assert.equal(response.status, 409);
        assert.equal(existsSync(join(paths.root, sessionWorkdirRel(ownerId))), false, "共有フォルダを勝手に作らない");
      } finally {
        await missing.bff.close();
      }
    } finally {
      await bff.close().catch(() => {});
    }
  });
});

test("共有中の会話は別スペースへ引き継げず、同一スペースの交代は子でも通る", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const spaceId = (await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "デモ" })))).space.id as string;
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "引き継ぎを試す会話");
      const child = await jsonBody(fork(bff, id));
      const childId = child.sessionId as string;
      const workdir = join(paths.root, sessionWorkdirRel(id));
      await writeFile(join(workdir, "work.txt"), "作業中");

      // 親も子も別スペースへは動かせない (共有が理由)
      for (const target of [id, childId]) {
        const response = await bff.app.request(`/api/sessions/${target}/move`, jsonPost({ spaceId }));
        assert.equal(response.status, 409, `${target} は共有中`);
        assert.match(((await jsonBody(response)) as { error: string }).error, /共有/);
      }
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id, spaceId))), false, "ファイルを動かさない");
      assert.equal(existsSync(join(workdir, "work.txt")), true);

      // 同じスペースへのエージェント交代は owner を持つ子でも通る。メモは共有フォルダへ書く
      const general = (await jsonBody(bff.app.request("/api/agents"))).builtinAgent;
      const moved = await bff.app.request(
        `/api/sessions/${childId}/move`,
        jsonPost({ spaceId: "default", agentId: general.id, memo: true }),
      );
      assert.equal(moved.status, 200);
      const result = SessionMoveResponseSchema.parse(await moved.json());
      assert.equal(result.memo, true);
      assert.equal(existsSync(join(workdir, HANDOFF_FILE_NAME)), true, "共有フォルダへメモを書く");

      // メモ OFF の交代は HANDOFF.md を作成・変更しない
      const before = await readFile(join(workdir, HANDOFF_FILE_NAME), "utf8");
      const again = await bff.app.request(
        `/api/sessions/${childId}/move`,
        jsonPost({ spaceId: "default", agentId: general.id }),
      );
      assert.equal(again.status, 200);
      assert.equal(await readFile(join(workdir, HANDOFF_FILE_NAME), "utf8"), before);
    } finally {
      await bff.close();
    }
  });
});

test("親を削除しても子は開け、スペース削除は両方を消す", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "親を消す会話");
      const child = await jsonBody(fork(bff, id));
      const childId = child.sessionId as string;

      assert.equal((await bff.app.request(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
      const reopened = await jsonBody(bff.app.request(`/api/sessions/${childId}`));
      assert.equal(reopened.parentSessionId, id, "分岐元が消えても関係は残る");
      assert.ok(reopened.messages.length >= 2, "子はそのまま使える");
      // 親が消えても作業フォルダは残る
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(id))), true);

      // スペース削除は会話ストア・作業フォルダごと消す
      const spaceId = (await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "消すスペース" })))).space
        .id as string;
      const inSpace = await createSession(bff, { spaceId });
      const parentInSpace = inSpace.sessionId as string;
      await sendText(bff, parentInSpace, "スペースごと消す会話", spaceId);
      const childInSpace = await jsonBody(
        bff.app.request(`/api/sessions/${parentInSpace}/fork?spaceId=${spaceId}`, jsonPost({})),
      );
      assert.equal((await bff.app.request(`/api/spaces/${spaceId}`, { method: "DELETE" })).status, 200);
      for (const removed of [parentInSpace, childInSpace.sessionId]) {
        assert.equal(existsSync(join(paths.store, removed)), false, "存在中の会話ストアも消える");
      }
      assert.equal(existsSync(join(paths.root, sessionWorkdirRel(parentInSpace, spaceId))), false);
    } finally {
      await bff.close();
    }
  });
});

test("分岐の途中で親を削除しても半端な子を残さない", async () => {
  await withPaths(async (paths) => {
    const { bff } = await openBff(paths);
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "競合させる会話");
      const record = bff.store.get(id)!;
      // 分岐と親の削除を重ねる (分岐は途中で 404 になり得る)
      const forking = bff.store.fork(record).catch((error: unknown) => error);
      const deleting = bff.store.deleteSession(id);
      const [forked] = await Promise.all([forking, deleting]);
      if (forked instanceof Error) {
        assert.match(forked.message, /Session not found|分岐先の会話/);
      }
      // どちらに転んでも、残った会話は store と descriptor が揃っている
      const ids = (await readdir(paths.store)).filter((name) => /^[0-9a-f]{10}$/.test(name));
      assert.deepEqual(
        ids.sort(),
        bff.store
          .list()
          .map((item) => item.sessionId)
          .sort(),
      );
      for (const sessionId of ids) {
        assert.equal(existsSync(join(paths.store, sessionId, "meta.json")), true);
        assert.equal(existsSync(join(paths.store, sessionId, "session.jsonl")), true);
      }
      assert.deepEqual(
        (await readdir(paths.store)).filter((name) => name.startsWith(".fork-")),
        [],
        "temp を残さない",
      );
    } finally {
      await bff.close();
    }
  });
});

test("子の load に失敗したら子を回収し、親はそのまま開ける", async () => {
  await withPaths(async (paths) => {
    const stubOptions: StubPiOptions = {};
    const pi = createStubPi(stubOptions);
    const { bff } = await openBff(paths, { pi });
    try {
      const created = await createSession(bff);
      const id = created.sessionId as string;
      await sendText(bff, id, "子の復元に失敗させる会話");
      await bff.store.flush(bff.store.get(id)!);
      // 子の SDK セッション作成だけを失敗させる
      stubOptions.createSessionRejects = 1;
      const response = await fork(bff, id);
      assert.notEqual(response.status, 201);
      const ids = (await readdir(paths.store)).filter((name) => /^[0-9a-f]{10}$/.test(name));
      assert.deepEqual(ids, [id], "store だけの子を残さない");
      assert.deepEqual(
        bff.store.list().map((item) => item.sessionId),
        [id],
      );
      // 親は変わらず開けて、分岐し直せる
      const parent = await jsonBody(bff.app.request(`/api/sessions/${id}`));
      assert.equal(parent.messages.length >= 2, true);
      const retried = await fork(bff, id);
      assert.equal(retried.status, 201);
    } finally {
      await bff.close();
    }
  });
});
