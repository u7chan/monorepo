// セッションのピン留めが meta.json に保存され、SDK・最終使用時刻・所属を変えないことを検証する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionPinnedResponseSchema } from "../src/schema";
import { sessionMetaPath } from "../src/session-store";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

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

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
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

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-sessions-pin-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openBff(dir: string, options: { pi?: ReturnType<typeof createStubPi> | null } = {}) {
  return createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: dir,
    pi: options.pi === undefined ? asPiBff(createStubPi()) : options.pi === null ? null : asPiBff(options.pi),
    workspace: stubWorkspace(),
  });
}

async function readMeta(id: string, dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionMetaPath(id, dir), "utf8")) as Record<string, unknown>;
}

test("live pin changes only pinned metadata and both endpoints return the small DTO", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      assert.equal(created.pinned, false);
      const lastUsedAt = created.lastUsedAt as number;

      const pinnedResponse = await bff.app.request(
        `/api/sessions/${created.sessionId}/pin`,
        jsonPatch({ pinned: true }),
      );
      assert.equal(pinnedResponse.status, 200);
      const pinned = SessionPinnedResponseSchema.parse(await pinnedResponse.json());
      assert.deepEqual(pinned, { sessionId: created.sessionId, pinned: true });
      assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].pinned, true);
      const payload = await jsonBody(bff.app.request(`/api/sessions/${created.sessionId}`));
      assert.equal(payload.pinned, true);
      assert.equal(payload.lastUsedAt, lastUsedAt, "ピン留めで最終使用時刻が変わった");
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true);

      const unpinnedResponse = await bff.app.request(
        `/api/sessions/${created.sessionId}/pin`,
        jsonPatch({ pinned: false }),
      );
      assert.deepEqual(await jsonBody(unpinnedResponse), { sessionId: created.sessionId, pinned: false });
      assert.equal((await readMeta(created.sessionId, dir)).pinned, undefined, "false の古い値を meta に残した");
      assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].pinned, false);
    } finally {
      await bff.close();
    }
  });
});

test("unloaded sessions pin without restoring the SDK and missing metadata defaults to false", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    const oldMeta = await readMeta(created.sessionId, dir);
    delete oldMeta.pinned;
    await writeFile(sessionMetaPath(created.sessionId, dir), JSON.stringify(oldMeta));

    const offline = await openBff(dir, { pi: null });
    try {
      assert.equal((await jsonBody(offline.app.request("/api/sessions"))).sessions[0].pinned, false);
      const response = await offline.app.request(`/api/sessions/${created.sessionId}/pin`, jsonPatch({ pinned: true }));
      assert.equal(response.status, 200);
      assert.deepEqual(await jsonBody(response), { sessionId: created.sessionId, pinned: true });
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true);
      assert.equal((await jsonBody(offline.app.request("/api/sessions"))).sessions[0].pinned, true);
    } finally {
      await offline.close();
    }
  });
});

test("unloaded title, pin, and notification writes preserve every value when requested together", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    const offline = await openBff(dir, { pi: null });
    try {
      const results = await Promise.all([
        offline.store.setTitle(created.sessionId, "renamed"),
        offline.store.setPinned(created.sessionId, true),
        offline.store.setNotify(created.sessionId, true),
      ]);
      assert.deepEqual(results, [
        { sessionId: created.sessionId, title: "renamed" },
        { sessionId: created.sessionId, pinned: true },
        { sessionId: created.sessionId, notify: true },
      ]);

      const summary = (await jsonBody(offline.app.request("/api/sessions"))).sessions[0];
      assert.equal(summary.title, "renamed");
      assert.equal(summary.pinned, true);
      assert.equal(summary.notify, true);
      assert.deepEqual(
        (({ title, pinned, notify }) => ({ title, pinned, notify }))(await readMeta(created.sessionId, dir)),
        { title: "renamed", pinned: true, notify: true },
      );
    } finally {
      await offline.close();
    }

    const restarted = await openBff(dir, { pi: null });
    try {
      const summary = (await jsonBody(restarted.app.request("/api/sessions"))).sessions[0];
      assert.equal(summary.title, "renamed");
      assert.equal(summary.pinned, true);
      assert.equal(summary.notify, true);
    } finally {
      await restarted.close();
    }
  });
});

