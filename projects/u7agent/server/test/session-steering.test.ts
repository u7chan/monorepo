// 追加入力 (steering) の配送状態機械の検証。BFF が待機と実行の所有を持ち、受付済みの待機を SDK へ
// まとめて渡すこと、取消・停止・終端で未配信入力を失わないことを stub の SDK で固定する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { createSecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { sdkQueueLength } from "../src/session-steering";
import { writeSessionSends, type SessionSends } from "../src/session-store";
import { SessionStore, type SessionRecord } from "../src/sessions";
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

/** BFF が受付チェーンへ載せた待機 (実キューに入ったかは `steered` で分ける) */
function handedOffOf(record: SessionRecord): SessionRecord["queue"] {
  return record.queue.filter((item) => item.handedOff === true);
}

/** 受付チェーンの完了を待つ (各段の解決で `steered` が確定する) */
async function settleSteering(record: SessionRecord): Promise<void> {
  await record.steerTask?.catch(() => {});
}

function pageOf(store: SessionStore, record: SessionRecord): HistoryPage {
  const result = store.history(record, {});
  assert.ok(result.ok, "cursor は既知のはず");
  return result.page;
}

function pendingOf(payload: SessionPayload) {
  return (payload.pendingSends ?? []).map((item) => [item.sendId, item.state, item.position]);
}

function runStarts(events: EventEntry[]) {
  return events.flatMap((entry) => (entry.type === "run_start" ? [entry.data] : []));
}

async function withStore(
  stub: StubPiOptions,
  run: (context: { store: SessionStore; record: SessionRecord; writes: SessionSends[] }) => Promise<void>,
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

test("受付済みの待機はまとめて SDK へ渡り、1 回のモデル判断で注入される", async () => {
  await withStore({ chunkDelayMs: 200 }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "追加入力A");
    const b = store.postMessage(record, "追加入力B");
    const c = store.postMessage(record, "追加入力C");

    await waitFor(() => handedOffOf(record).length === 3, 2000, "all sends handed off");
    await settleSteering(record);
    assert.equal(sdkQueueLength(record), 3, "先頭の注入を待たずに全件が実キューへ入る");
    assert.deepEqual(
      (store.payload(record).pendingSends ?? [])
        .filter((item) => item.sendId !== first.sendId)
        .map((item) => [item.sendId, item.state, item.position]),
      [
        [a.sendId, "queued", 1],
        [b.sendId, "queued", 2],
        [c.sendId, "queued", 3],
      ],
      "実キューに残る間は先頭から順に取り消せる queued",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);

    const starts = runStarts(events);
    assert.equal(starts.length, 1, "追加入力は新しい run を始めない");
    assert.equal(starts[0]?.initialSendId, first.sendId);
    const users = userItems(pageOf(store, record));
    assert.deepEqual(
      users.map((item) => item.sendId),
      [first.sendId, a.sendId, b.sendId, c.sendId],
      "受付順に欠落なく 1 回ずつ注入する",
    );
    assert.equal(new Set(users.map((item) => item.runId)).size, 1, "まとめて注入した 3 件は同じ実行に属する");
    // 3 件の追加入力は 1 回の assistant 応答にまとまる (元の応答と合わせて 2 件)
    const assistants = assistantItems(pageOf(store, record));
    assert.equal(assistants.length, 2, "追加入力 3 件で応答は 1 回だけ");
    assert.deepEqual(pendingOf(store.payload(record)), [], "注入済みは待機に残らない");
  });
});

test("待機は BFF から SDK 実キューへ渡り、取り出されたら steering として配る", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 5 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "修正の本文");
    assert.equal(second.queued, true);

    // SDK が実キューに残っている間は取消できる `queued`
    await waitFor(() => handedOffOf(record).length === 1, 2000, "steering handoff");
    await settleSteering(record);
    assert.equal(sdkQueueLength(record), 1, "実キューに入った");
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
    await waitFor(() => handedOffOf(record).length === 1, 2000, "steering handoff");
    await settleSteering(record);

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
    await waitFor(() => handedOffOf(record).length === 1, 2000, "steering handoff");
    await settleSteering(record);

    assert.equal(await store.cancelQueued(record, second.sendId), "ok");
    assert.equal(sdkQueueLength(record), 0, "実キューからも消える");
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

