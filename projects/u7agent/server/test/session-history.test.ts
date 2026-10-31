// 全履歴の投影とカーソル型ページネーションの検証。実 API は使わず stub で再現する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import { HISTORY_PAGE_LIMIT_DEFAULT, HISTORY_PAGE_LIMIT_MAX, projectHistoryPage } from "../src/history-projection";
import { createSecretMasker, REDACTED } from "../src/redact";
import { isDisplayableMessage } from "../src/session-projection";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import type { HistoryItem, HistoryPage } from "../src/schema";
import { asPiBff, createStubPi, waitFor, type StubSession } from "./stub-pi";

function text(value: string): unknown {
  return [{ type: "text", text: value }];
}

test("表示可否は本文の有無だけで決まり、画像だけの応答は item にしない", () => {
  assert.equal(isDisplayableMessage({ role: "assistant", content: text("secret-value") }), true);
  assert.equal(isDisplayableMessage({ role: "assistant", content: text("") }), false);
  assert.equal(isDisplayableMessage({ role: "assistant", content: [{ type: "image", data: "..." }] }), false);
  assert.equal(isDisplayableMessage({ role: "user", content: [] }), true);
});

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

// What: 履歴 API の assistant item にだけ生成元モデルが載り、モデルを記録していない旧履歴は null で載る
test("assistant item には生成元モデルが載り、provider / model が欠ける履歴は null になる", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  store.postMessage(record, "モデルの検証");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const first = store.history(record, {});
  assert.ok(first.ok);
  const firstItems = messageItems(first.page);
  assert.equal(firstItems.find((item) => item.role === "assistant")?.model, "stub/stub-model");
  assert.equal(firstItems.find((item) => item.role === "user")?.model, undefined, "user はモデルを持たない");

  const session = record.session as unknown as StubSession;
  session.appendMessage({ role: "assistant", content: text("古い応答"), stopReason: "stop" });
  const after = store.history(record, {});
  assert.ok(after.ok);
  assert.equal(
    messageItems(after.page).find((item) => item.text === "古い応答")?.model,
    null,
    "provider / model を持たない履歴は不明として載せる",
  );

  await store.close();
});

test("履歴の user item には run 全体の所要時間と結末が載り、再起動で消える", async () => {
  const first = await createPersistentFixture();
  try {
    const done = first.store.postMessage(first.record, "完了したターン");
    await waitFor(() => first.store.statusOf(first.record) === "completed", 3000, "run completion");
    // 2 つ目は実行中に停止する (結末が stopped のターン)
    const stopped = first.store.postMessage(first.record, "停止したターン");
    await first.store.stop(first.record);
    await waitFor(() => first.store.statusOf(first.record) !== "running", 3000, "stop settlement");

    const before = first.store.history(first.record, {});
    assert.ok(before.ok);
    const users = messageItems(before.page).filter((item) => item.role === "user");
    assert.deepEqual(
      users.map((item) => [item.runId, item.runOutcome, typeof item.runDurationMs === "number"]),
      [
        [done.runId, "completed", true],
        [stopped.runId, "stopped", true],
      ],
      "run_end と同じ定義の所要時間と結末が自分の run id の item に載る",
    );
    // assistant には runDurationMs / runOutcome を載せない (その 2 つはターンの user が持つ)
    assert.equal(messageItems(before.page).find((item) => item.role === "assistant")?.runOutcome, undefined);
    const answer = messageItems(before.page).find((item) => item.role === "assistant");
    assert.equal(answer?.turnEnd?.outcome, "completed", "結末はターン最後の本文あり応答 item の turnEnd として載る");
    assert.equal(typeof answer?.turnEnd?.durationMs, "number");
    await first.store.flush(first.record);
    await first.store.close();

    // 再起動: 値はメモリのみなので載らない (表示側は行ごと出さない)。発言自体は残る
    const restored = new SessionStore({
      pi: createStubPi(),
      catalog: createAgentCatalog(),
      storeDir: first.storeDir,
      workspace: first.workspace,
      rootCwd: "/tmp/project",
    });
    await restored.init();
    const record = await restored.resolve(first.record.id);
    assert.ok(record);
    const after = restored.history(record, {});
    assert.ok(after.ok);
    assert.deepEqual(
      messageItems(after.page)
        .filter((item) => item.role === "user")
        .map((item) => [item.text, item.runId, item.runDurationMs, item.runOutcome]),
      [
        ["完了したターン", done.runId, undefined, undefined],
        ["停止したターン", stopped.runId, undefined, undefined],
      ],
      "runId は復元しても、所要時間と結末は残らない",
    );
    assert.deepEqual(
      messageItems(after.page).filter((item) => item.turnEnd !== undefined),
      [],
      "応答 item の結末もメモリのみなので、復元後は載らない",
    );
    await restored.close();
  } finally {
    await rm(first.storeDir, { recursive: true, force: true });
  }
});

