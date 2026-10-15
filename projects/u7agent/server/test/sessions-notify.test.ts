// 会話ごとの通知トグル (SessionMeta.notify) と、finish 時点の値で送る契約を検証する。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionNotifyResponseSchema } from "../src/schema";
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
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    // git 情報はこのテストでは扱わない
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
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
  options: { pi?: ReturnType<typeof createStubPi> | null; notificationFetch?: typeof fetch } = {},
) {
  return createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: dir,
    // null はモデルランタイム無し (SDK セッションを復元できない状態)
    pi: options.pi === undefined ? asPiBff(createStubPi()) : options.pi === null ? null : asPiBff(options.pi),
    workspace: stubWorkspace(),
    notificationFetch: options.notificationFetch,
  });
}

/** meta.json の notify。未指定はキーごと無い (false と区別して古い true の残骸を見る) */
async function metaNotify(id: string, dir: string): Promise<boolean | undefined> {
  const meta = JSON.parse(await readFile(sessionMetaPath(id, dir), "utf8")) as { notify?: boolean };
  return meta.notify;
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

test("a completed run posts one embed with the link and masked body", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, {
      pi: createStubPi({ reply: `結果です ${WEBHOOK}` }),
      notificationFetch: impl,
    });
    try {
      await bff.app.request(
        "/api/notifications",
        jsonPut({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173" }),
      );
      // 既定スペース以外の会話でも、リンクはその会話の所属で開ける (保存値に依存させない)
      const space = await jsonBody(bff.app.request("/api/spaces", jsonPost({ name: "デモ" })));
      const created = await jsonBody(
        bff.app.request("/api/sessions", jsonPost({ notify: true, spaceId: space.space.id })),
      );
      await bff.app.request(
        `/api/sessions/${created.sessionId}/messages?spaceId=${space.space.id}`,
        jsonPost({ text: "実行して" }),
      );
      await waitFor(() => calls.length === 1);

      const payload = JSON.parse(String(calls[0].init?.body));
      assert.equal(payload.embeds[0].title, "✅ 完了  実行して");
      assert.equal("allowed_mentions" in payload, false);
      const lines = String(payload.embeds[0].description).split("\n");
      assert.match(lines[0], /^汎用アシスタント ・ \d+秒 ・ ツール 0件$/);
      // 通知本文の Webhook URL は専用マスクで潰す
      assert.equal(lines[1], "結果です [REDACTED]");
      assert.equal(lines[2], `http://127.0.0.1:5173/s/${created.sessionId}?space=${space.space.id}`);
    } finally {
      await bff.close();
    }
  });
});

test("turning notify off clears the persisted flag", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      assert.equal(await metaNotify(created.sessionId, dir), true);

      const off = await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: false }));
      assert.equal(off.status, 200);
      assert.equal((await jsonBody(off)).notify, false);
      // 古い meta.notify: true を残さない (再起動で On に戻らない)
      assert.equal(await metaNotify(created.sessionId, dir), undefined);
    } finally {
      await bff.close();
    }

    // 再起動しても Off のまま、完了しても送らない
    const restarted = await openBff(dir, { notificationFetch: impl });
    try {
      const list = await jsonBody(restarted.app.request("/api/sessions"));
      assert.equal(list.sessions[0].notify, false);
      await restarted.app.request(
        `/api/sessions/${list.sessions[0].sessionId}/messages`,
        jsonPost({ text: "送らないで" }),
      );
      const record = restarted.store.records.get(list.sessions[0].sessionId);
      await waitFor(() => restarted.store.statusOf(record!) === "completed");
      assert.equal(calls.length, 0);
    } finally {
      await restarted.close();
    }
  });
});

test("an unloaded session can be toggled without the runtime", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    // モデルランタイム無し = 保存済みセッションを SDK で復元できない状態
    const offline = await openBff(dir, { pi: null });
    try {
      const list = await jsonBody(offline.app.request("/api/sessions"));
      assert.equal(list.sessions.length, 1, "保存済みセッションは一覧に残る");
      const toggled = await offline.app.request(
        `/api/sessions/${created.sessionId}/notify`,
        jsonPatch({ notify: true }),
      );
      assert.equal(toggled.status, 200, "一覧にあるセッションは 404 にしない");
      assert.equal((await jsonBody(toggled)).notify, true);
      assert.equal(await metaNotify(created.sessionId, dir), true);
    } finally {
      await offline.close();
    }

    // 再起動後 (未ロード) も同じ値
    const restarted = await openBff(dir);
    try {
      assert.equal((await jsonBody(restarted.app.request("/api/sessions"))).sessions[0].notify, true);
      assert.equal((await jsonBody(restarted.app.request(`/api/sessions/${created.sessionId}`))).notify, true);
    } finally {
      await restarted.close();
    }
  });
});

