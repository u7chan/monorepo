// 追加入力 (steering) の配送状態機械の検証。BFF が待機と実行の所有を持ち、SDK へは同時に
// 1 件だけ渡すこと、取消・停止・終端で未配信入力を失わないことを stub の SDK で固定する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createSecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { writeSessionSends, type SessionSends } from "../src/session-store";
import { SessionStore } from "../src/sessions";
import type { EventEntry, HistoryItem, HistoryPage, SessionPayload } from "../src/schema";
import { createStubPi, waitFor, type StubPiOptions } from "./stub-pi";

function stubWorkspace(): SandboxWorkspaceClient {
  return {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
}

function userItems(page: HistoryPage) {
  return page.items.filter(
    (item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
  );
}

function assistantItems(page: HistoryPage) {
  return page.items.filter(
    (item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message" && item.role === "assistant",
  );
}

type SteeringProbe = {
  steeringOf(record: Parameters<SessionStore["history"]>[0]): { sendId: string } | undefined;
  sdkQueueLength(record: Parameters<SessionStore["history"]>[0]): number;
  steerTask?: Promise<void>;
};

function probeOf(store: SessionStore): SteeringProbe {
  return store as unknown as SteeringProbe;
}

function pageOf(store: SessionStore, record: Parameters<SessionStore["history"]>[0]): HistoryPage {
  const result = store.history(record, {});
  assert.ok(result.ok, "cursor は既知のはず");
  return result.page;
}

function pendingOf(payload: SessionPayload) {
  return (payload.pendingSends ?? []).map((item) => [item.sendId, item.state, item.position]);
}

async function withStore(
  stub: StubPiOptions,
  run: (context: {
    store: SessionStore;
    record: Awaited<ReturnType<SessionStore["create"]>>;
    writes: SessionSends[];
  }) => Promise<void>,
): Promise<void> {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-steering-"));
  const writes: SessionSends[] = [];
  const store = new SessionStore({
    pi: createStubPi(stub),
    catalog: createAgentCatalog(),
    storeDir,
    workspace: stubWorkspace(),
    rootCwd: "/tmp/project",
    masker: createSecretMasker([]),
    writeSends: (dir, id, sends) => {
      writes.push(sends);
      writeSessionSends(dir, id, sends);
    },
  });
  await store.init();
  const record = await store.create();
  try {
    await run({ store, record, writes });
  } finally {
    // 失敗した assertion でも一時ストアを残さない
    await store.close().catch(() => {});
    await rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("実行中の追加入力は新しい run を始めず、同じ実行へ注入される", async () => {
  await withStore({ chunkDelayMs: 20 }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "修正の本文");
    assert.equal(second.queued, true);
    assert.equal(second.runId, undefined, "待機した送信は受付時点で実行IDを持たない");

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);

    const runStarts = events.filter((entry) => entry.type === "run_start");
    const runEnds = events.filter((entry) => entry.type === "run_end");
    assert.equal(runStarts.length, 1, "追加入力は新しい run を始めない");
    assert.equal(runEnds.length, 1, "実行の終端は 1 回だけ");
    assert.equal(
      runStarts[0]?.type === "run_start" ? runStarts[0].data.initialSendId : undefined,
      first.sendId,
      "run_start は開始送信のIDを持つ",
    );

    const page = pageOf(store, record);
    const users = userItems(page);
    assert.deepEqual(
      users.map((item) => [item.text, item.sendId]),
      [
        ["最初の本文", first.sendId],
        ["修正の本文", second.sendId],
      ],
      "同じ本文でなくても送信IDで順に対応する",
    );
    assert.equal(users[0]?.runId, users[1]?.runId, "追加入力は同じ実行に属する");
    assert.equal(users[0]?.runDurationMs !== undefined, true, "所要時間は開始送信だけが持つ");
    assert.equal(users[1]?.runDurationMs, undefined, "追加入力へ複製しない");

    const assistants = assistantItems(page);
    assert.equal(
      assistants.filter((item) => item.turnEnd !== undefined).length,
      1,
      "Done 表示は最後の本文あり応答だけ",
    );
    assert.equal(assistants.at(-1)?.turnEnd?.outcome, "completed");
    assert.deepEqual(pendingOf(store.payload(record)), [], "保存された送信は待機に残らない");

    // 実行の SSE には user 注入ごとの resync が届き、run_end より前に新しい user が載る
    const sequence = events.map((entry) => entry.type);
    assert.ok(sequence.lastIndexOf("resync") > sequence.indexOf("run_start"));
    assert.equal(sequence.at(-2), "run_end");
  });
});

test("待機は BFF から SDK 実キューへ渡り、取り出されたら steering として配る", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 5 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "修正の本文");
    assert.equal(second.queued, true);

    // SDK が実キューに残っている間は取消できる `queued`
    await waitFor(() => probeOf(store).steeringOf(record) !== undefined, 2000, "steering handoff");
    await waitFor(
      () => probeOf(store).steerTask === undefined && probeOf(store).sdkQueueLength(record) === 1,
      2000,
      "steering accepted",
    );
    const accepted = store.payload(record).pendingSends ?? [];
    assert.deepEqual(
      accepted.filter((item) => item.sendId === second.sendId).map((item) => [item.sendId, item.state, item.position]),
      [[second.sendId, "queued", 1]],
      "実キューに残っている間は取り消せる queued",
    );
    assert.equal(first.sendId !== second.sendId, true);

    await store.stop(record);
    await store.flush(record);
    // 開始送信の user entry は保存済みなので待機に残らず、SDK へ渡した分だけが未送信へ戻る
    assert.deepEqual(pendingOf(store.payload(record)), [[second.sendId, "unsent", undefined]]);
    assert.equal(store.statusOf(record) !== "running", true);
    await store.close();
  });
});

