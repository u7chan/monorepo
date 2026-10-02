// 送信対応記録 (sends.json) の検証。再起動を跨いだ送信エコーの同一性と、保存されなかった送信の
// 「未送信」表示を stub で再現する。実 API は使わない。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { readSessionSends, sessionSendsPath } from "../src/session-store";
import { SessionStore } from "../src/sessions";
import type { HistoryItem, HistoryPage, SessionPayload } from "../src/schema";
import { asPiBff, createStubPi, waitFor, type StubSession } from "./stub-pi";

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
}

function createStore(
  storeDir: string,
  pi: ReturnType<typeof createStubPi>,
  masker?: ReturnType<typeof createSecretMasker>,
): SessionStore {
  return new SessionStore({
    pi,
    catalog: createAgentCatalog(),
    storeDir,
    workspace: stubWorkspace(),
    rootCwd: "/tmp/project",
    ...(masker ? { masker } : {}),
  });
}

function userItems(page: HistoryPage) {
  return page.items.filter(
    (item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  );
}

function pageOf(store: SessionStore, record: Parameters<SessionStore["history"]>[0]): HistoryPage {
  const result = store.history(record, {});
  assert.ok(result.ok, "cursor は既知のはず");
  return result.page;
}

function unsentOf(payload: SessionPayload) {
  return (payload.unsentMessages ?? []).map((item) => [item.text, item.runId]);
}

/** 実行中の送信 (別タブ相当) と同じ本文をキューへ積み、entry が保存された状態で再起動する */
async function restartWithQueuedSameText(storeDir: string, text: string) {
  const pi1 = createStubPi({ chunkDelayMs: 200 });
  const store1 = createStore(storeDir, pi1);
  await store1.init();
  const record = await store1.create();
  const first = store1.postMessage(record, text);
  const second = store1.postMessage(record, text);
  assert.equal(second.queued, true, "実行中の送信はキューへ積まれる");
  assert.notEqual(first.runId, second.runId, "キュー受付でも run id は別に振られる");
  assert.ok(first.runId);
  assert.ok(second.runId);
  // 実行中の送信の user entry が保存されるまで待ってから、再起動 (abort + flush) する
  await waitFor(() => userItems(pageOf(store1, record)).length === 1, 3000, "first entry persisted");
  await store1.close();
  return { recordId: record.id, firstRunId: first.runId, queuedRunId: second.runId };
}

test("再起動後も保存済み user item の run id が載り、未保存の同一文面は未送信として区別できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const ids = await restartWithQueuedSameText(storeDir, "同じ本文");
    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(ids.recordId);
    assert.ok(restored);

    const page = pageOf(store2, restored);
    assert.deepEqual(
      userItems(page).map((item) => [item.text, item.runId]),
      [["同じ本文", ids.firstRunId]],
      "保存済み item の run id は再起動を跨いで保たれる",
    );
    assert.deepEqual(
      unsentOf(store2.payload(restored)),
      [["同じ本文", ids.queuedRunId]],
      "保存されなかった送信は未送信として載る (保存済み item の run id とは別)",
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("同一文面を2件保存したあとの再起動でも、item の run id が2件とも保たれる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, pi1);
    await store1.init();
    const record = await store1.create();
    const first = store1.postMessage(record, "同じ本文");
    const second = store1.postMessage(record, "同じ本文");
    assert.equal(second.queued, true);
    await waitFor(() => store1.statusOf(record) === "completed", 5000, "runs completion");
    await store1.flush(record);
    await store1.close();

    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.text, item.runId]),
      [
        ["同じ本文", first.runId],
        ["同じ本文", second.runId],
      ],
      "同じ本文でも run id で 1:1 に対応できる",
    );
    assert.deepEqual(unsentOf(store2.payload(restored)), [], "保存済みの送信は未送信に残らない");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未送信メッセージは同じ run id で再送でき、保存済みの生の本文を使う", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  const raw = "sk-test-secret を含む本文";
  const masker = createSecretMasker(["sk-test-secret"]);
  try {
    const ids = await restartWithQueuedSameText(storeDir, raw);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, pi2, masker);
    await store2.init();
    const restored = await store2.resolve(ids.recordId);
    assert.ok(restored);
    // payload は表示用にマスク済み (ブラウザへ生の秘密値を配らない)
    assert.deepEqual(
      unsentOf(store2.payload(restored)),
      [[raw.replace("sk-test-secret", REDACTED), ids.queuedRunId]],
      "未送信の本文はマスクして配る",
    );

    const resent = store2.resend(restored, ids.queuedRunId);
    assert.deepEqual(resent, { queued: false, queueDepth: 0, runId: ids.queuedRunId }, "同じ run id で実行する");
    assert.equal(store2.resend(restored, ids.queuedRunId)?.runId, ids.queuedRunId, "実行中の二重の再送は重ねない");
    await waitFor(() => store2.statusOf(restored) === "completed", 5000, "resent run completion");
    await store2.flush(restored);

    // モデルへはマスク前の本文を渡す (表示用のマスク済み本文を送り直さない)
    const entries = (pi2.sessions[0] as StubSession).entries;
    const resentUser = entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => entry.message?.content)
      .at(-1);
    assert.equal(resentUser, raw, "再送は保存済みの生テキストを渡す");
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.text, item.runId]),
      [
        [raw.replace("sk-test-secret", REDACTED), ids.firstRunId],
        [raw.replace("sk-test-secret", REDACTED), ids.queuedRunId],
      ],
      "再送した entry にも同じ run id が載る",
    );
    assert.deepEqual(unsentOf(store2.payload(restored)), [], "entry が保存されたら未送信から消える");
    assert.deepEqual(readSessionSends(storeDir, ids.recordId).unsent, []);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("未送信メッセージは破棄でき、再送が実行中の分は消せない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const ids = await restartWithQueuedSameText(storeDir, "破棄する本文");
    const store2 = createStore(storeDir, createStubPi({ chunkDelayMs: 200 }));
    await store2.init();
    const restored = await store2.resolve(ids.recordId);
    assert.ok(restored);

    assert.equal(store2.discardUnsent(restored, "unknown-run"), "missing");
    assert.equal(store2.resend(restored, ids.queuedRunId)?.runId, ids.queuedRunId);
    assert.equal(store2.discardUnsent(restored, ids.queuedRunId), "running", "再送の実行中は破棄できない");
    await waitFor(() => store2.statusOf(restored) === "completed", 5000, "resent run completion");
    await store2.flush(restored);
    // entry が保存されているので、破棄ではなく保存済みとして消える
    assert.equal(store2.discardUnsent(restored, ids.queuedRunId), "missing");

    // 実行中 / キュー待ちの送信は消せず、停止でキューを破棄したあとなら消せる
    store2.postMessage(restored, "実行中の本文");
    const queued = store2.postMessage(restored, "あとで破棄する本文");
    assert.equal(queued.queued, true);
    assert.ok(queued.runId);
    assert.equal(store2.discardUnsent(restored, queued.runId), "running", "キュー待ちも実行中として扱う");
    await store2.stop(restored);
    assert.equal(store2.discardUnsent(restored, queued.runId), "ok", "キューを破棄したあとは消せる");
    assert.deepEqual(unsentOf(store2.payload(restored)), []);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("旧保存データ (sends.json が無い / 壊れている) でも復元でき、縮退して読める", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, pi1);
    await store1.init();
    const record = await store1.create();
    store1.postMessage(record, "旧データの本文");
    await waitFor(() => store1.statusOf(record) === "completed", 3000, "run completion");
    await store1.flush(record);
    await store1.close();

    // 旧保存データ (送信対応記録が無い) は run id 無しの履歴として読める
    await rm(sessionSendsPath(record.id, storeDir));
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, pi2);
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.text, item.runId]),
      [["旧データの本文", undefined]],
    );
    assert.deepEqual(unsentOf(store2.payload(restored)), []);
    await store2.close();

    // 壊れた記録は空へ縮退し、復元を止めない
    await writeFile(sessionSendsPath(record.id, storeDir), "{ this is not json");
    const store3 = createStore(storeDir, createStubPi());
    await store3.init();
    const restored3 = await store3.resolve(record.id);
    assert.ok(restored3);
    assert.deepEqual(unsentOf(store3.payload(restored3)), []);
    assert.deepEqual(
      userItems(pageOf(store3, restored3)).map((item) => item.text),
      ["旧データの本文"],
    );
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("停止でキューを破棄した送信は、次の payload で未送信として載る", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi = createStubPi({ chunkDelayMs: 200 });
    const store = createStore(storeDir, pi);
    await store.init();
    const record = await store.create();
    store.postMessage(record, "実行する本文");
    const queued = store.postMessage(record, "破棄される本文");
    assert.equal(queued.queued, true);
    await waitFor(() => userItems(pageOf(store, record)).length === 1, 3000, "first entry persisted");
    await store.stop(record);
    assert.deepEqual(
      record.events.find((entry) => entry.type === "queue_cleared")?.data,
      { runIds: [queued.runId] },
      "破棄した待機分の run id を配る",
    );
    assert.deepEqual(
      unsentOf(store.payload(record)),
      [["破棄される本文", queued.runId]],
      "実行前のキューを破棄した送信は未送信として残る",
    );
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.text),
      ["実行する本文"],
      "破棄した送信は entry にならない",
    );
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("POST /messages の resendRunId と DELETE /unsent で、未送信の再送と破棄ができる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  const workspace = stubWorkspace();
  try {
    // 1 つ目の BFF でキュー中の送信を残して終了し、2 つ目の BFF で再開する
    const pi1 = createStubPi({ chunkDelayMs: 200 });
    const bff1 = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: storeDir, workspace, pi: asPiBff(pi1) });
    const created = (await (
      await bff1.app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { sessionId: string };
    const first = (await (
      await bff1.app.request(`/api/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "同じ本文" }),
      })
    ).json()) as { runId: string };
    const queued = (await (
      await bff1.app.request(`/api/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "同じ本文" }),
      })
    ).json()) as { queued: boolean; runId: string };
    assert.equal(queued.queued, true);
    await waitFor(
      () => {
        const payload = pi1.sessions[0] as StubSession;
        return (
          payload.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length === 1
        );
      },
      3000,
      "first entry persisted",
    );
    await bff1.close();

    const pi2 = createStubPi({ chunkDelayMs: 200 });
    const bff2 = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: storeDir, workspace, pi: asPiBff(pi2) });
    const payload = (await (await bff2.app.request(`/api/sessions/${created.sessionId}`)).json()) as SessionPayload;
    assert.deepEqual(unsentOf(payload), [["同じ本文", queued.runId]]);
    assert.equal(payload.unsentMessages?.[0]?.at !== undefined, true, "受理時刻を載せる");

    const history = (await (
      await bff2.app.request(`/api/sessions/${created.sessionId}/history`)
    ).json()) as HistoryPage;
    assert.deepEqual(
      userItems(history).map((item) => [item.text, item.runId]),
      [["同じ本文", first.runId]],
    );

    // 保存済み / 未知の run id の再送は 409
    const conflict = await bff2.app.request(`/api/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resendRunId: first.runId }),
    });
    assert.equal(conflict.status, 409);

    // 未送信の破棄は 200、二度目は 404
    const discarded = await bff2.app.request(`/api/sessions/${created.sessionId}/unsent/${queued.runId}`, {
      method: "DELETE",
    });
    assert.equal(discarded.status, 200);
    assert.deepEqual(await discarded.json(), { ok: true });
    const again = await bff2.app.request(`/api/sessions/${created.sessionId}/unsent/${queued.runId}`, {
      method: "DELETE",
    });
    assert.equal(again.status, 404);

    // 未送信を作り直して再送し、同じ run id で実行されることを確かめる
    const running = (await (
      await bff2.app.request(`/api/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "再送の前座" }),
      })
    ).json()) as { queued: boolean; runId: string };
    assert.equal(running.queued, false, "空いているセッションでは即座に実行する");
    const queued2 = (await (
      await bff2.app.request(`/api/sessions/${created.sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "再送する本文" }),
      })
    ).json()) as { queued: boolean; runId: string };
    assert.equal(queued2.queued, true, "実行中の送信はキューへ積まれる");
    const resent = await bff2.app.request(`/api/sessions/${created.sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resendRunId: queued2.runId }),
    });
    assert.equal(resent.status, 202);
    assert.deepEqual(await resent.json(), {
      sessionId: created.sessionId,
      status: "running",
      queued: true,
      queueDepth: 1,
      runId: queued2.runId,
    });
    await waitFor(() => (pi2.sessions[0] as StubSession).entries.length >= 6, 5000, "resent entries persisted");
    const after = (await (await bff2.app.request(`/api/sessions/${created.sessionId}`)).json()) as SessionPayload;
    assert.deepEqual(unsentOf(after), [], "再送が entry になれば未送信から消える");
    await bff2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
