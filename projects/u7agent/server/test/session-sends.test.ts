// 送信対応記録 (sends.json) の検証。再起動を跨いだ送信エコーの同一性と、保存されなかった送信の
// 「未送信」表示を stub で再現する。実 API は使わない。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createBffApp } from "../src/app";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import {
  readSessionSends,
  serializeSession,
  sessionHeaderOf,
  sessionJsonlPath,
  sessionSendsPath,
  writeSessionSends,
  type SessionSends,
} from "../src/session-store";
import { SessionStore } from "../src/sessions";
import type { EventEntry, HistoryItem, HistoryPage, SessionPayload } from "../src/schema";
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
  options: {
    masker?: ReturnType<typeof createSecretMasker>;
    /** 送信対応記録の書込みを差し替える (書込み失敗の再試行の検証用) */
    writeSends?: (storeDir: string, id: string, sends: SessionSends) => void;
  } = {},
): SessionStore {
  return new SessionStore({
    pi,
    catalog: createAgentCatalog(),
    storeDir,
    workspace: stubWorkspace(),
    rootCwd: "/tmp/project",
    ...(options.masker ? { masker: options.masker } : {}),
    ...(options.writeSends ? { writeSends: options.writeSends } : {}),
  });
}

function userItems(page: HistoryPage) {
  return page.items.filter(
    (item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  );
}

/** JSONL の user entry に写した run id (entry id -> runId)。run 対応の正 */
async function jsonlRunIds(storeDir: string, id: string): Promise<Record<string, string>> {
  const text = await readFile(sessionJsonlPath(id, storeDir), "utf8");
  const runs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const entry = JSON.parse(line) as { type?: unknown; id?: unknown; u7agentRunId?: unknown };
    if (entry.type !== "message" || typeof entry.id !== "string") continue;
    if (typeof entry.u7agentRunId === "string") runs[entry.id] = entry.u7agentRunId;
  }
  return runs;
}

function pageOf(store: SessionStore, record: Parameters<SessionStore["history"]>[0]): HistoryPage {
  const result = store.history(record, {});
  assert.ok(result.ok, "cursor は既知のはず");
  return result.page;
}