test("SDK が取り出した入力の取消は 409 で、取り消せたと偽らない", async () => {
  await withStore({ chunkDelayMs: 500, steerTaken: true }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "修正の本文");
    await waitFor(() => probeOf(store).steeringOf(record) !== undefined, 2000, "steering handoff");
    await probeOf(store).steerTask?.catch(() => {});

    assert.deepEqual(pendingOf(store.payload(record)), [
      [first.sendId, "running", undefined],
      [second.sendId, "steering", 1],
    ]);
    assert.equal(await store.cancelQueued(record, second.sendId), "running", "取り出し後は取消できない");
    // 取り出された入力は注入されないまま実行が終わる
    await store.stop(record);
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.text),
      ["最初の本文"],
    );
  });
});

test("実キューに残る入力の取消は 200 で、後から注入されない", async () => {
  await withStore({ chunkDelayMs: 500 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "取り消す本文");
    await waitFor(() => probeOf(store).steeringOf(record) !== undefined, 2000, "steering handoff");
    await probeOf(store).steerTask?.catch(() => {});

    assert.equal(await store.cancelQueued(record, second.sendId), "ok");
    assert.equal(probeOf(store).sdkQueueLength(record), 0, "実キューからも消える");
    assert.deepEqual(pendingOf(store.payload(record)), [
      [first.sendId, "running", undefined],
      [second.sendId, "unsent", undefined],
    ]);

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId],
      "取り消した入力は注入されない",
    );
    assert.deepEqual(pendingOf(store.payload(record)), [[second.sendId, "unsent", undefined]]);
  });
});

test("同じ本文の2件でも送信IDで片方だけを取り消せる", async () => {
  await withStore({ chunkDelayMs: 500 }, async ({ store, record }) => {
    const first = store.postMessage(record, "同じ本文");
    const second = store.postMessage(record, "同じ本文");
    const third = store.postMessage(record, "同じ本文");
    assert.notEqual(second.sendId, third.sendId);

    assert.equal(await store.cancelQueued(record, second.sendId), "ok");
    const payload = store.payload(record);
    assert.deepEqual(
      payload.pendingSends?.map((item) => [item.sendId, item.state, item.position]),
      [
        [first.sendId, "running", undefined],
        [second.sendId, "unsent", undefined],
        [third.sendId, "queued", 1],
      ],
      "取り消した分だけが未送信へ戻り、後続の順位が繰り上がる",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, third.sendId],
      "同じ本文でも取り消していない 2 件だけが注入される",
    );
  });
});

test("停止は受付中の steering を回収し、停止後に自動配送しない", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 30 }, async ({ store, record }) => {
    store.postMessage(record, "最初の本文");
    const queued = store.postMessage(record, "停止で戻る本文");

    const stopped = await store.stop(record);
    assert.notEqual(stopped.status, "running");
    await store.flush(record);
    assert.deepEqual(pendingOf(store.payload(record)).at(-1), [queued.sendId, "unsent", undefined]);

    // 遅延 pump が走っても停止済みの入力を実行しない
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(store.payload(record).queueDepth, 0, "停止後にキューを残さない");
    assert.equal(store.statusOf(record) !== "running", true);
    const userCount = userItems(pageOf(store, record)).length;
    assert.equal(userCount <= 1, true, "停止後に古い入力を再実行しない");
  });
});