test("実キューに残る入力を取り消すと、残りは渡し直して次の判断へ回す", async () => {
  await withStore({ chunkDelayMs: 500 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "取り消す本文");
    const b = store.postMessage(record, "残る本文");
    await waitFor(() => handedOffOf(record).length === 2, 2000, "steering handoff");
    await settleSteering(record);
    assert.equal(sdkQueueLength(record), 2, "2 件とも実キューにある");

    assert.equal(await store.cancelQueued(record, a.sendId), "ok");
    // 実キューは一括でしか捨てられないため、残りの B は受付チェーンへ載せ直す
    await waitFor(
      () => record.queue.some((item) => item.sendId === b.sendId && item.steered === true),
      2000,
      "re-handoff",
    );
    assert.equal(sdkQueueLength(record), 1, "残った 1 件だけが実キューへ戻る");
    assert.deepEqual(
      pendingOf(store.payload(record)).map(([sendId, state]) => [sendId, state]),
      [
        [first.sendId, "running"],
        [a.sendId, "unsent"],
        [b.sendId, "queued"],
      ],
      "取り消した分だけが未送信になり、残りは取消できる queued のまま",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, b.sendId],
      "取り消した入力だけが注入されない",
    );
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

test("並行する 2 件の取消は直列化され、どちらも未送信へ戻る", async () => {
  await withStore({ chunkDelayMs: 500 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "取り消す本文A");
    const b = store.postMessage(record, "取り消す本文B");
    await waitFor(() => handedOffOf(record).length === 2, 2000, "steering handoff");
    await settleSteering(record);

    const results = await Promise.all([store.cancelQueued(record, a.sendId), store.cancelQueued(record, b.sendId)]);
    assert.deepEqual(results, ["ok", "ok"], "どちらも取り消せる");
    assert.equal(record.cancelling, 0, "取消のカウンタは最後の 1 件で解除する");
    assert.equal(sdkQueueLength(record), 0, "実キューに残さない");
    assert.deepEqual(
      pendingOf(store.payload(record)).map(([sendId, state]) => [sendId, state]),
      [
        [first.sendId, "running"],
        [a.sendId, "unsent"],
        [b.sendId, "unsent"],
      ],
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId],
      "取り消した 2 件は注入されない",
    );
  });
});

test("受付中の取消は後続の受付を打ち切り、渡していない入力を未送信に残す", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 60 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "取り消す本文");
    const b = store.postMessage(record, "後続の本文");
    // 受付チェーンが動いている間に新規送信が届く (受付順はこの時点の末尾へ積む)
    const c = store.postMessage(record, "受付中の本文");
    assert.deepEqual(
      handedOffOf(record).map((item) => item.sendId),
      [a.sendId, b.sendId, c.sendId],
      "チェーンへ載せた時点で全件を配送中として扱う",
    );

    assert.equal(await store.cancelQueued(record, a.sendId), "ok");
    assert.equal(record.cancelling, 0, "取消のカウンタは解除される");
    assert.equal(sdkQueueLength(record), 0, "打ち切った分を実キューに残さない");
    assert.deepEqual(
      (store.payload(record).pendingSends ?? [])
        .filter((item) => item.sendId !== first.sendId)
        .map((item) => [item.sendId, item.state, item.position]),
      [
        [a.sendId, "unsent", undefined],
        [b.sendId, "queued", 1],
        [c.sendId, "queued", 2],
      ],
      "取り消した 1 件だけを未送信にし、渡していない後続は BFF の待機へ戻す",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, b.sendId, c.sendId],
      "打ち切った入力を取り消し扱いにせず、改めて次の判断へ渡す",
    );
  });
});