test("追加入力の user item は、自分の送信IDと同じ実行の run id を持つ", async () => {
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 10 }), catalog: createAgentCatalog() });
  const record = await store.create();
  const first = store.postMessage(record, "1つ目");
  // 実行中に積んだ送信は、user への注入時に実行へ割り当てる (受付時点では run id を持たない)
  const second = store.postMessage(record, "2つ目");
  assert.equal(second.queued, true);
  assert.equal(second.runId, undefined);
  await waitFor(() => store.statusOf(record) === "completed", 5000, "runs completion");

  const result = store.history(record, {});
  assert.ok(result.ok);
  const users = messageItems(result.page).filter((item) => item.role === "user");
  assert.deepEqual(
    users.map((item) => [item.text, item.sendId]),
    [
      ["1つ目", first.sendId],
      ["2つ目", second.sendId],
    ],
    "同じ本文でも送信IDで item を区別できる",
  );
  assert.equal(users[0]?.runId, first.runId);
  assert.equal(users[1]?.runId, first.runId, "追加入力は同じ実行に属する");
  assert.equal(users[1]?.runDurationMs, undefined, "所要時間は開始送信にだけ載る");

  await store.close();
});

test("履歴ページの窓より長いターンでも、そのターン最後の本文あり応答 item に結末が載る", async () => {
  const store = new SessionStore({
    pi: createStubPi({
      longTurn: { rounds: 55, replyOf: (round) => `ラウンド ${round + 1}` },
    }),
    catalog: createAgentCatalog(),
  });
  const record = await store.create();
  const posted = store.postMessage(record, "長いターン");
  await waitFor(() => store.statusOf(record) === "completed", 5000, "long turn completion");

  const latest = store.history(record, {});
  assert.ok(latest.ok);
  const items = messageItems(latest.page);
  assert.equal(latest.page.items.length, HISTORY_PAGE_LIMIT_DEFAULT);
  assert.equal(items[0]?.role, "assistant", "最新ページの先頭から user item が落ちる");
  assert.deepEqual(
    items.filter((item) => item.turnEnd !== undefined).map((item) => item.text),
    ["ラウンド 55"],
    "結末が載るのはターン最後の本文あり応答だけ",
  );
  const last = items.at(-1);
  assert.equal(last?.turnEnd?.outcome, "completed");
  assert.equal(typeof last?.turnEnd?.durationMs, "number");

  // user item は古いページに残り、従来どおり run id と結末を持つ (互換のため残す値)
  const all = await collectAllPages(store, record, HISTORY_PAGE_LIMIT_DEFAULT);
  const user = all.find((item) => item.kind === "message" && item.role === "user");
  assert.ok(user?.kind === "message");
  assert.equal(user.runId, posted.runId);
  assert.equal(user.runOutcome, "completed");
  assert.equal(user.turnEnd, undefined, "user item には turnEnd を載せない");

  // ターンの途中で切れた古いページ (最後の応答が選択範囲の外) には載らない
  const cut = store.history(record, { before: latest.page.items[0].id });
  assert.ok(cut.ok);
  assert.equal(cut.page.items.length, 6);
  assert.deepEqual(
    messageItems(cut.page).filter((item) => item.turnEnd !== undefined),
    [],
    "選択範囲の末尾がターンの途中のときは載せない",
  );

  await store.close();
});

test("走っているターンの応答 item には結末を載せない", async () => {
  const store = new SessionStore({
    pi: createStubPi({ longTurn: { rounds: 8, roundDelayMs: 60 } }),
    catalog: createAgentCatalog(),
  });
  const record = await store.create();
  store.postMessage(record, "長いターン");

  // 応答が履歴に載った時点で、まだ run は終端していない
  await waitFor(
    () => {
      const result = store.history(record, {});
      return (
        result.ok &&
        messageItems(result.page).some((item) => item.role === "assistant") &&
        store.statusOf(record) === "running"
      );
    },
    5000,
    "running history",
  );

  const during = store.history(record, {});
  assert.ok(during.ok);
  assert.deepEqual(
    messageItems(during.page).filter((item) => item.turnEnd !== undefined),
    [],
    "run の結末を持つのは終端したターンだけ",
  );

  await waitFor(() => store.statusOf(record) === "completed", 5000, "long turn completion");
  const after = store.history(record, {});
  assert.ok(after.ok);
  assert.equal(messageItems(after.page).at(-1)?.turnEnd?.outcome, "completed", "終端すると最後の応答に載る");

  await store.close();
});