test("終端で未注入の steering を回収し、次の実行へ同じ送信IDで割り当てる", async () => {
  await withStore({ chunkDelayMs: 5, drainSteering: false }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "次の実行になる本文");
    await waitFor(() => events.filter((entry) => entry.type === "run_start").length === 2, 5000, "second run");
    await waitFor(() => store.statusOf(record) === "completed", 5000, "second run completion");
    await store.flush(record);

    const runStarts = events.filter((entry) => entry.type === "run_start");
    assert.equal(runStarts.length, 2);
    assert.equal(
      runStarts[1]?.type === "run_start" ? runStarts[1].data.initialSendId : undefined,
      second.sendId,
      "回収した送信は次の実行の開始送信になる",
    );
    const users = userItems(pageOf(store, record));
    assert.deepEqual(
      users.map((item) => [item.sendId, item.runId]),
      [
        [first.sendId, runStarts[0]?.type === "run_start" ? runStarts[0].data.runId : undefined],
        [second.sendId, runStarts[1]?.type === "run_start" ? runStarts[1].data.runId : undefined],
      ],
      "未注入のまま終わった送信は旧実行へ割り当てない",
    );
  });
});

test("SDK が取り出して注入しなかった入力は未送信として残し、自動で再投入しない", async () => {
  await withStore({ chunkDelayMs: 5, steerTaken: true }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "消費された本文");
    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);

    assert.equal(events.filter((entry) => entry.type === "run_start").length, 1, "自動で再投入しない");
    assert.deepEqual(pendingOf(store.payload(record)), [[second.sendId, "unsent", undefined]]);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId],
      "注入されていない入力を保存済みにしない",
    );
    assert.equal(store.discardUnsent(record, second.sendId), "ok", "未送信として再送 / 破棄できる");
  });
});

test("停止の後は新規送信を 409 にし、回収済みの未送信を再送できる", async () => {
  await withStore({ chunkDelayMs: 500 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const queued = store.postMessage(record, "停止で戻る本文");
    await waitFor(() => probeOf(store).steeringOf(record) !== undefined, 2000, "steering handoff");

    const stopping = store.stop(record);
    assert.throws(() => store.postMessage(record, "停止中の送信"), /stopping/i);
    await stopping;
    await store.flush(record);
    // 開始送信の user entry は保存済みなら待機に残らない。停止で回収した分だけが未送信になる
    assert.deepEqual(
      (store.payload(record).pendingSends ?? []).map((item) => [item.sendId, item.state]),
      [[queued.sendId, "unsent"]],
    );

    // 停止後に未送信を再送すると、同じ送信IDのまま新しい実行で走る
    const resent = store.resend(record, queued.sendId);
    assert.equal(resent?.sendId, queued.sendId);
    assert.notEqual(resent?.runId, undefined);
    await waitFor(() => store.statusOf(record) === "completed", 5000, "resent completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, queued.sendId],
      "停止前に保存された送信の後に、再送した送信だけが 1 回ずつ載る",
    );
  });
});

test("steering 中でも pendingSends と queueDepth は BFF と SDK の未注入分を数える", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 5, steering: false }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "待機の本文");
    const third = store.postMessage(record, "次の待機の本文");
    const payload = store.payload(record);
    assert.equal(payload.queueDepth, 2, "SDK へ渡していない分も上限と件数に数える");
    assert.deepEqual(pendingOf(payload), [
      [first.sendId, "running", undefined],
      [second.sendId, "queued", 1],
      [third.sendId, "queued", 2],
    ]);
  });
});

test("SDK の user 注入を観測した時点で resync を配り、待機から実行中へ移す", async () => {
  await withStore({ chunkDelayMs: 50 }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "修正の本文");

    await waitFor(
      () =>
        events.some(
          (entry) =>
            entry.type === "resync" &&
            (entry.data.pendingSends ?? []).some((item) => item.sendId === second.sendId && item.state === "running"),
        ),
      3000,
      "steering injected",
    );
    const injectedResync = events.find(
      (entry) =>
        entry.type === "resync" &&
        (entry.data.pendingSends ?? []).some((item) => item.sendId === second.sendId && item.state === "running"),
    );
    assert.ok(injectedResync, "注入を観測した resync が届く");
    const runStartIndex = events.findIndex((entry) => entry.type === "run_start");
    assert.ok(runStartIndex >= 0 && events.indexOf(injectedResync) > runStartIndex);
    assert.equal(first.sendId !== second.sendId, true);
  });
});