test("受付に失敗した 1 件だけが未送信になり、後続は注入される", async () => {
  await withStore({ chunkDelayMs: 500, steerFailures: 1 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "受付に失敗する本文");
    const b = store.postMessage(record, "後続の本文");
    await waitFor(
      () => record.queue.some((item) => item.sendId === b.sendId && item.steered === true),
      2000,
      "second accepted",
    );
    await settleSteering(record);

    assert.deepEqual(
      (store.payload(record).pendingSends ?? [])
        .filter((item) => item.sendId !== first.sendId)
        .map((item) => [item.sendId, item.state]),
      [
        [a.sendId, "unsent"],
        [b.sendId, "queued"],
      ],
      "失敗した 1 件だけを配送から外す",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, b.sendId],
      "失敗した入力を自動で再投入しない",
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

test("停止はまとめて渡した待機を全件未送信に戻す", async () => {
  await withStore({ chunkDelayMs: 500, steerDelayMs: 5 }, async ({ store, record }) => {
    const first = store.postMessage(record, "最初の本文");
    const a = store.postMessage(record, "停止で戻る本文A");
    const b = store.postMessage(record, "停止で戻る本文B");
    await waitFor(() => handedOffOf(record).length === 2, 2000, "steering handoff");
    await settleSteering(record);

    await store.stop(record);
    await store.flush(record);
    assert.deepEqual(pendingOf(store.payload(record)), [
      [a.sendId, "unsent", undefined],
      [b.sendId, "unsent", undefined],
    ]);
    assert.equal(record.queue.length, 0, "停止後に BFF の待機を残さない");
    assert.equal(record.cancelling, 0);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId],
      "回収した入力を実行しない",
    );
  });
});

test("終端で未注入の steering を回収し、次の実行へ同じ送信IDで割り当てる", async () => {
  await withStore({ chunkDelayMs: 5, drainSteering: false }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "次の実行になる本文");
    const third = store.postMessage(record, "さらに次の実行になる本文");
    await waitFor(() => events.filter((entry) => entry.type === "run_start").length === 3, 5000, "third run");
    await waitFor(() => store.statusOf(record) === "completed", 5000, "third run completion");
    await store.flush(record);

    const starts = runStarts(events);
    assert.equal(starts.length, 3);
    assert.deepEqual(
      starts.map((item) => item.initialSendId),
      [first.sendId, second.sendId, third.sendId],
      "回収した送信は受付順に次の実行の開始送信になる",
    );
    const users = userItems(pageOf(store, record));
    assert.deepEqual(
      users.map((item) => [item.sendId, item.runId]),
      [
        [first.sendId, starts[0]?.runId],
        [second.sendId, starts[1]?.runId],
        [third.sendId, starts[2]?.runId],
      ],
      "未注入のまま終わった送信は旧実行へ割り当てない",
    );
    assert.deepEqual(pendingOf(store.payload(record)), [], "回収した送信は実行済みになる");
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
    await waitFor(() => handedOffOf(record).length === 1, 2000, "steering handoff");

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
    assert.equal(
      injectedResync.type === "resync" ? injectedResync.data.resyncReason : "unexpected",
      undefined,
      "注入の resync は同じ実行の継続 (未確定の応答を捨てない)",
    );
    const runStartIndex = events.findIndex((entry) => entry.type === "run_start");
    assert.ok(runStartIndex >= 0 && events.indexOf(injectedResync) > runStartIndex);
    assert.equal(first.sendId !== second.sendId, true);
  });
});

