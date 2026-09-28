// 全履歴の投影とカーソル型ページネーションの検証。実 API は使わず stub で再現する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import { HISTORY_PAGE_LIMIT_MAX, projectHistoryPage } from "../src/history-projection";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import type { HistoryItem, HistoryPage } from "../src/schema";
import { asPiBff, createStubPi, waitFor, type StubSession } from "./stub-pi";

function text(value: string): unknown {
  return [{ type: "text", text: value }];
}

/** 履歴ページの全 item を古い→新しいで集める。重複・欠落の検出に使う */
async function collectAllPages(
  store: SessionStore,
  record: Parameters<SessionStore["history"]>[0],
  limit: number,
): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const result = store.history(record, { limit, ...(before ? { before } : {}) });
    assert.ok(result.ok, "cursor は既知のはず");
    items.unshift(...result.page.items);
    if (!result.page.hasMore || !result.page.nextCursor) return items;
    before = result.page.nextCursor;
  }
  throw new Error("ページが終わらない");
}

function messageItems(page: HistoryPage) {
  return page.items.filter((item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message");
}

/** 永続化ありの store。再起動 (store 作り直し) での履歴復元を検証する */
async function createPersistentFixture() {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-history-"));
  const workspace = {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
  const pi = createStubPi();
  const store = new SessionStore({
    pi,
    catalog: createAgentCatalog(),
    storeDir,
    workspace,
    rootCwd: "/tmp/project",
  });
  await store.init();
  const record = await store.create();
  return { store, record, session: pi.sessions[0] as StubSession, storeDir, workspace };
}

test("compaction 後も全履歴を projection し、要約対象 / 保持 / 境界を区別する", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: "一番古い質問" });
  session.appendMessage({ role: "assistant", content: text("一番古い答え"), stopReason: "stop" });
  session.appendMessage({ role: "user", content: "まだ残る質問" });
  session.appendMessage({ role: "assistant", content: text("まだ残る答え"), stopReason: "stop" });
  await session.compact({ summarizeCount: 2, summary: "古いやり取りの要約", tokensBefore: 50_000 });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const page = result.page;
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  // 発言は entry の順に全件並び、圧縮イベントがその位置に入る (圧縮は保持済み発言の後に起きる)
  assert.deepEqual(
    page.items.map((item) => (item.kind === "compaction" ? "compaction" : `${item.context}:${item.text}`)),
    ["summarized:一番古い質問", "summarized:一番古い答え", "active:まだ残る質問", "active:まだ残る答え", "compaction"],
  );
  const messages = messageItems(page);
  assert.equal(page.messageCount, 4);
  assert.equal(page.summarizedMessageCount, 2);
  // 現在の有効コンテキストの先頭は、圧縮で保持された直近発言 (要約の直後)
  assert.equal(page.activeContextStartId, messages[2].id);
  // 既存 payload の messages は従来どおり有効コンテキストだけ (API 契約は変えない)
  assert.deepEqual(
    store.payload(record).messages.map((message) => message.text),
    ["まだ残る質問", "まだ残る答え"],
  );
  await store.close();
});

test("複数回の compaction と firstKeptEntryId が metadata entry を指すケース", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: "u1" });
  session.appendMessage({ role: "assistant", content: text("a1"), stopReason: "stop" });
  session.appendMessage({ role: "user", content: "u2" });
  session.appendMessage({ role: "assistant", content: text("a2"), stopReason: "stop" });
  await session.compact({ summarizeCount: 1, summary: "1回目の要約", tokensBefore: 30_000 });
  session.appendMessage({ role: "user", content: "u3" });
  session.appendMessage({ role: "assistant", content: text("a3"), stopReason: "stop" });
  await session.compact({
    summarizeCount: 1,
    summary: "2回目の要約",
    tokensBefore: 60_000,
    firstKeptIsMetadata: true,
  });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const page = result.page;
  const signatures = page.items.map((item) =>
    item.kind === "compaction" ? `compaction` : `${item.context}:${item.text}`,
  );
  // metadata entry (model_change) は表示 item にせず、そこを境界として前後だけを判定する
  assert.deepEqual(signatures, [
    "summarized:u1",
    "summarized:a1",
    "active:u2",
    "active:a2",
    "compaction",
    "active:u3",
    "active:a3",
    "compaction",
  ]);
  assert.equal(page.messageCount, 6);
  assert.equal(page.summarizedMessageCount, 2);
  const activeFirst = messageItems(page).find((item) => item.context === "active");
  assert.equal(page.activeContextStartId, activeFirst?.id, "真相と metadata を跨いだ最初の active を指す");
  assert.equal(page.items.filter((item) => item.kind === "compaction").length, 2, "過去の圧縮も位置ごとに残る");
  await store.close();
});

