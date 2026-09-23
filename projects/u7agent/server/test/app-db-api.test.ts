// アプリデータの SQLite を HTTP から見た契約 (health / 503 / 再起動後の保持) を検証する。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

function isServiceUnavailable(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 503;
}

/** /api/projects が使うサンドボックスの stub。作成だけ受ける */
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
  };
}

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-app-db-api-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("health reports the app db path", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.deepEqual(health.appDb, { path: join(dir, APP_DB_FILENAME), ok: true });
    await bff.close();
  });
});

test("projects and agents survive a restart", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: null,
      workspace: stubWorkspace(),
    });
    const created = await jsonBody(first.app.request("/api/projects", jsonPost({ cwd: "proj-a" })));
    const agent = await jsonBody(first.app.request("/api/agents", jsonPost({ name: "レビュアー", systemPrompt: "x" })));
    assert.equal(created.project.cwd, "proj-a");
    await first.close();

    // 同じディレクトリを開き直す = 再起動
    const second = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const projects = await jsonBody(second.app.request("/api/projects"));
    const agents = await jsonBody(second.app.request("/api/agents"));
    assert.deepEqual(
      projects.projects.map((project: { cwd: string }) => project.cwd),
      ["proj-a"],
    );
    assert.deepEqual(
      agents.agents.map((entry: { id: string }) => entry.id).sort(),
      ["agent-zundamon", agent.agent.id].sort(),
    );
    await second.close();
  });
});

test("an unusable store dir makes app data 503 without an in-memory fallback", async () => {
  const cwd = "/tmp/project";
  // ワークスペースの中を store に指定するとパス解決で失敗する (会話ストアと同じ扱い)
  const previous = process.env.PI_SESSION_STORE;
  process.env.PI_SESSION_STORE = join(cwd, "inside-workspace");
  const bff = await createBffApp({ cwd, pi: null, workspace: null });
  if (previous === undefined) delete process.env.PI_SESSION_STORE;
  else process.env.PI_SESSION_STORE = previous;

  const health = await jsonBody(bff.app.request("/api/health"));
  assert.equal(health.sessionStore.ok, false);
  assert.equal(health.appDb.ok, false);
  assert.ok(health.appDb.error);

  const appDataUrls: [string, RequestInit | undefined][] = [
    ["/api/agents", undefined],
    ["/api/skills", undefined],
    ["/api/projects", undefined],
    ["/api/projects/p1", { method: "DELETE" }],
    ["/api/sessions", undefined],
    ["/api/sessions", jsonPost({})],
    ["/api/sessions/unknown", undefined],
    [
      "/api/sessions/unknown/settings",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" },
    ],
    ["/api/sessions/unknown/messages", jsonPost({ text: "hi" })],
    ["/api/sessions/unknown/events", undefined],
  ];
  for (const [url, init] of appDataUrls) {
    const response = await bff.app.request(url, init);
    assert.equal(response.status, 503, url);
    assert.match((await jsonBody(response)).error, /アプリデータ/, url);
  }

  // 会話ストアだけで完結する操作は DB を必要としない (未知の id なので 404)
  assert.equal((await bff.app.request("/api/sessions/unknown/stop", { method: "POST" })).status, 404);
  assert.equal((await bff.app.request("/api/sessions/unknown", { method: "DELETE" })).status, 404);
  await bff.close();
});

test("a payload build fails loudly when the app db becomes unavailable", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: stubWorkspace(),
    });
    const project = await jsonBody(bff.app.request("/api/projects", jsonPost({ cwd: "proj-a" })));
    await bff.app.request("/api/sessions", jsonPost({ projectId: project.project.id }));

    // SSE の resync は payload 経由で所属プロジェクトを解決する。DB が落ちたら
    // 未所属へ落として配信を続けず、例外 (503) にして接続を終わらせる
    bff.appDb.close();
    await assert.rejects(() => bff.store.releaseProject("proj-a"), isServiceUnavailable);
    await bff.close();
  });
});