test("一括ドレインを持たない SDK では 1 件ずつ渡す現行挙動を保つ", async () => {
  await withStore({ chunkDelayMs: 500, steeringMode: "one-at-a-time" }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
    const first = store.postMessage(record, "最初の本文");
    const second = store.postMessage(record, "次の待機の本文");
    const third = store.postMessage(record, "その次の待機の本文");

    await waitFor(() => handedOffOf(record).length >= 1, 2000, "first handoff");
    await settleSteering(record);
    assert.equal(handedOffOf(record).length, 1, "同時に渡すのは 1 件だけ");
    assert.equal(sdkQueueLength(record), 1);
    assert.deepEqual(
      pendingOf(store.payload(record)).map(([sendId, state]) => [sendId, state]),
      [
        [first.sendId, "running"],
        [second.sendId, "queued"],
        [third.sendId, "queued"],
      ],
      "先頭が実キューにある間の次以降は queued のまま",
    );

    await waitFor(() => store.statusOf(record) === "completed", 5000, "run completion");
    await store.flush(record);
    assert.deepEqual(
      userItems(pageOf(store, record)).map((item) => item.sendId),
      [first.sendId, second.sendId, third.sendId],
      "1 件ずつでも受付順に欠落しない",
    );
  });
});

test("終端後に遅れて受付された steering を SDK キューに残さず、次の入力を追い越させない", async () => {
  await withStore({ reply: "ok", chunkDelayMs: 5, steerDelayMs: 150 }, async ({ store, record }) => {
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
    const first = store.postMessage(record, "開始");
    const second = store.postMessage(record, "古い追加入力");

    // 最初の実行は追加入力の受付完了より先に終わる
    await waitFor(() => events.filter((entry) => entry.type === "run_end").length === 1, 5000, "first run end");

    // 終端直後 (受付処理中) に来た新規送信は、回収待ちの古い入力を追い越さない
    const third = store.postMessage(record, "新しい入力");
    assert.equal(third.queued, true, "配送に残る入力がある間は待機へ積む");
    assert.equal(sdkQueueLength(record), 0, "終端後の SDK 実キューに残さない");

    await waitFor(
      () =>
        userItems(pageOf(store, record)).length === 3 &&
        events.filter((entry) => entry.type === "run_start").length === 3,
      10_000,
      "all sends injected",
    );
    await store.flush(record);

    assert.deepEqual(
      runStarts(events).map((entry) => entry.initialSendId),
      [first.sendId, second.sendId, third.sendId],
      "受付順に開始し、古い入力を新規送信が追い越さない",
    );
    const users = userItems(pageOf(store, record));
    assert.deepEqual(
      users.map((item) => [item.text, item.sendId]),
      [
        ["開始", first.sendId],
        ["古い追加入力", second.sendId],
        ["新しい入力", third.sendId],
      ],
      "FIFO の受付順で欠落なく注入する",
    );
    assert.equal(
      users.every((item) => item.runId !== undefined),
      true,
      "各送信に実行IDが対応する",
    );
  });
});

test("エラー終端でも遅れて受付された steering を SDK キューに残さない", async () => {
  await withStore(
    { reply: "ok", chunkDelayMs: 5, steerDelayMs: 150, assistantFailure: "stub failure" },
    async ({ store, record }) => {
      const events: EventEntry[] = [];
      store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
      const first = store.postMessage(record, "開始");
      const second = store.postMessage(record, "エラー中の追加入力");

      await waitFor(() => events.filter((entry) => entry.type === "run_end").length === 1, 5000, "first run end");
      const ended = events.find((entry) => entry.type === "run_end");
      assert.equal(ended?.type === "run_end" ? ended.data.status : undefined, "error");
      await waitFor(
        () => events.some((entry) => entry.type === "run_start" && entry.data.initialSendId === second.sendId),
        5000,
        "recovered send starts",
      );
      assert.equal(sdkQueueLength(record), 0, "エラー終端後の SDK 実キューに残さない");

      await store.flush(record);
      const users = userItems(pageOf(store, record));
      assert.deepEqual(
        users.map((item) => [item.text, item.sendId]),
        [
          ["開始", first.sendId],
          ["エラー中の追加入力", second.sendId],
        ],
        "回収した入力を次の実行へ同じ送信IDで割り当てる",
      );
      assert.equal(users[1]?.runId !== undefined, true, "履歴の送信IDと実行IDが対応する");
    },
  );
});
