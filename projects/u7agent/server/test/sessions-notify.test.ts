// 会話ごとの通知トグル (SessionMeta.notify) と、finish 時点の値で送る契約を検証する。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { sessionMetaPath } from "../src/session-store";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";

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

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
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

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-sessions-notify-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openBff(
  dir: string,
  options: { pi?: ReturnType<typeof createStubPi>; notificationFetch?: typeof fetch } = {},
) {
  return createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: dir,
    pi: asPiBff(options.pi ?? createStubPi()),
    workspace: stubWorkspace(),
    notificationFetch: options.notificationFetch,
  });
}

test("notify is stored in meta and read back through every path", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
    assert.equal(created.notify, true);
    // live な一覧 / payload は record の値
    assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions[0].notify, true);

    const meta = JSON.parse(await readFile(sessionMetaPath(created.sessionId, dir), "utf8")) as Record<string, unknown>;
    assert.equal(meta.notify, true);
    await bff.close();

    // 再起動 = 未ロードの descriptor から一覧を作る
    const restarted = await openBff(dir);
    try {
      const list = await jsonBody(restarted.app.request("/api/sessions"));
      assert.equal(list.sessions[0].notify, true);
      const payload = await jsonBody(restarted.app.request(`/api/sessions/${created.sessionId}`));
      assert.equal(payload.notify, true);
    } finally {
      await restarted.close();
    }
  });
});

test("the toggle works while the session is busy and the value at finish decides the send", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { pi: createStubPi({ chunkDelayMs: 120 }), notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      assert.equal(created.notify, false, "既定は Off");

      const first = await jsonBody(
        await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "通知して" })),
      );
      // 実行中に切り替えても 409 にならない (SDK の設定変更を通さない)
      const record = bff.store.records.get(created.sessionId);
      assert.equal(bff.store.statusOf(record!), "running");
      const toggled = await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: true }));
      assert.equal(toggled.status, 200);
      assert.equal((await jsonBody(toggled)).notify, true);

      await waitFor(() => calls.length === 1);
      assert.equal(calls[0].url, WEBHOOK);

      // Off に戻してから完了するランでは送らない
      const off = await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: false }));
      assert.equal((await jsonBody(off)).notify, false);
      const second = await jsonBody(
        await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "送らないで" })),
      );
      assert.notEqual(second.runId, first.runId);
      await waitFor(
        () =>
          bff.store.records.get(created.sessionId)?.run?.id === second.runId &&
          bff.store.statusOf(bff.store.records.get(created.sessionId)!) === "completed",
      );
      assert.equal(calls.length, 1);
    } finally {
      await bff.close();
    }
  });
});

test("a completed run with an empty assistant text does not notify", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    // ツール実行のみ・中断後などを模した空応答
    const bff = await openBff(dir, { pi: createStubPi({ reply: "" }), notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "空で終わって" }));
      await waitFor(() => bff.store.statusOf(bff.store.records.get(created.sessionId)!) === "completed");
      assert.equal(calls.length, 0);
    } finally {
      await bff.close();
    }
  });
});

test("a completed run posts one embed with the link, mention and masked body", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, {
      pi: createStubPi({ reply: `結果です ${WEBHOOK}` }),
      notificationFetch: impl,
    });
    try {
      await bff.app.request(
        "/api/notifications",
        jsonPut({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173", mention: "here" }),
      );
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "実行して" }));
      await waitFor(() => calls.length === 1);

      const payload = JSON.parse(String(calls[0].init?.body));
      assert.equal(payload.embeds[0].title, "✅ 完了  実行して");
      assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"] });
      const lines = String(payload.embeds[0].description).split("\n");
      assert.match(lines[0], /^汎用アシスタント ・ \d+秒 ・ ツール 0件$/);
      // 通知本文の Webhook URL は専用マスクで潰す
      assert.equal(lines[1], "結果です [REDACTED]");
      assert.equal(lines[2], `http://127.0.0.1:5173/s/${created.sessionId}`);
    } finally {
      await bff.close();
    }
  });
});

test("the notify route rejects an invalid body and a missing session", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    try {
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      const invalid = await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({}));
      assert.equal(invalid.status, 400);
      assert.deepEqual(await jsonBody(invalid), { error: "notify is required" });

      const missing = await bff.app.request("/api/sessions/missing/notify", jsonPatch({ notify: true }));
      assert.equal(missing.status, 404);

      // 削除すると meta ごと消え、切り替えもできなくなる
      assert.equal((await bff.app.request(`/api/sessions/${created.sessionId}`, { method: "DELETE" })).status, 200);
      const deleted = await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: true }));
      assert.equal(deleted.status, 404);
      assert.equal((await jsonBody(bff.app.request("/api/sessions"))).sessions.length, 0);
    } finally {
      await bff.close();
    }
  });
});