test("停止した本文なし応答のツールは、次のターンの後も自分のターンの item に残る", async () => {
  // What: 停止 (abort) で本文の無いまま終わった応答のツールを、次のターンを完了した後も
  // 履歴・payload・件数のすべてで同じ 1 か所に残す
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: text("前の質問") });
  session.appendMessage({ role: "assistant", content: text("旧回答"), stopReason: "stop" });
  // 本文なし応答の bash を実行中に停止した JSONL (SDK は abort の toolResult と空の error 応答を残す)
  session.appendMessage({ role: "user", content: text("停止用") });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "work-stop", name: "bash", arguments: { command: "sleep 120" } }],
    stopReason: "toolUse",
  });
  session.appendMessage({
    role: "toolResult",
    toolCallId: "work-stop",
    content: text("This operation was aborted"),
    isError: true,
  });
  session.appendMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "This operation was aborted",
  });
  // 同じ会話で次の run を完了させる
  session.appendMessage({ role: "user", content: text("次の質問") });
  session.appendMessage({ role: "assistant", content: text("次の回答"), stopReason: "stop" });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const page = result.page;
  const items = messageItems(page);
  assert.deepEqual(
    items.map((item) => [item.role, item.text]),
    [
      ["user", "前の質問"],
      ["assistant", "旧回答"],
      ["user", "停止用"],
      ["assistant", ""],
      ["user", "次の質問"],
      ["assistant", "次の回答"],
    ],
    "本文の無い応答も、ツールの繰り上げ先が無いターンでは item にする",
  );
  const stopped = items[3];
  assert.deepEqual(
    stopped.tools?.map((call) => [call.id, call.done, call.isError, call.output]),
    [["work-stop", true, true, "This operation was aborted"]],
    "停止したツールを中止の結果つきで残す",
  );
  assert.equal(stopped.context, "active");
  assert.equal(items.at(-1)?.tools, undefined, "次のターンの本文へツールを繰り上げない");
  assert.equal(page.messageCount, 6, "件数も item と同じ集合で数える");

  // payload (履歴 API を使えない経路) と一覧の件数も同じ集合になる
  assert.deepEqual(
    store.payload(record).messages.map((message) => message.text),
    ["前の質問", "旧回答", "停止用", "", "次の質問", "次の回答"],
  );
  assert.equal(store.summary(record).messageCount, page.messageCount);

  // 古い側のページを 1 件ずつ遡っても、停止したツールは 1 件だけ現れる
  const all = await collectAllPages(store, record, 1);
  const cards = all.flatMap((item) => (item.kind === "message" ? (item.tools ?? []) : []));
  assert.deepEqual(
    cards.map((call) => call.id),
    ["work-stop"],
  );

  await store.close();
});

