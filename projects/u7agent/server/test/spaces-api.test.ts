import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBffApp } from "../src/app";
import { APP_DB_FILENAME } from "../src/app-db";
import { sessionMetaPath, sessionJsonlPath } from "../src/session-store";
import { sessionUploadsRel, sessionWorkdirRel, spaceDirRel } from "../src/app-paths";
import { SandboxRequestError } from "../src/sandbox/client";
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
  const deletedDirs: string[] = [];
  // 先頭から 1 件ずつ消化する削除失敗 (途中失敗と再試行の再現用)
  const deleteFailures: Error[] = [];
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
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
    deleteDirectory: async (path) => {
      deletedDirs.push(path);
      const failure = deleteFailures.shift();
      if (failure) throw failure;
    },
    uploadFile: async ({ dir, name }) => {
      uploads.push(dir);
      return { path: `${dir}/${name}`, name, renamed: false, size: 1 };
    },
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment",
      body: null,
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  };
  return { workspace, dirs, uploads, skillDirs, deletedDirs, deleteFailures };
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

test("既定と複数スペースの一覧・所属・cwd・添付は live / sweep / 再起動で一致する", async (t) => {
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

test("並べ替えは正規化した順を保存し、既定スペースを先頭に固定する", async (t) => {
  const f = await setup(t);
  const a = await f.space("デモ A");
  const b = await f.space("デモ B");
  const c = await f.space("デモ C");
  const order = async () => (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((space: Space) => space.id);
  const reorder = (ids: unknown) => f.bff.app.request("/api/spaces/order", json({ ids }, "PATCH"));
  assert.deepEqual(await order(), ["default", a.id, b.id, c.id]);

  // 既定スペース・未知の id・重複は捨て、渡されなかった行は元の相対順で末尾に回す (400 にしない)
  const res = await reorder(["default", c.id, "unknown", c.id, a.id]);
  assert.equal(res.status, 200);
  const saved = (await jsonBody(res)).spaces as Space[];
  assert.deepEqual(
    saved.map((space) => space.id),
    ["default", c.id, a.id, b.id],
    "応答は正規化後の一覧で、これが以後の GET と一致する",
  );
  assert.deepEqual(Object.keys(saved[0]), ["id", "name", "createdAt"], "sortOrder は応答に出さない");
  assert.deepEqual(await order(), ["default", c.id, a.id, b.id]);

  // `[]` と全件未知は現行順のまま (並びを変えない)
  for (const ids of [[], ["unknown"]]) {
    assert.deepEqual(
      (await jsonBody(await reorder(ids))).spaces.map((space: Space) => space.id),
      ["default", c.id, a.id, b.id],
    );
  }

  // 再起動しても並びは残り、追加は末尾に付く
  await f.restart();
  assert.deepEqual(await order(), ["default", c.id, a.id, b.id]);
  const d = await f.space("デモ D");
  assert.deepEqual(await order(), ["default", c.id, a.id, b.id, d.id]);
});

test("並べ替えの入力不正は 400 にし、更新の失敗は 503 で 1 つも書かない", async (t) => {
  const f = await setup(t);
  const a = await f.space("デモ A");
  const b = await f.space("デモ B");
  const c = await f.space("デモ C");
  const order = async () => (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((space: Space) => space.id);
  const patch = (body: unknown) => f.bff.app.request("/api/spaces/order", json(body, "PATCH"));
  const before = await order();

  // ids が無い / 配列でない / 文字列以外を含む / 件数超過は 400 (順序は変わらない)
  for (const body of [
    {},
    { ids: "x" },
    { ids: [a.id, 1] },
    { ids: Array.from({ length: 201 }, (_, index) => `space-${index.toString(16).padStart(16, "0")}`) },
  ]) {
    const res = await patch(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await jsonBody(res)).error, "Invalid request body");
  }
  assert.equal((await f.bff.app.request("/api/spaces/order", { method: "PATCH", body: "not json" })).status, 400);
  assert.deepEqual(await order(), before);

  // 2 件目の更新だけを失敗させる (部分適用が残れば a -> c の順が崩れる)
  const raw = new DatabaseSync(join(f.dir, APP_DB_FILENAME));
  raw.exec(
    `CREATE TRIGGER boom BEFORE UPDATE OF sortOrder ON spaces WHEN NEW.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  );
  raw.close();
  const failed = await patch({ ids: [c.id, b.id, a.id] });
  assert.equal(failed.status, 503);
  // 失敗の後も読める (成功した読取で status の失敗は解除される)。並びは 1 つも書かれていない
  assert.deepEqual(await order(), before);
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
    ["/queue/run", { method: "DELETE" }],
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

test("DB 障害でも既定スペースの live 停止・削除と壊れた未ロード JSONL の削除は通る", async (t) => {
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

test("不正な保存所属は既定へ読み替えない", async (t) => {
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

test("サービスは復元前でも追加スペースの cwd を使い、共有所有者は既定からも正しく表示する", async (t) => {
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
  // 起動元の所属スペースを載せ、保存値が別でもリンクがそのスペースで開ける
  assert.deepEqual(runtime.owner, { sessionId: demo.sessionId, title: "デモのサービス", spaceId: space.id });
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

const deleteSpace = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
  f.bff.app.request(`/api/spaces/${encodeURIComponent(id)}`, { method: "DELETE" });

// 会話の状態ごとに、削除が SDK の復元や JSONL の読取に依存しないことを見る (What)
test("スペース削除は live / 実行中 / 未ロード / sweep 後 / 壊れた JSONL の会話をまとめて消す", async (t) => {
  const f = await setup(t);
  const states: Array<[string, (sessionId: string) => Promise<void>]> = [
    ["live", async () => {}],
    [
      "実行中",
      async (sessionId) => {
        f.bff.store.postMessage(f.bff.store.get(sessionId)!, "実行中");
        assert.equal(f.bff.store.statusOf(f.bff.store.get(sessionId)!), "running");
      },
    ],
    ["未ロード (再起動後)", async () => void (await f.restart())],
    [
      "sweep 後",
      async (sessionId) => {
        f.bff.store.get(sessionId)!.lastUsedAt = 0;
        await f.bff.store.sweep();
        assert.equal(f.bff.store.get(sessionId), undefined);
      },
    ],
    [
      "壊れた JSONL",
      async (sessionId) => {
        await writeFile(sessionJsonlPath(sessionId, f.dir), "broken\n");
        await f.restart();
      },
    ],
  ];
  for (const [name, prepare] of states) {
    const space = await f.space(`消す ${name}`);
    const session = await f.session(space.id);
    await prepare(session.sessionId);
    assert.equal(f.bff.store.spaceOfId(session.sessionId), space.id, name);
    const response = await deleteSpace(f, space.id);
    assert.equal(response.status, 200, name);
    assert.deepEqual(await jsonBody(response), { ok: true }, name);
    assert.equal(f.bff.store.spaceOfId(session.sessionId), undefined, name);
    assert.deepEqual(f.bff.store.list(space.id), [], name);
    assert.equal(existsSync(sessionMetaPath(session.sessionId, f.dir)), false, name);
  }
});

test("スペース削除は既定 400、不正 400、未知 404 を副作用なしで返す", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const deleted = f.deletedDirs.length;
  const created = f.pi.sessions.length;
  for (const [id, status] of [
    ["default", 400],
    ["%20", 400],
    ["../bad", 400],
    ["space-0000000000000000", 404],
    ["space-0123456789abcde", 400],
  ] as const) {
    assert.equal((await deleteSpace(f, id)).status, status, id);
  }
  assert.equal(f.deletedDirs.length, deleted);
  assert.equal(f.pi.sessions.length, created);
  assert.deepEqual(
    (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((item: Space) => item.id),
    ["default", space.id],
  );
  // 未知の 404 は claim を残さない (同じ id の再実行も 404 のまま)
  assert.equal((await deleteSpace(f, "space-0000000000000000")).status, 404);
});

test("削除中のスペースは scoped API が 404 になり、二重削除は 409 になる", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const session = await f.session(space.id);
  const during: number[] = [];
  f.workspace.deleteDirectory = async (path) => {
    f.deletedDirs.push(path);
    during.push((await f.bff.app.request(`/api/sessions?spaceId=${space.id}`)).status);
    during.push((await f.bff.app.request(`/api/sessions/${session.sessionId}?spaceId=${space.id}`)).status);
    during.push((await f.bff.app.request(`/api/spaces/${space.id}`, { method: "DELETE" })).status);
    during.push((await f.bff.app.request(`/api/secrets?spaceId=${space.id}`)).status);
  };
  assert.equal((await deleteSpace(f, space.id)).status, 200);
  assert.deepEqual(during, [404, 404, 409, 404]);
  // 削除後は claim が解け、同じ id は未知の 404 になる (行が無いので二重削除の 409 ではない)
  assert.equal((await deleteSpace(f, space.id)).status, 404);
  assert.equal(f.bff.store.get(session.sessionId), undefined);
});

test("スペース削除は会話・履歴・作業フォルダ・添付の根・cwd キー行を消し、他会話は無傷に残す", async (t) => {
  const f = await setup(t);
  const space = await f.space("消す");
  const other = await f.space("残す");
  const target = await f.session(space.id);
  const keep = await f.session(other.id);
  const normal = await f.session();
  // 添付と cwd キーの行 (環境変数 / サービス実績)。別スペースにも 1 組置く
  const uploaded = await f.bff.app.request(`/api/sessions/${target.sessionId}/files?spaceId=${space.id}&name=a.txt`, {
    method: "POST",
    body: "a",
  });
  assert.equal(uploaded.status, 201);
  const secret = await f.bff.app.request(
    `/api/secrets?spaceId=${space.id}`,
    json({ sessionId: target.sessionId, kind: "variable", name: "DEMO", value: "v" }),
  );
  assert.equal(secret.status, 200);
  f.bff.appDb.saveServeCommand({ cwd: target.cwd, command: "pnpm dev", updatedAt: 1 });
  const keptSecret = await f.bff.app.request(
    `/api/secrets?spaceId=${other.id}`,
    json({ sessionId: keep.sessionId, kind: "variable", name: "KEEP", value: "v" }),
  );
  assert.equal(keptSecret.status, 200);
  f.bff.appDb.saveServeCommand({ cwd: keep.cwd, command: "pnpm start", updatedAt: 2 });

  assert.equal((await deleteSpace(f, space.id)).status, 200);
  assert.deepEqual(f.deletedDirs, [spaceDirRel(space.id)]);
  // 会話ストアのフォルダ・作業フォルダ (添付を含む根)・cwd キー行が残らない
  assert.equal(existsSync(sessionMetaPath(target.sessionId, f.dir)), false);
  assert.deepEqual(f.bff.appDb.listSecrets(target.cwd), []);
  assert.equal(f.bff.appDb.getServeCommand(target.cwd), undefined);
  assert.equal(target.cwd, sessionWorkdirRel(target.sessionId, space.id));
  assert.equal(sessionUploadsRel(target.sessionId, space.id), `${spaceDirRel(space.id)}/uploads/${target.sessionId}`);
  // 既定スペースと他会話スペースは無傷
  assert.equal(f.bff.store.spaceOfId(keep.sessionId), other.id);
  assert.equal(f.bff.store.spaceOfId(normal.sessionId), "default");
  assert.equal(existsSync(sessionMetaPath(keep.sessionId, f.dir)), true);
  assert.deepEqual(
    f.bff.appDb.listSecrets(keep.cwd).map((row) => row.name),
    ["KEEP"],
  );
  assert.equal(f.bff.appDb.getServeCommand(keep.cwd)?.command, "pnpm start");
  // 一覧に消したスペースの会話が混ざらず、既定 / 他会話の一覧も変わらない
  assert.deepEqual(f.bff.store.list(space.id), []);
  assert.deepEqual(
    (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((item: Space) => item.id),
    ["default", other.id],
  );
  assert.equal((await f.bff.app.request(`/api/sessions?spaceId=${space.id}`)).status, 404);
  assert.deepEqual(
    (await jsonBody(f.bff.app.request(`/api/sessions?spaceId=${other.id}`))).sessions.map(
      (item: SessionPayload) => item.sessionId,
    ),
    [keep.sessionId],
  );
  assert.deepEqual(
    (await jsonBody(f.bff.app.request("/api/sessions"))).sessions.map((item: SessionPayload) => item.sessionId),
    [normal.sessionId],
  );
});

test("スペース削除の DB 障害は入口ガードの 503 (not_stored) とハンドラ内の 503 を分けて返す", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  await f.session(space.id);
  // 入口ガードは通るが、ハンドラ内の DB 読み (claim) が失敗する
  const raw = new DatabaseSync(join(f.dir, APP_DB_FILENAME));
  raw.exec("DROP TABLE spaces");
  raw.close();
  const inner = await deleteSpace(f, space.id);
  assert.equal(inner.status, 503);
  assert.equal((await jsonBody(inner)).state, undefined);
  // DB を使えない状態では入口ガードが「何も保存していない」ことを state で示す
  f.bff.appDb.close();
  const guard = await deleteSpace(f, space.id);
  assert.equal(guard.status, 503);
  assert.equal((await jsonBody(guard)).state, "not_stored");
});

test("ディレクトリ削除の失敗では会話だけ消えて行が残り、再実行すると完了する", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  const session = await f.session(space.id);
  f.deleteFailures.push(new SandboxRequestError("削除できませんでした", 502));

  const failed = await deleteSpace(f, space.id);
  assert.equal(failed.status, 502);
  assert.equal((await jsonBody(failed)).error, "削除できませんでした");
  // commit point より前で止まる = 会話と履歴は消え、spaces 行は残る
  assert.equal(f.bff.store.spaceOfId(session.sessionId), undefined);
  assert.equal(existsSync(sessionMetaPath(session.sessionId, f.dir)), false);
  assert.equal(
    (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.some((item: Space) => item.id === space.id),
    true,
  );
  assert.deepEqual(f.deletedDirs, [spaceDirRel(space.id)]);

  assert.equal((await deleteSpace(f, space.id)).status, 200);
  assert.deepEqual(f.deletedDirs, [spaceDirRel(space.id), spaceDirRel(space.id)]);
  assert.deepEqual(
    (await jsonBody(f.bff.app.request("/api/spaces"))).spaces.map((item: Space) => item.id),
    ["default"],
  );
});

test("コミット後に現れた会話は回収して根をもう一度消す", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  await f.session(space.id);
  // claim の前に受理された会話作成が、根の削除の最中に完了する窓を再現する
  let late = "";
  f.workspace.deleteDirectory = async (path) => {
    f.deletedDirs.push(path);
    if (!late) late = (await f.bff.store.create({ spaceId: space.id })).id;
  };
  assert.equal((await deleteSpace(f, space.id)).status, 200);
  assert.equal(f.bff.store.spaceOfId(late), undefined);
  assert.equal(existsSync(sessionMetaPath(late, f.dir)), false);
  // 回収した分だけ根の削除がやり直される
  assert.deepEqual(f.deletedDirs, [spaceDirRel(space.id), spaceDirRel(space.id)]);
});

test("削除後に残った会話を回収できないときは 500 で未回収を伝える", async (t) => {
  const f = await setup(t);
  const space = await f.space("デモ");
  await f.session(space.id);
  let late = "";
  f.workspace.deleteDirectory = async (path) => {
    f.deletedDirs.push(path);
    if (!late) late = (await f.bff.store.create({ spaceId: space.id })).id;
  };
  const original = f.bff.store.deleteSession.bind(f.bff.store);
  f.bff.store.deleteSession = async (id, options) => {
    if (id === late) throw new Error("回収できない");
    return original(id, options);
  };

  const response = await deleteSpace(f, space.id);
  assert.equal(response.status, 500);
  assert.match((await jsonBody(response)).error, /スペースは削除しましたが/);
  // 行は既に無いので、再試行は未知の 404 になる
  assert.equal((await deleteSpace(f, space.id)).status, 404);
});