test("context_edit で外れたメッセージは summarized ではなく excluded にする", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: "u1" });
  session.appendMessage({ role: "assistant", content: text("a1"), stopReason: "stop" });
  session.appendMessage({ role: "user", content: "u2" });
  session.appendMessage({ role: "assistant", content: text("a2"), stopReason: "stop" });
  // overflow 回復 / リトライの context_edit を再現: entry には残るが agent state から外れる
  session.dropLastAssistantFromState();

  const result = store.history(record, {});
  assert.ok(result.ok);
  assert.deepEqual(
    result.page.items.map((item) => (item.kind === "message" ? `${item.context}:${item.text}` : "compaction")),
    ["active:u1", "active:a1", "active:u2", "excluded:a2"],
  );
  assert.equal(result.page.summarizedMessageCount, 0);
  assert.equal(result.page.activeContextStartId, null, "要約が無ければ境界ラベルは出さない");
  await store.close();
});

test("カーソル型ページネーションは重複も欠落もなく古い側へ遡れる", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;
  for (let index = 0; index < 20; index += 1) {
    session.appendMessage({ role: "user", content: `u${index}` });
    session.appendMessage({ role: "assistant", content: text(`a${index}`), stopReason: "stop" });
  }

  const first = store.history(record, { limit: 3 });
  assert.ok(first.ok);
  assert.equal(first.page.items.length, 3);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.nextCursor, first.page.items[0].id, "次は先頭 item より古い範囲");
  assert.deepEqual(
    first.page.items.map((item) => (item.kind === "message" ? item.text : "compaction")),
    ["a18", "u19", "a19"],
  );

  const all = await collectAllPages(store, record, 3);
  // prevCursor は先頭 item の直前の item。連続性の検証に使う
  assert.equal(first.page.prevCursor, all.find((item) => item.kind === "message" && item.text === "u18")?.id);
  const older = store.history(record, { before: first.page.nextCursor as string, limit: 3 });
  assert.ok(older.ok);
  assert.deepEqual(
    older.page.items.map((item) => (item.kind === "message" ? item.text : "compaction")),
    ["u17", "a17", "u18"],
  );
  assert.equal(older.page.prevCursor, all.find((item) => item.kind === "message" && item.text === "a16")?.id);
  const head = store.history(record, { before: all[0].id, limit: 3 });
  assert.ok(head.ok);
  assert.equal(head.page.prevCursor, null, "ブランチ先頭のページは前が無い");
  assert.equal(head.page.items.length, 0, "先頭より古い item は無い");

  assert.equal(all.length, 40);
  assert.deepEqual(
    all.map((item) => (item.kind === "message" ? item.text : "compaction")),
    Array.from({ length: 20 }, (_, index) => [`u${index}`, `a${index}`]).flat(),
  );
  assert.equal(new Set(all.map((item) => item.id)).size, all.length, "同じ entry を二度返さない");

  const tail = await collectAllPages(store, record, 3);
  const beforeOldest = store.history(record, { before: tail[0].id, limit: 3 });
  assert.ok(beforeOldest.ok);
  assert.deepEqual(beforeOldest.page.items, []);
  assert.equal(beforeOldest.page.hasMore, false);
  assert.equal(beforeOldest.page.nextCursor, null);
  await store.close();
});

test("不明なカーソルは unknown-cursor を返す (空ページへ縮退しない)", () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  return store.create().then(async (record) => {
    const result = projectHistoryPage({
      record,
      masker: createSecretMasker([]),
      cwd: "/tmp/project",
      before: "entry-does-not-exist",
    });
    assert.deepEqual(result, { ok: false, reason: "unknown-cursor" });
    await store.close();
  });
});

test("履歴の本文・要約・ツール出力にも秘密値マスクを掛ける", async () => {
  const secret = "sk-test-secret-value-1234567890";
  const masker = createSecretMasker([secret]);
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog(), masker });
  const record = await store.create();
  const session = record.session as unknown as StubSession;
  session.appendMessage({ role: "user", content: `これは ${secret} を含む質問` });
  session.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: `回答に ${secret} が混ざる` },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: `echo ${secret}` } },
    ],
    stopReason: "stop",
  });
  session.appendMessage({
    role: "toolResult",
    content: text(`出力 ${secret}`),
    toolCallId: "call-1",
    isError: false,
  });
  await session.compact({ summarizeCount: 1, summary: `要約にも ${secret}`, tokensBefore: 1 });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const json = JSON.stringify(result.page);
  assert.equal(json.includes(secret), false, "秘密値が生のまま出ない");
  assert.ok(json.includes(REDACTED));
  const summary = result.page.items.find((item) => item.kind === "compaction");
  assert.equal(summary?.kind === "compaction" ? summary.compaction.summary : "", `要約にも ${REDACTED}`);
  await store.close();
});

