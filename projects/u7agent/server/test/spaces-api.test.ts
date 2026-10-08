import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBffApp } from "../src/app";
import { APP_DB_FILENAME } from "../src/app-db";
import { sessionMetaPath, sessionJsonlPath } from "../src/session-store";
import { sessionUploadsRel, sessionWorkdirRel } from "../src/app-paths";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SessionPayload, Space } from "../src/schema";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";
import { createServeSandboxStub } from "./serve-stub";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

function fixtureWorkspace() {
  const dirs: string[] = [];
  const uploads: string[] = [];
  const skillDirs: string[] = [];
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    listFiles: async (path) => ({ path, entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async (dir) => {
      skillDirs.push(dir);
      return { skills: [] };
    },
    createDir: async (path) => {
      dirs.push(path);
      return { path };
    },
    renameEntry: async (path, name) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ dir, name }) => {
      uploads.push(dir);
      return { path: `${dir}/${name}`, name, renamed: false, size: 1 };
    },
    rawFile: async () => ({ contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
  return { workspace, dirs, uploads, skillDirs };
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-spaces-"));
  const workspace = fixtureWorkspace();
  const pi = createStubPi({ chunkDelayMs: 10 });
  const sandbox = createServeSandboxStub();
  const options = {
    cwd: "/tmp/spaces-workspace",
    sessionStoreDir: dir,
    workspace: workspace.workspace,
    pi: asPiBff(pi),
    serveSandbox: sandbox.sandbox,
    serveProbe: async () => sandbox.state.listener !== null,
  };
  let bff = await createBffApp(options);
  t.after(async () => {
    await bff.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    pi,
    sandbox,
    ...workspace,
    get bff() {
      return bff;
    },
    restart: async () => {
      await bff.close();
      bff = await createBffApp(options);
    },
    space: async (name: string): Promise<Space> => {
      const res = await bff.app.request("/api/spaces", json({ name }));
      assert.equal(res.status, 201);
      return (await jsonBody(res)).space;
    },
    session: async (spaceId = "default"): Promise<SessionPayload> => {
      const res = await bff.app.request("/api/sessions", json({ spaceId }));
      assert.equal(res.status, 201);
      return jsonBody(res);
    },
  };
}

test("通常と複数スペースの一覧・所属・cwd・添付は live / sweep / 再起動で一致する", async (t) => {
  const f = await setup(t);
  const a = await f.space("デモ A");
  const b = await f.space("デモ B");
  const sessions = [await f.session(), await f.session(a.id), await f.session(b.id)];
  const verify = async () => {
    for (const [index, spaceId] of ["default", a.id, b.id].entries()) {
      const expected = sessions[index];
      const res = await f.bff.app.request(`/api/sessions?spaceId=${spaceId}`);
      const list = (await jsonBody(res)).sessions;
      assert.deepEqual(
        list.map((item: SessionPayload) => [item.sessionId, item.spaceId]),
        [[expected.sessionId, spaceId]],
      );
      assert.equal(f.bff.store.workdirOfId(expected.sessionId), sessionWorkdirRel(expected.sessionId, spaceId));
      const payload = await jsonBody(f.bff.app.request(`/api/sessions/${expected.sessionId}?spaceId=${spaceId}`));
      assert.equal(payload.spaceId, spaceId);
      assert.equal(payload.cwd, expected.cwd);
      const uploaded = await f.bff.app.request(
        `/api/sessions/${expected.sessionId}/files?spaceId=${spaceId}&name=a.txt`,
        { method: "POST", body: "a" },
      );
      assert.equal(uploaded.status, 201);
      assert.equal((await jsonBody(uploaded)).path, `${sessionUploadsRel(expected.sessionId, spaceId)}/a.txt`);
    }
    assert.deepEqual(
      (await jsonBody(f.bff.app.request("/api/sessions"))).sessions.map((item: SessionPayload) => item.sessionId),
      [sessions[0].sessionId],
    );
    assert.deepEqual(
      (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((space: Space) => space.id),
      ["default", a.id, b.id],
    );
  };
  await verify();
  for (const session of sessions) f.bff.store.get(session.sessionId)!.lastUsedAt = 0;
  await f.bff.store.sweep();
  assert.ok(sessions.every((session) => !f.bff.store.get(session.sessionId)));
  await verify();
  await f.restart();
  assert.ok(sessions.every((session) => !f.bff.store.get(session.sessionId)));
  await verify();
  assert.equal(f.bff.store.titleOfId(sessions[1].sessionId), "無題のセッション");
});

test("v13 DB と所属欠落の会話は加算移行し、既存のカタログ・キー・プロジェクトを保持する", async (t) => {
  const f = await setup(t);
  f.bff.appDb.insertProject({ id: "p", name: "既存", cwd: "proj", createdAt: 1 });
  f.bff.appDb.saveProviderCredential("stub", "existing-test-key", 1);
  const session = await f.session();
  await f.bff.close();
  const meta = JSON.parse(await readFile(sessionMetaPath(session.sessionId, f.dir), "utf8"));
  delete meta.spaceId;
  await writeFile(sessionMetaPath(session.sessionId, f.dir), JSON.stringify(meta));
  const db = new DatabaseSync(join(f.dir, APP_DB_FILENAME));
  db.exec("DROP TABLE spaces; PRAGMA user_version = 13");
  db.close();
  await f.restart();
  assert.equal(f.bff.appDb.getProject("p")?.cwd, "proj");
  assert.equal(f.bff.appDb.getProviderCredential("stub")?.apiKey, "existing-test-key");
  assert.equal(f.bff.appDb.getAgent("agent-zundamon")?.name, "ずんだもん");
  const list = await jsonBody(f.bff.app.request("/api/sessions"));
  assert.equal(list.sessions[0].spaceId, "default");
  const payload = await jsonBody(f.bff.app.request(`/api/sessions/${session.sessionId}`));
  assert.equal(payload.cwd, `.u7agent/sessions/${session.sessionId}`);
  assert.equal(payload.spaceId, "default");
  assert.equal((await f.space("移行後")).name, "移行後");
});

test("所属不一致の全 API と SSE は SDK 復元・作業生成・会話変更の前に 404 で拒否する", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const session = await f.session(space.id);
  await f.restart();
  const created = f.pi.sessions.length;
  const dirs = f.dirs.length;
  const before = await readFile(sessionMetaPath(session.sessionId, f.dir), "utf8");
  const prefix = `/api/sessions/${session.sessionId}`;
  for (const [suffix, init] of [
    ["", undefined],
    ["/history", undefined],
    ["/events", undefined],
    ["/skills", undefined],
    ["/settings", json({ thinkingLevel: "low" }, "PATCH")],
    ["/title", json({ title: "変更" }, "PATCH")],
    ["/notify", json({ notify: true }, "PATCH")],
    ["/pin", json({ pinned: true }, "PATCH")],
    ["", { method: "DELETE" }],
    ["/stop", { method: "POST" }],
    ["/abort", { method: "POST" }],
    ["/compact", { method: "POST" }],
    ["/messages", json({ text: "送信" })],
    ["/messages", json({ resendRunId: "run" })],
    ["/unsent/run", { method: "DELETE" }],
    ["/questions/tool/answer", json({ answers: [] })],
    ["/files?name=a.txt", { method: "POST", body: "a" }],
  ] as Array<[string, RequestInit | undefined]>) {
    assert.equal((await f.bff.app.request(prefix + suffix, init)).status, 404, suffix);
  }
  const encoded = `${prefix.slice(0, prefix.lastIndexOf("/") + 1)}%${session.sessionId.charCodeAt(0).toString(16)}${session.sessionId.slice(1)}`;
  assert.equal((await f.bff.app.request(encoded)).status, 404);
  for (const path of ["/api/secrets", "/api/secrets/secret", "/api/serve/status"]) {
    assert.equal((await f.bff.app.request(`${path}?sessionId=${session.sessionId}`)).status, 404);
  }
  for (const path of ["/api/serve/start", "/api/serve/stop", "/api/secrets"]) {
    assert.equal(
      (await f.bff.app.request(path, json({ sessionId: session.sessionId, kind: "variable", name: "X", value: "v" })))
        .status,
      404,
    );
  }
  assert.equal(
    (await f.bff.app.request("/api/secrets/secret", json({ sessionId: session.sessionId, value: "v" }, "PUT"))).status,
    404,
  );
  assert.equal(
    (await f.bff.app.request(`/api/secrets/secret?sessionId=${session.sessionId}`, { method: "DELETE" })).status,
    404,
  );
  assert.equal(f.pi.sessions.length, created);
  assert.equal(f.dirs.length, dirs);
  assert.equal(f.bff.store.get(session.sessionId), undefined);
  assert.equal(await readFile(sessionMetaPath(session.sessionId, f.dir), "utf8"), before);
  const normal = await f.session();
  assert.equal((await f.bff.app.request(`/api/sessions/${normal.sessionId}?spaceId=${space.id}`)).status, 404);
});

test("未知・不正スペースと追加スペースのプロジェクト利用は副作用なしで拒否する", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  f.bff.appDb.insertProject({ id: "p", name: "既存", cwd: "proj", createdAt: 1 });
  const dirs = f.dirs.length;
  assert.deepEqual((await jsonBody(f.bff.app.request(`/api/projects?spaceId=${space.id}`))).projects, []);
  for (const request of [
    f.bff.app.request(`/api/projects?spaceId=${space.id}`, json({ cwd: "new-proj", create: true })),
    f.bff.app.request(`/api/projects/p?spaceId=${space.id}`, { method: "DELETE" }),
    f.bff.app.request("/api/sessions", json({ spaceId: space.id, projectId: "p" })),
    f.bff.app.request(`/api/skills/session?spaceId=${space.id}&projectId=p`),
    f.bff.app.request(`/api/secrets?spaceId=${space.id}&projectId=p`),
    f.bff.app.request(
      `/api/secrets?spaceId=${space.id}`,
      json({ projectId: "p", kind: "variable", name: "X", value: "v" }),
    ),
  ])
    assert.equal((await request).status, 400);
  for (const [id, status] of [
    ["../bad", 400],
    ["", 400],
    ["space-0000000000000000", 404],
  ] as const) {
    const query = `?spaceId=${encodeURIComponent(id)}`;
    for (const path of [
      "/api/sessions",
      "/api/projects",
      "/api/skills/session",
      "/api/secrets",
      "/api/serve/status",
      "/api/sessions/0000000000/events",
    ]) {
      assert.equal((await f.bff.app.request(path + query)).status, status, path);
    }
    assert.equal((await f.bff.app.request("/api/sessions", json({ spaceId: id }))).status, status);
  }
  assert.equal((await f.bff.app.request("/api/spaces", json({ name: "  " }))).status, 400);
  assert.equal((await f.bff.app.request("/api/spaces", json({ name: "x".repeat(81) }))).status, 400);
  assert.equal(f.dirs.length, dirs);
  assert.equal(f.pi.sessions.length, 0);
  assert.equal(f.bff.projects.get("p")?.cwd, "proj");
});

test("追加スペースの送信は同スペースの添付だけを許容し、環境変数は未ロードでも同じ cwd を使う", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const session = await f.session(space.id);
  const base = `/api/sessions/${session.sessionId}/messages?spaceId=${space.id}`;
  assert.equal(
    (await f.bff.app.request(base, json({ text: "x", attachments: [`.u7agent/uploads/${session.sessionId}/a.txt`] })))
      .status,
    400,
  );
  assert.equal(
    (
      await f.bff.app.request(
        base,
        json({ text: "x", attachments: [`${sessionUploadsRel(session.sessionId, space.id)}/a.txt`] }),
      )
    ).status,
    202,
  );
  const record = f.bff.store.get(session.sessionId)!;
  await waitFor(() => f.bff.store.statusOf(record) === "completed", 3000, "stub completion");
  assert.match(
    String(record.session.messages[0].content),
    new RegExp(`/tmp/spaces-workspace/\\.u7agent/spaces/${space.id}/uploads/${session.sessionId}/a.txt`),
  );
  await f.restart();
  assert.equal(f.bff.store.get(session.sessionId), undefined);
  const secret = await f.bff.app.request(
    `/api/secrets?spaceId=${space.id}`,
    json({ sessionId: session.sessionId, kind: "variable", name: "DEMO", value: "v" }),
  );
  assert.equal(secret.status, 200);
  assert.equal(f.bff.appDb.listSecrets(session.cwd)[0]?.name, "DEMO");
  assert.equal(f.bff.store.get(session.sessionId), undefined);
  const skills = await f.bff.app.request(`/api/sessions/${session.sessionId}/skills?spaceId=${space.id}`);
  assert.equal(skills.status, 200);
  assert.equal((await jsonBody(skills)).projectSkills, false);
  assert.ok(f.skillDirs.includes(".agents/skills"));
  assert.ok(!f.skillDirs.some((dir) => dir.includes("/spaces/")));
});

test("DB 障害でも通常の live 停止・削除と壊れた未ロード JSONL の削除は通る", async (t) => {
  const f = await setup(t);
  const damaged = await f.session();
  const space = await f.space("デモ");
  const demo = await f.session(space.id);
  await f.restart();
  await writeFile(sessionJsonlPath(damaged.sessionId, f.dir), "broken\n");
  const live = await f.session();
  f.bff.store.postMessage(f.bff.store.get(live.sessionId)!, "実行中");
  const created = f.pi.sessions.length;
  f.bff.appDb.close();
  assert.equal((await f.bff.app.request(`/api/sessions/${live.sessionId}/stop`, { method: "POST" })).status, 200);
  assert.equal((await f.bff.app.request(`/api/sessions/${live.sessionId}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.bff.app.request(`/api/sessions/${damaged.sessionId}`, { method: "DELETE" })).status, 200);
  assert.equal(f.pi.sessions.length, created);
  assert.equal((await f.bff.app.request("/api/spaces")).status, 503);
  assert.equal((await f.bff.app.request("/api/sessions")).status, 503);
  for (const path of ["/api/secrets", "/api/serve/start", "/api/serve/stop"]) {
    const res = await f.bff.app.request(
      `${path}?spaceId=${space.id}`,
      json({ sessionId: demo.sessionId, kind: "variable", name: "X", value: "v" }),
    );
    assert.equal(res.status, 503);
    assert.equal((await jsonBody(res)).state, "not_stored");
  }
});

test("不正な保存所属は通常へ読み替えない", async (t) => {
  const f = await setup(t);
  const session = await f.session();
  await f.bff.close();
  const meta = JSON.parse(await readFile(sessionMetaPath(session.sessionId, f.dir), "utf8"));
  meta.spaceId = null;
  await writeFile(sessionMetaPath(session.sessionId, f.dir), JSON.stringify(meta));
  await f.restart();
  assert.deepEqual(f.bff.store.list("default"), []);
  assert.equal((await f.bff.app.request(`/api/sessions/${session.sessionId}`)).status, 404);
});

test("サービスは復元前でも追加スペースの cwd を使い、共有所有者は通常からも正しく表示する", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const demo = await f.session(space.id);
  const normal = await f.session();
  f.bff.appDb.saveServeCommand({ cwd: demo.cwd, command: "pnpm dev", updatedAt: 1 });
  await f.bff.store.setTitle(demo.sessionId, "デモのサービス");
  await f.restart();
  const created = f.pi.sessions.length;
  const start = await f.bff.app.request(`/api/serve/start?spaceId=${space.id}`, json({ sessionId: demo.sessionId }));
  assert.equal(start.status, 200);
  assert.equal(f.sandbox.state.launched[0].workdir, demo.cwd);
  const status = await jsonBody(f.bff.app.request(`/api/serve/status?sessionId=${normal.sessionId}`));
  assert.deepEqual(status.owner, { kind: "other", title: "デモのサービス" });
  const runtime = await jsonBody(f.bff.app.request("/api/serve/runtime/status"));
  assert.deepEqual(runtime.owner, { sessionId: demo.sessionId, title: "デモのサービス" });
  assert.equal(f.pi.sessions.length, created);
  assert.equal(f.bff.store.get(demo.sessionId), undefined);
  const stop = await f.bff.app.request(
    `/api/serve/stop?spaceId=${space.id}`,
    json({ sessionId: demo.sessionId, generation: status.generation }),
  );
  assert.equal(stop.status, 200);
});

test("作成の本文は Content-Type によらず同じ所属を検証し、不正 JSON は 400 を返す", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const res = await f.bff.app.request("/api/sessions?spaceId=default", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ spaceId: space.id }),
  });
  assert.equal(res.status, 201);
  assert.equal((await jsonBody(res)).spaceId, space.id);
  for (const path of ["/api/sessions", "/api/serve/start", "/api/secrets", "/api/spaces"]) {
    assert.equal(
      (await f.bff.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))
        .status,
      400,
    );
  }
});