function unsentOf(payload: SessionPayload) {
  return (payload.pendingSends ?? []).map((item) => [item.text, item.runId]);
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
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("未送信メッセージは同じ run id で再送でき、保存済みの生の本文を使う", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  const raw = "sk-test-secret を含む本文";
  const masker = createSecretMasker(["sk-test-secret"]);
  try {
    const ids = await restartWithQueuedSameText(storeDir, raw);
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, pi2, { masker });
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
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    // 停止は最終保存を待たないため、保存済みの run を未送信から外すまで待つ
    await store2.flush(restored);
    assert.equal(store2.discardUnsent(restored, queued.runId), "ok", "キューを破棄したあとは消せる");
    assert.deepEqual(unsentOf(store2.payload(restored)), []);
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("旧保存データ (注記も sends.json も無い / sends.json が壊れている) でも復元でき、縮退して読める", async () => {
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

    // 注記を導入する前の保存データ (entry に run id が無い) を作り、sends.json も消す
    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const lines = text.split("\n").filter((line) => line !== "");
    const stripped = lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      delete entry.u7agentRunId;
      return JSON.stringify(entry);
    });
    await writeFile(sessionJsonlPath(record.id, storeDir), `${stripped.join("\n")}\n`);
    await rm(sessionSendsPath(record.id, storeDir));
    const pi2 = createStubPi();
    const store2 = createStore(storeDir, pi2);
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.text, item.runId]),
      [["旧データの本文", undefined]],
      "注記が無ければ run id 無しの履歴として読める",
    );
    assert.deepEqual(unsentOf(store2.payload(restored)), []);
    await store2.close();

    // 壊れた sends.json は空へ縮退し、entry の注記から run 対応を復元する
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
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    // 停止は最終保存を待たないため、保存済みの run を未送信から外すまで待つ
    await store.flush(record);
    await store.stop(record);
    await store.flush(record);
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
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    assert.equal(payload.pendingSends?.[0]?.at !== undefined, true, "受理時刻を載せる");

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
    // 再送した run の entry が保存され、未送信の一覧から消えるまで待つ
    let after = (await (await bff2.app.request(`/api/sessions/${created.sessionId}`)).json()) as SessionPayload;
    for (let attempt = 0; attempt < 100 && (after.pendingSends ?? []).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = (await (await bff2.app.request(`/api/sessions/${created.sessionId}`)).json()) as SessionPayload;
    }
    assert.deepEqual(unsentOf(after), [], "再送が entry になれば未送信から消える");
    await bff2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("sends.json の書込みに失敗しても次の保存で再試行し、保存済みの送信を未送信に残さない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  let failures = 1;
  const attempts: string[] = [];
  try {
    const pi = createStubPi({ chunkDelayMs: 1 });
    const store = createStore(storeDir, pi, {
      writeSends: (dir, id, sends) => {
        attempts.push(id);
        if (failures > 0) {
          failures -= 1;
          throw new Error("stub disk full");
        }
        writeSessionSends(dir, id, sends);
      },
    });
    await store.init();
    const record = await store.create();
    const posted = store.postMessage(record, "保存される本文");
    assert.ok(posted.runId);
    assert.equal(attempts.length, 1, "受理時に一度書く (ここでは失敗する)");
    await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");
    await store.flush(record);
    assert.equal(failures, 0, "次の保存で再試行する");
    assert.ok(attempts.length >= 2, "失敗した記録は dirty のまま残り、再試行される");
    const sends = readSessionSends(storeDir, record.id);
    assert.deepEqual(sends.unsent, [], "保存済みの送信は未送信に残らない");
    assert.deepEqual(Object.values(await jsonlRunIds(storeDir, record.id)), [posted.runId], "run 対応は entry に写す");
    await store.close();

    // 再起動しても run id が載り、未送信は空 (古いディスクのまま復元されない)
    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(unsentOf(store2.payload(restored)), []);
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => item.runId),
      [posted.runId],
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("entry の注記があれば、sends.json の未送信が残っていても保存済みとして外す", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi1 = createStubPi({ chunkDelayMs: 1 });
    const store1 = createStore(storeDir, pi1);
    await store1.init();
    const record = await store1.create();
    const posted = store1.postMessage(record, "保存される本文");
    assert.ok(posted.runId);
    await waitFor(() => store1.statusOf(record) === "completed", 3000, "run completion");
    await store1.flush(record);
    await store1.close();

    // 未送信の除去だけ失敗した状態 (entry には注記がある) を作る
    const entryId = Object.keys(await jsonlRunIds(storeDir, record.id))[0];
    assert.ok(entryId);
    await writeFile(
      sessionSendsPath(record.id, storeDir),
      JSON.stringify({ unsent: [{ runId: posted.runId, text: "保存される本文", at: 1 }] }),
    );

    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(unsentOf(store2.payload(restored)), [], "entry の注記を正とする");
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.id, item.runId]),
      [[entryId, posted.runId]],
      "注記から run 対応を復元する",
    );
    assert.equal(store2.resend(restored, posted.runId), undefined, "保存済みの送信は再送できない");
    assert.deepEqual(readSessionSends(storeDir, record.id).unsent, [], "復元の結果を書き直す");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("meta だけの保存では、JSONL にまだ書いていない entry を保存済みにしない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi = createStubPi({ chunkDelayMs: 300 });
    const store = createStore(storeDir, pi);
    await store.init();
    const record = await store.create();
    const session = record.session as StubSession;

    // SDK の entry (メモリ) に user メッセージを足し、run 対応だけを控えた「保存待ち」の状態を作る
    const message = { role: "user", content: "メタ保存だけでは確定しない本文", timestamp: Date.now() };
    const entry = session.appendMessage(message);
    record.userMessageRuns.set(message, "run-meta-only");
    record.unsentSends.push({ runId: "run-meta-only", text: "メタ保存だけでは確定しない本文", at: Date.now() });
    record.sendsDirty = true;

    await store.persist(record, { jsonl: false });
    assert.deepEqual(await jsonlRunIds(storeDir, record.id), {}, "JSONL に無い entry を保存済みにしない");
    assert.deepEqual(
      readSessionSends(storeDir, record.id).unsent.map((item) => item.runId),
      ["run-meta-only"],
      "未送信のまま残る",
    );

    // JSONL の保存が確定した時点で注記を写す
    await store.persist(record);
    assert.deepEqual(await jsonlRunIds(storeDir, record.id), { [entry.id]: "run-meta-only" });
    assert.deepEqual(readSessionSends(storeDir, record.id).unsent, []);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("user entry を残さず終わった run は、未送信として載り再送 / 破棄できる", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const pi = createStubPi({ promptFailureBeforeUser: "No API key for stub/model" });
    const store = createStore(storeDir, pi);
    await store.init();
    const record = await store.create();
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "認証エラーで送れなかった本文");
    assert.ok(first.runId);
    await waitFor(() => store.statusOf(record) === "error", 3000, "run error");
    await store.flush(record);
    assert.deepEqual(
      unsentOf(store.payload(record)),
      [["認証エラーで送れなかった本文", first.runId]],
      "終了した run も未送信として載る (実行中扱いにしない)",
    );
    assert.equal(store.discardUnsent(record, first.runId), "ok", "終了した run の送信は破棄できる");
    const resyncs = events.filter((entry) => entry.type === "resync");
    assert.equal(resyncs.length > 0, true, "破棄は購読者へ resync で配る");
    assert.deepEqual(resyncs.at(-1)?.data.pendingSends, [], "破棄した送信は配らない");

    // 再送は同じ run id で実行し直す (status が error の run を実行中扱いにしない)
    const second = store.postMessage(record, "再送する本文");
    assert.ok(second.runId);
    await waitFor(() => store.statusOf(record) === "error", 3000, "second run error");
    await store.flush(record);
    events.length = 0;
    const resent = store.resend(record, second.runId);
    assert.deepEqual(resent, { queued: false, queueDepth: 0, runId: second.runId });
    assert.equal(
      events.filter((entry) => entry.type === "run_start" && entry.data.runId === second.runId).length,
      1,
      "同じ run id でも実行し直す",
    );
    assert.deepEqual(
      events.filter((entry) => entry.type === "resync")[0]?.data.pendingSends?.map((item) => [item.runId, item.state]),
      [[second.runId, "running"]],
      "再送の受付直後は実行中として配る (別タブは未送信の表示を戻す)",
    );
    await waitFor(() => store.statusOf(record) === "error", 3000, "resent run error");
    await store.flush(record);
    assert.deepEqual(
      events
        .filter((entry) => entry.type === "resync")
        .at(-1)
        ?.data.pendingSends?.map((item) => item.runId),
      [second.runId],
      "再送も user entry を残さず終わったら未送信として配る",
    );
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SDK 形式 (content part 配列) の user entry でも run 対応を復元する", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const store1 = createStore(storeDir, createStubPi({ chunkDelayMs: 1 }));
    await store1.init();
    const record = await store1.create();
    const posted = store1.postMessage(record, "SDK形式の本文");
    assert.ok(posted.runId);
    await waitFor(() => store1.statusOf(record) === "completed", 3000, "run completion");
    await store1.flush(record);
    await store1.close();

    // 実 SDK 0.87 は user message を part 配列で書く。保存済みの entry をその形式に置き換える
    const text = await readFile(sessionJsonlPath(record.id, storeDir), "utf8");
    const parsed = JSON.parse(text.split("\n").filter((line) => line !== "")[1]) as {
      id: string;
      message: { content: unknown };
    };
    assert.equal(parsed.message.content, "SDK形式の本文");
    parsed.message.content = [{ type: "text", text: "SDK形式の本文" }];
    // 注記は entry に残したまま (実 SDK の content 形式でも対応を失わないことを見る)
    await writeFile(
      sessionJsonlPath(record.id, storeDir),
      serializeSession(sessionHeaderOf({ id: record.id, createdAt: 1 }, "."), [parsed]),
    );

    // 未送信の除去だけ失敗した状態から復元する
    await writeFile(
      sessionSendsPath(record.id, storeDir),
      JSON.stringify({ unsent: [{ runId: posted.runId, text: "SDK形式の本文", at: 1 }] }),
    );
    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(unsentOf(store2.payload(restored)), [], "part 配列でも突き合わせる");
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.text, item.runId]),
      [["SDK形式の本文", posted.runId]],
      "本文と run 対応を復元する",
    );
    assert.deepEqual(await jsonlRunIds(storeDir, record.id), { [parsed.id]: posted.runId });
    await store2.close();

    // 正常な対応表は part 配列の entry でも消さない
    const store3 = createStore(storeDir, createStubPi());
    await store3.init();
    const restored3 = await store3.resolve(record.id);
    assert.ok(restored3);
    assert.deepEqual(
      userItems(pageOf(store3, restored3)).map((item) => item.runId),
      [posted.runId],
      "対応を失わない",
    );
    await store3.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("entry の注記が無い同じ本文の旧 entry を未送信の根拠にしない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const store1 = createStore(storeDir, createStubPi());
    await store1.init();
    const record = await store1.create();
    await store1.flush(record);
    await store1.close();

    // 旧保存データ: run 対応を持たない古い user entry (timestamp は送信より前)
    const oldEntry = {
      type: "message",
      id: "entry-old",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "同じ本文", timestamp: 1 },
    };
    await writeFile(
      sessionJsonlPath(record.id, storeDir),
      serializeSession(sessionHeaderOf({ id: record.id, createdAt: 1 }, "."), [oldEntry]),
    );
    await writeFile(
      sessionSendsPath(record.id, storeDir),
      JSON.stringify({
        entries: {},
        unsent: [{ runId: "run-new", text: "同じ本文", at: Date.now() }],
      }),
    );

    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(
      unsentOf(store2.payload(restored)),
      [["同じ本文", "run-new"]],
      "注記の無い entry へ黙って吸収しない (未送信として残す)",
    );
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.id, item.runId]),
      [["entry-old", undefined]],
      "注記の無い entry には run 対応を付けない",
    );
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("保存中に SDK が追記した entry は、次の保存まで保存済みにしない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    // run を保留したままにして、message_end の persist 以外が走らないようにする
    const store = createStore(storeDir, createStubPi({ chunkDelayMs: 60_000 }));
    await store.init();
    const record = await store.create();
    const session = record.session as StubSession;
    store.postMessage(record, "保存する本文");
    await waitFor(() => userItems(pageOf(store, record)).length === 1, 3000, "first entry");
    await store.flush(record);

    // writer.schedule の await 中に SDK が user entry を追記する状況を再現する
    const writer = record.writer;
    assert.ok(writer);
    const original = writer.schedule.bind(writer);
    let lateEntryId: string | undefined;
    writer.schedule = (header, entries) => {
      const pending = original(header, entries);
      if (lateEntryId === undefined) {
        const late = { role: "user", content: "あとから積まれた本文", timestamp: Date.now() };
        lateEntryId = session.appendMessage(late).id;
        record.userMessageRuns.set(late, "run-late");
        record.unsentSends.push({ runId: "run-late", text: "あとから積まれた本文", at: Date.now() });
        record.sendsDirty = true;
      }
      return pending;
    };

    await store.persist(record);
    assert.ok(lateEntryId !== undefined, "追記を再現できた");
    assert.equal((await jsonlRunIds(storeDir, record.id))[lateEntryId], undefined, "await 中の追記を保存済みにしない");
    assert.deepEqual(
      readSessionSends(storeDir, record.id).unsent.map((item) => item.runId),
      ["run-late"],
    );

    // 次の保存で確定する
    await store.persist(record);
    assert.equal((await jsonlRunIds(storeDir, record.id))[lateEntryId], "run-late");
    assert.deepEqual(readSessionSends(storeDir, record.id).unsent, []);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("sends.json だけ書けない record は sweep で破棄しない", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  let failWrites = false;
  try {
    const store = createStore(storeDir, createStubPi({ chunkDelayMs: 1 }), {
      writeSends: (dir, id, sends) => {
        if (failWrites) throw new Error("simulated EIO");
        writeSessionSends(dir, id, sends);
      },
    });
    await store.init();
    const record = await store.create();
    store.postMessage(record, "保存される本文");
    await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");
    await store.flush(record);

    // sends だけ書けない状態を作り、sweep の対象にする
    failWrites = true;
    record.unsentSends.push({ runId: "run-dirty", text: "未送信の本文", at: Date.now() });
    record.sendsDirty = true;
    record.lastUsedAt = Date.now() - 2 * 60 * 60 * 1000;
    await store.sweep();
    assert.equal(record.sendsError !== undefined, true, "失敗を記録する");
    assert.equal(store.records.has(record.id), true, "sends の失敗中はメモリから外さない");

    // 回復したら破棄できる
    failWrites = false;
    await store.flush(record);
    await store.sweep();
    assert.equal(store.records.has(record.id), false);
    await store.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("本文が同じ未送信が複数あっても、entry の注記がある run だけを保存済みとする", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-sends-"));
  try {
    const store1 = createStore(storeDir, createStubPi({ promptFailureBeforeUser: "No API key for stub/model" }));
    await store1.init();
    const record = await store1.create();
    const session = record.session as StubSession;

    // A: user entry を残さず error で終わった送信
    const failed = store1.postMessage(record, "同じ本文");
    assert.ok(failed.runId);
    await waitFor(() => store1.statusOf(record) === "error", 3000, "run error");
    await store1.flush(record);

    // B: 同じ本文で実行され、entry が保存された送信 (注記付き)
    const message = { role: "user", content: "同じ本文", timestamp: Date.now() };
    const entry = session.appendMessage(message);
    record.userMessageRuns.set(message, "run-b");
    record.unsentSends.push({ runId: "run-b", text: "同じ本文", at: Date.now() });
    record.sendsDirty = true;
    await store1.persist(record);
    assert.equal((await jsonlRunIds(storeDir, record.id))[entry.id], "run-b", "entry に注記が載る");
    await store1.close();

    // 未送信の除去だけ失敗した状態 (sends.json には A と B が残る) を作る
    await writeFile(
      sessionSendsPath(record.id, storeDir),
      JSON.stringify({
        unsent: [
          { runId: failed.runId, text: "同じ本文", at: 1 },
          { runId: "run-b", text: "同じ本文", at: 2 },
        ],
      }),
    );

    const store2 = createStore(storeDir, createStubPi());
    await store2.init();
    const restored = await store2.resolve(record.id);
    assert.ok(restored);
    assert.deepEqual(
      unsentOf(store2.payload(restored)),
      [["同じ本文", failed.runId]],
      "entry の注記がある B だけを保存済みとし、A は未送信として残す",
    );
    assert.deepEqual(
      userItems(pageOf(store2, restored)).map((item) => [item.id, item.runId]),
      [[entry.id, "run-b"]],
      "同じ本文でも B の entry に B の run が載る",
    );
    assert.equal(store2.resend(restored, failed.runId)?.runId, failed.runId, "A は再送できる");
    assert.equal(store2.resend(restored, "run-b"), undefined, "B は保存済みで再送できない");
    await store2.close();
  } finally {
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