test("a restore started during an unloaded pin write receives the updated metadata", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    const pi = createStubPi();
    const createSession = pi.createSession;
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    pi.createSession = async (input) => {
      markStarted();
      await gate;
      return createSession(input);
    };

    const bff = await openBff(dir, { pi });
    try {
      const pinning = bff.store.setPinned(created.sessionId, true);
      const restoring = bff.store.resolve(created.sessionId);
      await pinning;
      await started;
      release();
      const record = await restoring;
      assert.equal(record?.pinned, true);
      assert.equal(bff.store.list()[0]?.pinned, true);
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true);
    } finally {
      release();
      await bff.close();
    }
  });
});

test("pin state survives restore, later full saves, and project unregistration", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir, { pi: createStubPi({ chunkDelayMs: 5 }) });
    try {
      const project = await jsonBody(bff.app.request("/api/projects", jsonPost({ cwd: "project-a", create: true })));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ projectId: project.project.id })));
      await bff.app.request(`/api/sessions/${created.sessionId}/pin`, jsonPatch({ pinned: true }));
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true);

      const removed = await bff.app.request(`/api/projects/${project.project.id}`, { method: "DELETE" });
      assert.equal(removed.status, 200);
      const unassigned = (await jsonBody(bff.app.request("/api/sessions"))).sessions[0];
      assert.equal(unassigned.pinned, true);
      assert.equal(unassigned.projectId, undefined);

      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "後続保存" }));
      const record = bff.store.records.get(created.sessionId);
      await waitFor(() => bff.store.statusOf(record!) === "completed");
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true, "後続 persist が pinned を消した");
      assert.equal(bff.store.payload(record!).lastUsedAt > created.lastUsedAt, true);
    } finally {
      await bff.close();
    }
  });
});

test("pin is allowed while a chat is running and does not alter lastUsedAt", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir, { pi: createStubPi({ chunkDelayMs: 80 }) });
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "実行中に固定" }));
      const record = bff.store.records.get(created.sessionId);
      assert.equal(bff.store.statusOf(record!), "running");
      const lastUsedAt = record!.lastUsedAt;

      const response = await bff.app.request(`/api/sessions/${created.sessionId}/pin`, jsonPatch({ pinned: true }));
      assert.equal(response.status, 200);
      assert.equal((await jsonBody(response)).pinned, true);
      assert.equal(record!.lastUsedAt, lastUsedAt);
      await waitFor(() => bff.store.statusOf(record!) === "completed");
      assert.equal((await readMeta(created.sessionId, dir)).pinned, true);
    } finally {
      await bff.close();
    }
  });
});

test("pin storage failures return 500 for live and unloaded sessions", async () => {
  await withStoreDir(async (dir) => {
    const live = await openBff(dir);
    const created = await jsonBody(live.app.request("/api/sessions", jsonPost({})));
    const livePath = sessionMetaPath(created.sessionId, dir);
    await rm(livePath, { force: true });
    await mkdir(livePath);
    const liveResponse = await live.app.request(`/api/sessions/${created.sessionId}/pin`, jsonPatch({ pinned: true }));
    assert.equal(liveResponse.status, 500, "live の保存失敗を成功にした");
    assert.match((await jsonBody(liveResponse)).error, /セッションの保存に失敗しました/);
    assert.equal(live.store.records.get(created.sessionId)?.pinned, false, "失敗した値を live state に残した");
    await live.close();
  });

  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    const offline = await openBff(dir, { pi: null });
    try {
      const path = sessionMetaPath(created.sessionId, dir);
      const originalMeta = await readFile(path, "utf8");
      await rm(path, { force: true });
      await mkdir(path);
      const response = await offline.app.request(`/api/sessions/${created.sessionId}/pin`, jsonPatch({ pinned: true }));
      assert.equal(response.status, 500, "未ロードの保存失敗を成功にした");

      await rm(path, { recursive: true, force: true });
      await writeFile(path, originalMeta);
      const recovered = await offline.app.request(
        `/api/sessions/${created.sessionId}/notify`,
        jsonPatch({ notify: true }),
      );
      assert.equal(recovered.status, 200, "先行失敗後の meta 更新キューが継続しなかった");
      assert.equal((await readMeta(created.sessionId, dir)).notify, true);
    } finally {
      await offline.close();
    }
  });
});

test("pin request validates its body and rejects unknown sessions", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const invalid = await bff.app.request("/api/sessions/missing/pin", jsonPatch({}));
      assert.equal(invalid.status, 400);
      const missing = await bff.app.request("/api/sessions/missing/pin", jsonPatch({ pinned: true }));
      assert.equal(missing.status, 404);
    } finally {
      await bff.close();
    }
  });
});
