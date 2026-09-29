// 会話タイトルの変更 (PATCH /api/sessions/:id/title) を検証する。
//   - live / 未ロードのどちらでも meta.json へ書き、応答の title を一覧・payload と一致させる
//   - 空・空白だけは 400、未知の id は 404
//   - 自動タイトルより優先する (後から送ったメッセージで上書きされない)
//   - 既知の秘密値は自動タイトルと同じくマスクしてから保存する

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionTitleResponseSchema } from "../src/schema";
import { sessionMetaPath } from "../src/session-store";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const KEY = "sk-ant-dummy-key-0123456789abcdef";

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

/** 会話ストアありのセッション作成が通る最小のサンドボックス */
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

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-sessions-title-"));
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
    // null はモデルランタイム無し (SDK セッションを開かない経路の検証)
    pi: options.pi === undefined ? asPiBff(createStubPi()) : options.pi === null ? null : asPiBff(options.pi),
    workspace: stubWorkspace(),
  });
}

async function metaTitle(id: string, dir: string): Promise<string | undefined> {
  const meta = JSON.parse(await readFile(sessionMetaPath(id, dir), "utf8")) as { title?: string };
  return meta.title;
}

test("renaming persists to meta and is returned through the list and payload", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
    // 新規作成の payload は未設定の title をそのまま返す (一覧の行だけが「無題のセッション」を補う)
    assert.equal(created.title, "");

    const renamed = await bff.app.request(`/api/sessions/${created.sessionId}/title`, jsonPatch({ title: "  改名  " }));
    assert.equal(renamed.status, 200);
    const body = SessionTitleResponseSchema.parse(await renamed.json());
    assert.equal(body.sessionId, created.sessionId);
    // 応答は正規化 (trim) 後。一覧の行と同じ値になる
    assert.equal(body.title, "改名");

    assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].title, "改名");
    assert.equal((await jsonBody(bff.app.request(`/api/sessions/${created.sessionId}`))).title, "改名");
    assert.equal(await metaTitle(created.sessionId, dir), "改名");
    await bff.close();

    // 再起動 = 未ロードの descriptor から一覧を作る
    const restarted = await openBff(dir);
    try {
      assert.equal((await jsonBody(restarted.app.request("/api/sessions"))).sessions[0].title, "改名");
      assert.equal((await jsonBody(restarted.app.request(`/api/sessions/${created.sessionId}`))).title, "改名");
    } finally {
      await restarted.close();
    }
  });
});

test("a manual title wins over the automatic title from later messages", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      await bff.app.request(`/api/sessions/${created.sessionId}/title`, jsonPatch({ title: "手動タイトル" }));
      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "自動タイトルになって" }));
      const record = bff.store.records.get(created.sessionId);
      await waitFor(() => bff.store.statusOf(record!) === "completed");
      // postMessage は空のときだけ自動タイトルを作る (改名を上書きしない)
      assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].title, "手動タイトル");
      assert.equal(await metaTitle(created.sessionId, dir), "手動タイトル");
    } finally {
      await bff.close();
    }
  });
});

test("an unloaded session can be renamed without opening the SDK session", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    // モデルランタイム無しでも、meta.json だけで改名できる (notify と同じ契約)
    const restarted = await openBff(dir, { pi: null });
    try {
      const renamed = await restarted.app.request(
        `/api/sessions/${created.sessionId}/title`,
        jsonPatch({ title: "未ロードで改名" }),
      );
      assert.equal(renamed.status, 200);
      assert.equal((await jsonBody(renamed)).title, "未ロードで改名");
      assert.equal((await jsonBody(restarted.app.request("/api/sessions"))).sessions[0].title, "未ロードで改名");
      assert.equal(await metaTitle(created.sessionId, dir), "未ロードで改名");
    } finally {
      await restarted.close();
    }
  });
});

test("empty titles are rejected and unknown sessions are 404", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      for (const title of ["", "   ", "\n\t"]) {
        const res = await bff.app.request(`/api/sessions/${created.sessionId}/title`, jsonPatch({ title }));
        assert.equal(res.status, 400, `title=${JSON.stringify(title)} が 400 でない`);
      }
      const missing = await bff.app.request("/api/sessions/deadbeef00/title", jsonPatch({ title: "x" }));
      assert.equal(missing.status, 404);
      // 失敗した要求でタイトルは変わらない
      assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].title, "無題のセッション");
    } finally {
      await bff.close();
    }
  });
});

test("known secrets in a title are masked before they are stored", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff(dir, { pi });
    try {
      // 自動タイトルと同じく、既知の秘密値を meta.json へ入れない (通知の埋め込みタイトルへ載るため)
      pi.retainSecret(KEY);
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const renamed = await bff.app.request(
        `/api/sessions/${created.sessionId}/title`,
        jsonPatch({ title: `鍵 ${KEY} の会話` }),
      );
      assert.equal((await jsonBody(renamed)).title, "鍵 [REDACTED] の会話");
      assert.equal(await metaTitle(created.sessionId, dir), "鍵 [REDACTED] の会話");
    } finally {
      await bff.close();
    }
  });
});