test("再起動 (store 作り直し) 後も全履歴と同じ entry id で読める", async () => {
  const first = await createPersistentFixture();
  try {
    first.session.appendMessage({ role: "user", content: "u1", timestamp: Date.now() });
    first.session.appendMessage({ role: "assistant", content: text("a1"), stopReason: "stop", timestamp: Date.now() });
    first.session.appendMessage({ role: "user", content: "u2", timestamp: Date.now() });
    first.session.appendMessage({ role: "assistant", content: text("a2"), stopReason: "stop", timestamp: Date.now() });
    await first.session.compact({ summarizeCount: 2, summary: "再起動前の要約", tokensBefore: 40_000 });
    await first.store.persist(first.record);
    await first.store.flush(first.record);
    const before = first.store.history(first.record, {});
    assert.ok(before.ok);
    await first.store.close();

    const pi = createStubPi();
    const restored = new SessionStore({
      pi,
      catalog: createAgentCatalog(),
      storeDir: first.storeDir,
      workspace: first.workspace,
      rootCwd: "/tmp/project",
    });
    await restored.init();
    const record = await restored.resolve(first.record.id);
    assert.ok(record, "再起動で descriptor から復元できる");
    const after = restored.history(record, {});
    assert.ok(after.ok);
    assert.deepEqual(
      after.page.items.map((item) => (item.kind === "compaction" ? "compaction" : `${item.context}:${item.text}`)),
      ["summarized:u1", "summarized:a1", "active:u2", "active:a2", "compaction"],
    );
    assert.deepEqual(
      after.page.items.map((item) => item.id),
      before.page.items.map((item) => item.id),
      "entry id は再起動を跨いで安定する",
    );
    const compaction = after.page.items.find((item) => item.kind === "compaction");
    assert.equal(compaction?.kind === "compaction" ? compaction.compaction.summary : undefined, "再起動前の要約");
    await restored.close();
  } finally {
    await rm(first.storeDir, { recursive: true, force: true });
  }
});

test("GET /api/sessions/:id/history は最新ページを返し、limit / cursor を検証する", async () => {
  const pi = createStubPi();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  const { app } = bff;
  try {
    const created = (await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { sessionId: string };
    const session = pi.sessions[0] as StubSession;
    session.appendMessage({ role: "user", content: "u1" });
    session.appendMessage({ role: "assistant", content: text("a1"), stopReason: "stop" });
    session.appendMessage({ role: "user", content: "u2" });
    session.appendMessage({ role: "assistant", content: text("a2"), stopReason: "stop" });

    const response = await app.request(`/api/sessions/${created.sessionId}/history?limit=2`);
    assert.equal(response.status, 200);
    const page = (await response.json()) as HistoryPage;
    assert.deepEqual(
      page.items.map((item) => (item.kind === "message" ? item.text : "compaction")),
      ["u2", "a2"],
    );
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
    assert.equal(page.messageCount, 4);

    const older = await app.request(
      `/api/sessions/${created.sessionId}/history?limit=2&before=${encodeURIComponent(page.nextCursor)}`,
    );
    assert.equal(older.status, 200);
    const olderPage = (await older.json()) as HistoryPage;
    assert.deepEqual(
      olderPage.items.map((item) => (item.kind === "message" ? item.text : "compaction")),
      ["u1", "a1"],
    );
    assert.equal(olderPage.hasMore, false);

    const unknown = await app.request(`/api/sessions/${created.sessionId}/history?before=nope`);
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "Unknown history cursor" });

    const badLimit = await app.request(`/api/sessions/${created.sessionId}/history?limit=0`);
    assert.equal(badLimit.status, 400);
    const tooLarge = await app.request(
      `/api/sessions/${created.sessionId}/history?limit=${HISTORY_PAGE_LIMIT_MAX + 1}`,
    );
    assert.equal(tooLarge.status, 400);
    const floatLimit = await app.request(`/api/sessions/${created.sessionId}/history?limit=1.5`);
    assert.equal(floatLimit.status, 400);

    const missing = await app.request("/api/sessions/does-not-exist/history");
    assert.equal(missing.status, 404);
  } finally {
    await bff.close();
  }
});

test("送信した user item には、その run の id が載る", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const posted = store.postMessage(record, "run id の検証");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const result = store.history(record, {});
  assert.ok(result.ok);
  const items = messageItems(result.page);
  assert.equal(items.find((item) => item.role === "user")?.runId, posted.runId, "自分の run の id が載る");
  assert.equal(items.find((item) => item.role === "assistant")?.runId, undefined, "assistant には載らない");

  await store.close();
});

test("キュー経由の送信でも、各 user item には自分の run の id が載る", async () => {
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 10 }), catalog: createAgentCatalog() });
  const record = await store.create();
  const first = store.postMessage(record, "1つ目");
  // 実行中に積んだ送信にも、受け付けた時点で run id が振られる
  const second = store.postMessage(record, "2つ目");
  assert.equal(second.queued, true);
  assert.notEqual(second.runId, first.runId);
  await waitFor(() => store.statusOf(record) === "completed", 5000, "runs completion");

  const result = store.history(record, {});
  assert.ok(result.ok);
  const users = messageItems(result.page).filter((item) => item.role === "user");
  assert.deepEqual(
    users.map((item) => [item.text, item.runId]),
    [
      ["1つ目", first.runId],
      ["2つ目", second.runId],
    ],
    "応答で返した run id がそのまま item に載る",
  );

  await store.close();
});