test("the notify response is the same small DTO for live and unloaded sessions", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff(dir);
    const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
    try {
      // live
      const live = await jsonBody(
        await bff.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: true })),
      );
      assert.deepEqual(live, { sessionId: created.sessionId, notify: true });
      assert.equal(SessionNotifyResponseSchema.safeParse(live).success, true);
      assert.equal("messages" in live, false, "会話全文は返さない");
    } finally {
      await bff.close();
    }

    // 未ロード (SDK を開かないので同じ形で返せる)
    const restarted = await openBff(dir);
    try {
      const unloaded = await jsonBody(
        await restarted.app.request(`/api/sessions/${created.sessionId}/notify`, jsonPatch({ notify: false })),
      );
      assert.deepEqual(unloaded, { sessionId: created.sessionId, notify: false });
      assert.equal(SessionNotifyResponseSchema.safeParse(unloaded).success, true);
      assert.equal("messages" in unloaded, false, "会話全文は返さない");
    } finally {
      await restarted.close();
    }
  });
});

test("a restore started while the toggle is being written keeps the new value", async () => {
  await withStoreDir(async (dir) => {
    const first = await openBff(dir);
    const created = await jsonBody(first.app.request("/api/sessions", jsonPost({})));
    await first.close();

    // SDK 復元を保留できるスタブ (createSession を gate で止める)
    const pi = createStubPi();
    const originalCreateSession = pi.createSession;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pi.createSession = async (input) => {
      await gate;
      return originalCreateSession(input);
    };

    const bff = await openBff(dir, { pi });
    try {
      // 未ロードのまま書き込みを始め、同じ tick で復元を開始する
      const toggled = bff.store.setNotify(created.sessionId, true);
      const restored = bff.store.resolve(created.sessionId);
      await toggled;
      // 保存が終わってから復元を進める (古い descriptor の load が残っていると古い値で上書きされる)
      release();
      const record = await restored;

      assert.equal(record?.notify, true, "復元した record が古い値へ戻らない");
      assert.equal(bff.store.list()[0].notify, true);
      assert.equal(await metaNotify(created.sessionId, dir), true);
    } finally {
      await bff.close();
    }
  });
});

test("a completed run without an assistant message does not reuse the previous reply", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const pi = createStubPi();
    const bff = await openBff(dir, { pi, notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      const first = await jsonBody(
        await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "1つ目" })),
      );
      await waitFor(() => calls.length === 1);

      // 2 回目は user メッセージだけを積み、assistant を生成せずに終わる
      const session = pi.sessions[0];
      session.prompt = async (text: string) => {
        session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        session.emit({ type: "agent_settled" });
      };
      const second = await jsonBody(
        await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "2つ目" })),
      );
      assert.notEqual(second.runId, first.runId);
      const record = bff.store.records.get(created.sessionId);
      await waitFor(() => bff.store.statusOf(record!) === "completed");
      // 前回の assistant 本文を再送しない
      assert.equal(calls.length, 1);
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

/** 質問通知の質問。2 件目とは本文を分け、N と第 1 問が最初の呼び出しのものかを見る */
const ASK_QUESTIONS = [{ question: "どちらの方式で進めますか" }, { question: "補足はありますか" }];

const ASK_ANSWERS = [
  { index: 0, selected: ["A"] },
  { index: 1, skipped: true },
];

/** 送信 1 通分の embed。title / description だけを読む */
function embedOf(call: { url: string; init: RequestInit | undefined } | undefined): {
  title: string;
  description: string;
} {
  return JSON.parse(String(call?.init?.body)).embeds[0];
}