test("同じターンに本文なしツール応答が複数あるとき、所有者ごとに item を残す", async () => {
  // What: 停止したターンに本文なしツール応答が A → B と続くとき、A のツールを B の item へ寄せず、
  // それぞれの応答の item・payload・件数・ページングで同じ所有者に残す
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: text("前の質問") });
  session.appendMessage({ role: "assistant", content: text("旧回答"), stopReason: "stop" });
  // 本文なし応答 A → B が続いたまま停止した JSONL (最後に空の error 応答が付く)
  session.appendMessage({ role: "user", content: text("停止用") });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "work-a", name: "bash", arguments: { command: "pwd" } }],
    stopReason: "toolUse",
  });
  session.appendMessage({ role: "toolResult", toolCallId: "work-a", content: text("ok"), isError: false });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "work-b", name: "bash", arguments: { command: "sleep 120" } }],
    stopReason: "toolUse",
  });
  session.appendMessage({ role: "toolResult", toolCallId: "work-b", content: text("aborted"), isError: true });
  session.appendMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "This operation was aborted",
  });
  // 同じ会話で次の run を完了させる
  session.appendMessage({ role: "user", content: text("次の質問") });
  session.appendMessage({ role: "assistant", content: text("次の回答"), stopReason: "stop" });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const page = result.page;
  const items = messageItems(page);
  assert.deepEqual(
    items.map((item) => [item.role, item.text, item.tools?.map((call) => call.id) ?? []]),
    [
      ["user", "前の質問", []],
      ["assistant", "旧回答", []],
      ["user", "停止用", []],
      ["assistant", "", ["work-a"]],
      ["assistant", "", ["work-b"]],
      ["user", "次の質問", []],
      ["assistant", "次の回答", []],
    ],
    "本文なしのツール応答は所有者ごとに item にする",
  );
  assert.equal(page.messageCount, 7, "件数も item と同じ集合で数える");
  assert.equal(page.summarizedMessageCount, 0);

  // payload (履歴 API を使えない経路) と一覧の件数も同じ集合になる
  assert.deepEqual(
    store.payload(record).messages.map((message) => message.text),
    ["前の質問", "旧回答", "停止用", "", "", "次の質問", "次の回答"],
  );
  assert.equal(store.summary(record).messageCount, page.messageCount);

  // 古い側のページを 1 件ずつ遡っても、A と B のツールが 1 件ずつ・重複なく現れる
  const all = await collectAllPages(store, record, 1);
  assert.deepEqual(
    all.flatMap((item) => (item.kind === "message" ? (item.tools ?? []).map((call) => call.id) : [])),
    ["work-a", "work-b"],
  );
  assert.equal(new Set(all.map((item) => item.id)).size, all.length, "ページを跨いで item を重複させない");

  await store.close();
});

test("同じターンの後に本文の応答があるとき、本文なし応答のツールは従来どおり本文へ繰り上げる", async () => {
  // What: A(本文なし) → B(本文なし) → C(本文) のターンは、本文なし item を増やさず、a と b を
  // C のカードへ集める (live が同じ持ち主へ収束できるように、所有者の正は従来どおり C)
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;

  session.appendMessage({ role: "user", content: text("確認して") });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "work-a", name: "bash", arguments: { command: "pwd" } }],
    stopReason: "toolUse",
  });
  session.appendMessage({ role: "toolResult", toolCallId: "work-a", content: text("ok"), isError: false });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "work-b", name: "bash", arguments: { command: "ls" } }],
    stopReason: "toolUse",
  });
  session.appendMessage({ role: "toolResult", toolCallId: "work-b", content: text("ok"), isError: false });
  session.appendMessage({ role: "assistant", content: text("answer-C"), stopReason: "stop" });

  const result = store.history(record, {});
  assert.ok(result.ok);
  const page = result.page;
  const items = messageItems(page);
  assert.deepEqual(
    items.map((item) => [item.role, item.text, item.tools?.map((call) => call.id) ?? []]),
    [
      ["user", "確認して", []],
      ["assistant", "answer-C", ["work-a", "work-b"]],
    ],
    "本文の応答があるターンでは本文なし item を増やさない",
  );
  assert.equal(page.messageCount, 2);
  assert.deepEqual(
    store.payload(record).messages.map((message) => [message.text, message.tools?.map((call) => call.id) ?? []]),
    [
      ["確認して", []],
      ["answer-C", ["work-a", "work-b"]],
    ],
    "payload も同じ所有者で投影する",
  );
  assert.equal(store.summary(record).messageCount, page.messageCount);

  await store.close();
});

test("ターン末尾の本文なしツール応答ではなく、最後の本文あり応答に結末を載せる", async () => {
  const store = new SessionStore({ pi: createStubPi(), catalog: createAgentCatalog() });
  const record = await store.create();
  const session = record.session as unknown as StubSession;
  const userMessage = { role: "user", content: "依頼" };
  session.appendMessage(userMessage);
  session.appendMessage({ role: "assistant", content: text("本文あり"), stopReason: "stop" });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-stopped", name: "read", arguments: { path: "a.txt" } }],
    stopReason: "aborted",
  });
  session.appendMessage({ role: "toolResult", content: text("結果"), toolCallId: "call-stopped", isError: false });
  record.userMessageSends.set(userMessage, { sendId: "send-stopped", runId: "run-stopped" });
  record.runInitialSends.set("run-stopped", "send-stopped");
  record.runOutcomes.set("run-stopped", { durationMs: 123, outcome: "stopped" });

  const result = store.history(record, {});
  assert.ok(result.ok);
  assert.deepEqual(
    messageItems(result.page)
      .filter((item) => item.turnEnd !== undefined)
      .map((item) => item.text),
    ["本文あり"],
    "本文の無い item へ結末を移すとクライアントが Stopped を落とす",
  );
  await store.close();
});