test("質問の登録で 1 通だけ送り、並行する 2 件目と settle 済みの tombstone は数えない", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request(
        "/api/notifications",
        jsonPut({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173" }),
      );
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      await bff.app.request(
        `/api/sessions/${created.sessionId}/title`,
        jsonPatch({ title: "パンくずの折り返しを直す" }),
      );
      const record = bff.store.records.get(created.sessionId);

      const first = bff.store.askUserHost().ask(created.sessionId, "call-1", ASK_QUESTIONS, undefined);
      const second = bff.store.askUserHost().ask(created.sessionId, "call-2", [{ question: "2 件目" }], undefined);
      await waitFor(() => calls.length === 1, 1000, "最初の登録で 1 通");
      const embed = embedOf(calls[0]);
      // 会話の通知が On なのでタイトルと第 1 問を載せる。N は最初の呼び出しの質問数
      assert.equal(embed.title, "❓ 回答待ち  パンくずの折り返しを直す");
      assert.deepEqual(embed.description.split("\n"), [
        "汎用アシスタント ・ 質問 2件",
        "どちらの方式で進めますか",
        `http://127.0.0.1:5173/s/${created.sessionId}?space=default`,
      ]);

      // 並行する 2 件目を settle しても追加送信は無い
      assert.equal(bff.store.answerQuestion(record!, "call-2", [{ index: 0, text: "はい" }]).status, "ok");
      await second;
      assert.equal(bff.store.answerQuestion(record!, "call-1", ASK_ANSWERS).status, "ok");
      await first;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, 1);

      // 全待機が解消した後の再質問は、settle 済みの tombstone を数えず再び 1 通送る
      const again = bff.store.askUserHost().ask(created.sessionId, "call-3", [{ question: "再質問" }], undefined);
      await waitFor(() => calls.length === 2, 1000, "再質問で再通知");
      assert.deepEqual(embedOf(calls[1]).description.split("\n").slice(0, 2), [
        "汎用アシスタント ・ 質問 1件",
        "再質問",
      ]);
      assert.equal(bff.store.answerQuestion(record!, "call-3", [{ index: 0, text: "x" }]).status, "ok");
      await again;
    } finally {
      await bff.close();
    }
  });
});

test("会話の通知が Off の会話では質問通知にタイトルと質問文を載せない", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request(
        "/api/notifications",
        jsonPut({ webhookUrl: WEBHOOK, enabled: true, baseUrl: "http://127.0.0.1:5173" }),
      );
      // 新規チャットの notify は既定 Off
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({})));
      await bff.app.request(
        `/api/sessions/${created.sessionId}/title`,
        jsonPatch({ title: "パンくずの折り返しを直す" }),
      );
      const record = bff.store.records.get(created.sessionId);

      const pending = bff.store.askUserHost().ask(created.sessionId, "call-1", ASK_QUESTIONS, undefined);
      await waitFor(() => calls.length === 1, 1000, "本文なしの 1 通");
      const embed = embedOf(calls[0]);
      assert.equal(embed.title, "❓ 質問があります");
      assert.deepEqual(embed.description.split("\n"), [
        "汎用アシスタント ・ 質問 2件",
        `http://127.0.0.1:5173/s/${created.sessionId}?space=default`,
      ]);
      assert.equal(bff.store.answerQuestion(record!, "call-1", ASK_ANSWERS).status, "ok");
      await pending;
    } finally {
      await bff.close();
    }
  });
});

test("abort 済みの signal では質問通知を送らない", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      const record = bff.store.records.get(created.sessionId);

      const controller = new AbortController();
      controller.abort();
      const aborted = bff.store.askUserHost().ask(created.sessionId, "call-1", ASK_QUESTIONS, controller.signal);
      await assert.rejects(aborted, /ask_user/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, 0, "回答不可能な登録は通知しない");
      assert.equal(bff.store.answerQuestion(record!, "call-1", ASK_ANSWERS).status, "missing");
    } finally {
      await bff.close();
    }
  });
});

test("通知の失敗は質問の登録と回答を妨げない", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      const record = bff.store.records.get(created.sessionId);

      const pending = bff.store.askUserHost().ask(created.sessionId, "call-1", ASK_QUESTIONS, undefined);
      assert.equal(bff.store.list()[0].awaitingAnswer, true, "送信が失敗しても待機は登録される");
      assert.equal(bff.store.answerQuestion(record!, "call-1", ASK_ANSWERS).status, "ok");
      assert.deepEqual(await pending, ASK_ANSWERS);
      // 失敗は直近結果として残り、質問の登録・回答はそのまま成立する
      await waitFor(() => bff.notifications.settings().lastResult?.ok === false, 1000, "失敗の記録");
      assert.equal(calls.length, 1);
    } finally {
      await bff.close();
    }
  });
});

test("askUser が Off でも会話の通知が On の完了通知は従来どおり送る", async () => {
  await withStoreDir(async (dir) => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const bff = await openBff(dir, { notificationFetch: impl });
    try {
      await bff.app.request("/api/notifications", jsonPut({ webhookUrl: WEBHOOK, enabled: true, askUser: false }));
      const created = await jsonBody(bff.app.request("/api/sessions", jsonPost({ notify: true })));
      await bff.app.request(`/api/sessions/${created.sessionId}/messages`, jsonPost({ text: "実行して" }));
      await waitFor(() => calls.length === 1, 1000, "完了通知");
      assert.match(embedOf(calls[0]).title, /^✅ 完了/);
    } finally {
      await bff.close();
    }
  });
});
