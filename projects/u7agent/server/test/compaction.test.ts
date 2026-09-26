// compaction の payload / SSE イベントの検証。実 API は使わず stub で再現する
// (compaction_end は run 中しか観測できないため、postMessage 直後に stub の compact() を叩く)。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactionSettingsFromEnv, parseCompactionTokenKnob } from "../src/agent";
import { createAgentCatalog } from "../src/agents";
import { ProjectStore } from "../src/projects";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SessionStore } from "../src/sessions";
import type { SessionRecord } from "../src/sessions";
import type { EventEntry } from "../src/schema";
import { parseSessionFile, SessionFileWriter, sessionJsonlPath, sessionMetaPath } from "../src/session-store";
import { createStubPi, waitFor, type StubCompactionOptions, type StubPiOptions, type StubSession } from "./stub-pi";

const CHUNK_DELAY_MS = 20;

/** 1 往復ぶんのランを実行する。compact を渡すとターンの最中に圧縮を発火させる。 */
async function runTurn(
  store: SessionStore,
  record: SessionRecord,
  text: string,
  compact?: (session: StubSession) => Promise<void>,
): Promise<void> {
  store.postMessage(record, text);
  const session = record.session as StubSession;
  if (compact) await compact(session);
  await waitFor(() => store.statusOf(record) === "completed", 3000, `run: ${text}`);
}

/** 1 セッションだけ作った store (テストごとに独立させる) */
async function createFixture(options: { masker?: ReturnType<typeof createSecretMasker>; stub?: StubPiOptions } = {}) {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ chunkDelayMs: CHUNK_DELAY_MS, ...options.stub });
  const store = new SessionStore({ pi, catalog, ...(options.masker ? { masker: options.masker } : {}) });
  const record = await store.create();
  return { store, record, session: pi.sessions[0] as StubSession };
}

/** storeDir を使う store。永続化と、persist を止めた保存待ちの再現に使う */
async function createPersistentFixture(options: { stub?: StubPiOptions; projects?: ProjectStore } = {}) {
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-compaction-"));
  // create / restore が必要とするのは dir の作成と存在確認だけ
  const workspace = {
    createDir: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
  const catalog = createAgentCatalog();
  const pi = createStubPi({ ...options.stub });
  const store = new SessionStore({
    pi,
    catalog,
    storeDir,
    workspace,
    rootCwd: "/tmp/project",
    ...(options.projects ? { projects: options.projects } : {}),
  });
  await store.init();
  const record = await store.create();
  return { store, record, session: pi.sessions[0] as StubSession, storeDir, pi, catalog, workspace };
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function createGate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** persist を gate で止め、SDK 完了後 (保存待ち) の状態を固定する */
function holdPersist(record: SessionRecord): Gate {
  const gate = createGate();
  const writer = record.writer as SessionFileWriter;
  record.writer = {
    schedule: async (
      header: Parameters<SessionFileWriter["schedule"]>[0],
      entries: Parameters<SessionFileWriter["schedule"]>[1],
    ) => {
      await gate.promise;
      await writer.schedule(header, entries);
    },
    flush: () => writer.flush(),
    get error() {
      return writer.error;
    },
  } as unknown as SessionFileWriter;
  return gate;
}

function collect(store: SessionStore, record: SessionRecord): EventEntry[] {
  const events: EventEntry[] = [];
  store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
  return events;
}

type StoreError = { statusCode?: number; message?: string };

test("compaction の要約は messages から外れ、entry を写した形で compactions に載る", async () => {
  const { store, record, session } = await createFixture();

  await runTurn(store, record, "1つ目");
  await runTurn(store, record, "2つ目", (target) =>
    target.compact({
      reason: "threshold",
      summarizeCount: 1,
      summary: "古い会話の要約",
      tokensBefore: 68_000,
      estimatedTokensAfter: 12_345,
    }),
  );

  const payload = store.payload(record);
  // context の先頭に入る role compactionSummary のメッセージは従来どおり payload に載せない
  assert.deepEqual(
    payload.messages.map((message) => [message.role, message.text]),
    [
      ["assistant", "スタブの返答です"],
      ["user", "2つ目"],
      ["assistant", "スタブの返答です"],
    ],
  );
  assert.equal(payload.compactions.length, 1);
  const [compaction] = payload.compactions;
  assert.equal(compaction.summary, "古い会話の要約");
  assert.equal(compaction.tokensBefore, 68_000);
  assert.equal(compaction.reason, "threshold");
  assert.equal(compaction.estimatedTokensAfter, 12_345);
  // 保持された古い側 (assistant / user / assistant) の後ろ = 末尾に区切りを置く
  assert.equal(compaction.beforeMessageIndex, 3);
  const entry = session.entries.find((candidate) => candidate.type === "compaction");
  assert.equal(compaction.id, entry?.id, "SDK entry の id をそのまま使う (独自の連番は振らない)");
  assert.equal(compaction.firstKeptEntryId, entry?.firstKeptEntryId);
  assert.ok(compaction.firstKeptEntryId);
  assert.equal(Number.isNaN(Date.parse(compaction.timestamp)), false, "timestamp は ISO 8601 のまま");

  // 圧縮後に積まれたメッセージは区切りの後ろに入る
  await runTurn(store, record, "3つ目");
  const after = store.payload(record);
  assert.equal(after.messages.length, 5);
  assert.equal(after.compactions[0].beforeMessageIndex, 3);

  await store.close();
});

test("compaction_end は compaction を配ってから resync で同じ状態を配る", async () => {
  const { store, record } = await createFixture();
  const events: EventEntry[] = [];
  store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

  await runTurn(store, record, "圧縮される会話", (target) =>
    target.compact({
      reason: "overflow",
      summarizeCount: 1,
      summary: "溢れた会話の要約",
      tokensBefore: 90_000,
      estimatedTokensAfter: 9_000,
    }),
  );

  const types = events.map((entry) => entry.type);
  const compactionPosition = types.indexOf("compaction");
  assert.ok(compactionPosition >= 0, "compaction イベントが届く");
  assert.equal(types[compactionPosition + 1], "resync", "compaction の直後に resync が届く");

  const compactionEvent = events[compactionPosition];
  const resyncEvent = events[compactionPosition + 1];
  assert.equal(compactionEvent.type, "compaction");
  assert.equal(resyncEvent.type, "resync");
  if (compactionEvent.type === "compaction" && resyncEvent.type === "resync") {
    assert.equal(compactionEvent.data.count, 1);
    assert.equal(compactionEvent.data.compaction.summary, "溢れた会話の要約");
    assert.equal(compactionEvent.data.compaction.reason, "overflow");
    // 生成中の assistant はまだ本文が無く messages から落ちるため、この時点の区切りは先頭を指す
    // (messages と beforeMessageIndex は同じ payload 組み立てで計算され、常に整合する)
    assert.equal(compactionEvent.data.compaction.beforeMessageIndex, 0);
    assert.deepEqual(resyncEvent.data.compactions, [compactionEvent.data.compaction]);
  }

  // compaction_start の status は従来どおり
  const status = events.find((entry) => entry.type === "status" && entry.data.state === "compacting");
  assert.equal(status?.type === "status" ? status.data.text : undefined, "会話を整理中…");

  await store.close();
});

test("送信メッセージを積む前の compaction でも resync はそのメッセージを含んでから届く", async () => {
  // 実 SDK の prompt() は送信メッセージを組み立てる前に preflight の compaction を走らせる。
  // 1 往復目はそのまま、2 往復目の送信時に圧縮させる。
  const catalog = createAgentCatalog();
  const pi = createStubPi({
    chunkDelayMs: CHUNK_DELAY_MS,
    preflightCompactions: [
      null,
      { reason: "threshold", summarizeCount: 1, summary: "1回目の要約", tokensBefore: 40_000 },
    ],
  });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create();

  await runTurn(store, record, "1つ目");

  const events: EventEntry[] = [];
  store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
  await runTurn(store, record, "2つ目");

  const types = events.map((entry) => entry.type);
  const compactionPosition = types.indexOf("compaction");
  const resyncPosition = types.indexOf("resync");
  assert.ok(compactionPosition >= 0, "compaction イベントが届く");
  assert.ok(resyncPosition > compactionPosition, "resync は compaction の後に届く");

  const resyncEvent = events[resyncPosition];
  assert.equal(resyncEvent.type, "resync");
  if (resyncEvent.type === "resync") {
    // 送信メッセージが agent state へ入るまで resync を遅らせる (入る前だとそのメッセージが消える)
    assert.deepEqual(
      resyncEvent.data.messages.map((message) => message.text),
      ["スタブの返答です", "2つ目"],
    );
    assert.equal(resyncEvent.data.compactions[0].beforeMessageIndex, 1);
  }

  const payload = store.payload(record);
  assert.deepEqual(
    payload.messages.map((message) => message.text),
    ["スタブの返答です", "2つ目", "スタブの返答です"],
  );
  assert.equal(payload.compactions[0].beforeMessageIndex, 1, "区切りは送信メッセージの手前");

  await store.close();
});

test("overflow 回復で agent state から外れたメッセージがあっても区切り位置は messages と揃う", async () => {
  const catalog = createAgentCatalog();
  // 失敗した assistant に本文が入ってから圧縮するため、chunk 間隔を広げる
  const pi = createStubPi({ chunkDelayMs: 200 });
  const store = new SessionStore({ pi, catalog });
  const record = await store.create();
  const session = pi.sessions[0] as StubSession;

  await runTurn(store, record, "1つ目");

  store.postMessage(record, "2つ目");
  await waitFor(
    () => {
      const last = store.payload(record).messages.at(-1);
      return last?.role === "assistant" && last.text.length > 0;
    },
    3000,
    "assistant first chunk",
  );
  await session.compact({
    reason: "overflow",
    summarizeCount: 1,
    summary: "溢れた会話の要約",
    tokensBefore: 50_000,
  });
  // 実 SDK は willRetry の compaction_end を配った後に失敗した assistant を agent state から外す
  // (entry には残るので、位置を entry だけで数えると 1 件ずれる)
  session.dropLastAssistantFromState();
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");
  await runTurn(store, record, "3つ目");

  const payload = store.payload(record);
  assert.deepEqual(
    payload.messages.map((message) => message.text),
    ["スタブの返答です", "2つ目", "3つ目", "スタブの返答です"],
  );
  const index = payload.compactions[0].beforeMessageIndex;
  assert.equal(index, 2);
  assert.deepEqual(
    payload.messages.slice(index).map((message) => message.text),
    ["3つ目", "スタブの返答です"],
    "区切りの後ろは圧縮後に積んだメッセージだけ",
  );

  await store.close();
});

test("複数回の compaction は全件を保持し、位置を持つのは最新の 1 件だけになる", async () => {
  const { store, record } = await createFixture();

  await runTurn(store, record, "1つ目");
  await runTurn(store, record, "2つ目", (session) =>
    session.compact({ reason: "threshold", summarizeCount: 1, summary: "1回目の要約", tokensBefore: 40_000 }),
  );
  await runTurn(store, record, "3つ目");
  await runTurn(store, record, "4つ目", (session) =>
    session.compact({ reason: "overflow", summarizeCount: 2, summary: "2回目の要約", tokensBefore: 55_000 }),
  );
  await runTurn(store, record, "5つ目");

  const payload = store.payload(record);
  assert.equal(payload.compactions.length, 2);
  assert.deepEqual(
    payload.compactions.map((compaction) => compaction.summary),
    ["1回目の要約", "2回目の要約"],
  );
  assert.deepEqual(
    payload.compactions.map((compaction) => compaction.reason),
    ["threshold", "overflow"],
  );
  // 過去の圧縮位置は context の組み替えで復元できないため、最新の 1 件だけが持つ
  assert.equal(payload.compactions[0].beforeMessageIndex, undefined);
  assert.equal(payload.compactions[1].beforeMessageIndex, payload.messages.length - 2);
  assert.ok(!payload.messages.some((message) => message.text.includes("回目の要約")), "要約は messages に混ざらない");

  await store.close();
});

test("firstKeptEntryId が metadata entry を指しても区切りは表示メッセージ数で数える", async () => {
  const { store, record, session } = await createFixture();

  await runTurn(store, record, "1つ目");
  await runTurn(store, record, "2つ目", (target) =>
    target.compact({ summarizeCount: 2, firstKeptIsMetadata: true, summary: "要約" }),
  );

  const payload = store.payload(record);
  assert.deepEqual(
    payload.messages.map((message) => [message.role, message.text]),
    [
      ["user", "2つ目"],
      ["assistant", "スタブの返答です"],
    ],
  );
  assert.equal(payload.compactions[0].beforeMessageIndex, 2);
  const kept = session.entries.find((entry) => entry.id === payload.compactions[0].firstKeptEntryId);
  assert.equal(kept?.type, "model_change", "firstKeptEntryId は metadata entry を指し得る");

  await store.close();
});

for (const outcome of ["none", "aborted", "error"] as const) {
  test(`compaction_end が ${outcome} のときは compaction も resync も配らない`, async () => {
    const { store, record, session } = await createFixture();
    const events: EventEntry[] = [];
    store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));

    await runTurn(store, record, "圧縮されない会話", (target) => target.compact({ outcome, summarizeCount: 1 }));

    assert.equal(events.filter((entry) => entry.type === "compaction").length, 0);
    assert.equal(events.filter((entry) => entry.type === "resync").length, 0);
    const payload = store.payload(record);
    assert.deepEqual(payload.compactions, []);
    assert.deepEqual(
      payload.messages.map((message) => message.text),
      ["圧縮されない会話", "スタブの返答です"],
    );
    assert.equal(session.messages.length, 2, "SDK の context も組み替えない");

    await store.close();
  });
}

test("要約は他の出力と同じくマスカーを通してから配る", async () => {
  const secret = "sk-compaction-dummy-0123456789";
  const { store, record, session } = await createFixture({ masker: createSecretMasker([secret]) });

  await runTurn(store, record, "秘密を含む会話", (target) =>
    target.compact({ summarizeCount: 1, summary: `要約: ${secret} を含む` }),
  );

  const payload = store.payload(record);
  assert.equal(payload.compactions[0].summary, `要約: ${REDACTED} を含む`);
  // SDK 側の entry は書き換えない (マスクは配布時だけ)
  const entry = session.entries.find((candidate) => candidate.type === "compaction");
  assert.equal(entry?.summary, `要約: ${secret} を含む`);

  await store.close();
});

test("検証用の閾値ノブは未設定・不正値を SDK 既定へ戻す", () => {
  assert.equal(parseCompactionTokenKnob(undefined), undefined);
  assert.equal(parseCompactionTokenKnob(""), undefined);
  assert.equal(parseCompactionTokenKnob("0"), undefined);
  assert.equal(parseCompactionTokenKnob("-1"), undefined);
  assert.equal(parseCompactionTokenKnob("1.5"), undefined);
  assert.equal(parseCompactionTokenKnob("abc"), undefined);
  assert.equal(parseCompactionTokenKnob(" 30000 "), 30_000);

  assert.deepEqual(compactionSettingsFromEnv({} as NodeJS.ProcessEnv), {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  });
  assert.deepEqual(
    compactionSettingsFromEnv({
      PI_COMPACTION_RESERVE_TOKENS: "30000",
      PI_COMPACTION_KEEP_RECENT_TOKENS: "4000",
    } as NodeJS.ProcessEnv),
    { enabled: true, reserveTokens: 30_000, keepRecentTokens: 4_000 },
  );
});

// ---------------------------------------------------------------------------
// 手動圧縮 (POST /api/sessions/:id/compact の経路)
// ---------------------------------------------------------------------------

/** BFF からの手動圧縮に使う stub の挙動 */
const withManual = (options: StubCompactionOptions): { stub: StubPiOptions } => ({
  stub: { manualCompaction: options },
});

test("手動圧縮は開始 resync → compaction → 終端 resync → status の順に配る", async () => {
  const { store, record } = await createFixture();
  await runTurn(store, record, "圧縮される会話");
  const events = collect(store, record);

  const result = await store.compact(record);

  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "compaction", "resync", "status"],
  );
  const [start, compaction, end, status] = events;
  assert.equal(start.type === "resync" ? start.data.status : undefined, "compacting");
  assert.equal(
    typeof (start.type === "resync" ? start.data.compactionStartedAt : undefined),
    "number",
    "開始 resync で経過時間の起点を配る",
  );
  assert.equal(compaction.type === "compaction" ? compaction.data.compaction.reason : undefined, "manual");
  assert.equal(end.type === "resync" ? end.data.status : undefined, "completed");
  assert.equal(end.type === "resync" ? end.data.compactionStartedAt : undefined, undefined, "終端では起点を落とす");
  assert.equal(end.type === "resync" ? end.data.compactions.length : 0, 1);
  assert.equal(status.type === "status" ? status.data.text : "", "会話を圧縮しました（1回目）");

  // 同期応答も終端と同じ状態を返し、排他は保存完了まで保持される
  assert.deepEqual(result, { sessionId: record.id, status: "completed" });
  assert.equal(record.compacting, false);
  assert.equal(record.compactionStartedAt, undefined);
  assert.equal(record.compactionTask, undefined);
  // 別タブ / reload の正は payload (compactionStartedAt を残さない)
  const payload = store.payload(record);
  assert.equal(payload.status, "completed");
  assert.equal(payload.compactionStartedAt, undefined);
  assert.equal(payload.compactions.length, 1);
  assert.equal(typeof payload.compactions[0].beforeMessageIndex, "number");

  await store.close();
});

for (const [failure, status, text] of [
  ["too-small", 400, "まだ要約できる古い会話がありません"],
  ["already", 409, "会話はすでに圧縮されています"],
] as const) {
  test(`手動圧縮の ${failure} は ${status} を返し、compaction を配らず終端 resync と status を配る`, async () => {
    const { store, record } = await createFixture(withManual({ failure }));
    await runTurn(store, record, "小さい会話");
    const events = collect(store, record);

    await assert.rejects(
      () => store.compact(record),
      (error: StoreError) => error.statusCode === status && error.message === text,
    );

    assert.deepEqual(
      events.map((entry) => entry.type),
      ["resync", "resync", "status"],
      "履歴が変わらないので compaction は配らない",
    );
    const end = events[1];
    assert.equal(end.type === "resync" ? end.data.status : undefined, "completed");
    assert.equal(end.type === "resync" ? end.data.compactionStartedAt : undefined, undefined);
    assert.equal(events[2].type === "status" ? events[2].data.text : "", text);
    assert.deepEqual(store.payload(record).compactions, []);
    assert.equal(record.compacting, false);

    await store.close();
  });
}

test("未知の失敗は詳細を配らず 500 に倒す", async () => {
  const { store, record } = await createFixture(withManual({ failure: "unknown" }));
  const events = collect(store, record);

  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) => error.statusCode === 500 && error.message === "会話の圧縮に失敗しました",
  );

  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "resync", "status"],
  );
  assert.equal(events[2].type === "status" ? events[2].data.text : "", "会話の圧縮に失敗しました");

  await store.close();
});

test("未対応のランタイムは 501 になり、排他も立てない", async () => {
  const { store, record, session } = await createFixture();
  delete (session as unknown as { compact?: unknown }).compact;

  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) => error.statusCode === 501,
  );
  assert.equal(record.compacting, false);
  assert.equal(record.compactionTask, undefined);

  await store.close();
});

test("圧縮中の stop は中止として返り、応答の status に compacting を残さない", async () => {
  const { store, record, session } = await createFixture(withManual({ delayMs: 100 }));
  const events = collect(store, record);

  const compacting = store.compact(record).then(
    () => undefined,
    (error: StoreError) => error,
  );
  await waitFor(() => record.compacting, 1000, "compaction started");
  const stopped = await store.stop(record);
  const failure = await compacting;

  assert.notEqual(stopped.status, "compacting");
  assert.equal(failure?.statusCode, 409);
  assert.equal(failure?.message, "圧縮を中止しました");
  assert.ok(session.compactionAborts >= 1, "SDK の compaction を abort する");
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "resync", "status"],
  );
  assert.equal(events[2].type === "status" ? events[2].data.text : "", "圧縮を中止しました");
  assert.deepEqual(store.payload(record).compactions, []);

  await store.close();
});

test("圧縮中の二重 POST と設定変更は 409 になり、実行中の圧縮も 409 になる", async () => {
  const { store, record } = await createFixture(withManual({ delayMs: 50 }));

  const compacting = store.compact(record);
  await waitFor(() => record.compacting, 1000, "compaction started");
  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) => error.statusCode === 409,
  );
  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "high" }),
    (error: StoreError) => error.statusCode === 409,
  );
  await compacting;
  assert.equal(store.statusOf(record), "idle", "圧縮だけでは run の状態は変わらない");

  // run 中は idle ではないので圧縮できない
  store.postMessage(record, "実行中");
  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) => error.statusCode === 409,
  );
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");
  await store.close();
});

test("圧縮中の送信は runId なしで queued になり、終端処理の後に 1 回だけ pump する", async () => {
  const { store, record } = await createFixture(withManual({ delayMs: 50 }));
  const events = collect(store, record);

  const compacting = store.compact(record);
  await waitFor(() => record.compacting, 1000, "compaction started");
  const queued = store.postMessage(record, "圧縮中の送信");

  assert.deepEqual(queued, { queued: true, queueDepth: 1, runId: undefined });
  assert.equal(store.statusOf(record), "compacting");
  await compacting;

  assert.deepEqual(
    events.map((entry) => entry.type).slice(0, 6),
    ["resync", "queued", "compaction", "resync", "status", "run_start"],
    "終端 resync / status の後に pump する",
  );
  await waitFor(() => store.statusOf(record) === "completed", 3000, "queued run completion");
  assert.equal(events.filter((entry) => entry.type === "run_start").length, 1, "pump は 1 回だけ");

  await store.close();
});

test("保存待ちの間は送信・設定変更・二重圧縮・stop が割り込まない", async () => {
  const { store, record, session } = await createPersistentFixture();
  await runTurn(store, record, "保存待ちの会話");
  const events = collect(store, record);
  const gate = holdPersist(record);

  const compacting = store.compact(record);
  await waitFor(() => events.some((entry) => entry.type === "compaction"), 2000, "sdk compaction done");
  assert.equal(record.compacting, true, "BFF の排他は保存待ちも覆う");
  assert.equal(session.isIdle, true, "SDK から見ると保存待ちの間は idle");

  const queued = store.postMessage(record, "保存待ちの送信");
  assert.deepEqual(queued, { queued: true, queueDepth: 1, runId: undefined });
  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) => error.statusCode === 409,
  );
  await assert.rejects(
    () => store.updateSettings(record, { thinkingLevel: "high" }),
    (error: StoreError) => error.statusCode === 409,
  );
  // stop は保存の settle を待つ (entry を append 済みなので巻き戻さない)
  const stopping = store.stop(record);
  gate.open();
  const stopped = await stopping;
  await compacting;

  assert.notEqual(stopped.status, "compacting");
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "compaction", "queued", "queue_cleared", "resync", "status"],
    "stop がキューを捨てるので pump は走らない",
  );
  const last = events.at(-1);
  assert.equal(last?.type === "status" ? last.data.text : "", "会話を圧縮しました（1回目）");

  await store.close();
});

test("保存に失敗しても compaction と終端 resync を配り、同期 POST だけを 500 にする", async () => {
  const { store, record, storeDir } = await createPersistentFixture();
  await runTurn(store, record, "保存に失敗する会話");
  // meta.json をディレクトリへ置き換えて rename を失敗させる
  const metaPath = sessionMetaPath(record.id, storeDir);
  await rm(metaPath, { force: true });
  await mkdir(metaPath, { recursive: true });
  const events = collect(store, record);

  await assert.rejects(
    () => store.compact(record),
    (error: StoreError) =>
      error.statusCode === 500 && (error.message ?? "").startsWith("セッションの保存に失敗しました: "),
  );

  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "compaction", "resync", "status"],
    "保存に失敗しても履歴は巻き戻さない",
  );
  const status = events[3];
  assert.match(
    status.type === "status" ? status.data.text : "",
    /^会話を圧縮しましたが、保存に失敗しました: /,
    "別タブ (同期 POST を呼ばない購読者) にも保存失敗を配る",
  );
  assert.equal(store.payload(record).compactions.length, 1);
  assert.equal(store.status().dirty, 1);

  await store.close();
});

test("手動圧縮は次の run を起こさず close しても復元できる", async () => {
  const { store, record, storeDir, pi, catalog } = await createPersistentFixture();
  await runTurn(store, record, "残す会話");
  await store.compact(record);
  await store.close();

  const restarted = new SessionStore({
    pi,
    catalog,
    storeDir,
    workspace: { createDir: async (path: string) => ({ path }) } as unknown as SandboxWorkspaceClient,
    rootCwd: "/tmp/project",
  });
  await restarted.init();
  const restored = await restarted.resolve(record.id);
  assert.ok(restored);
  const payload = restarted.payload(restored);
  assert.equal(payload.compactions.length, 1);
  assert.equal(payload.compactions[0].tokensBefore, 68_000);
  assert.equal(typeof payload.compactions[0].beforeMessageIndex, "number");
  // reason は compaction_end にしか無く、再起動で失う (既知の制約)
  assert.equal(payload.compactions[0].reason, undefined);
  await restarted.close();
});

test("削除中の圧縮は保存も終端配信も行わず、pump もしない", async () => {
  const { store, record } = await createFixture(withManual({ delayMs: 100 }));
  const events = collect(store, record);

  const compacting = store.compact(record).then(
    () => undefined,
    (error: StoreError) => error,
  );
  await waitFor(() => record.compacting, 1000, "compaction started");
  store.postMessage(record, "削除される待機メッセージ");
  const deleted = store.deleteSession(record.id);
  const failure = await compacting;

  assert.equal(failure?.statusCode, 409);
  assert.equal(await deleted, true);
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "queued", "session_deleted"],
    "終端 resync / status も run_start も配らない",
  );
  assert.equal(store.get(record.id), undefined);

  await store.close();
});

test("close は保存待ちの圧縮を待って保存し、終端配信と pump だけを止める", async () => {
  const { store, record, storeDir } = await createPersistentFixture();
  await runTurn(store, record, "閉じる会話");
  const events = collect(store, record);
  const gate = holdPersist(record);

  const compacting = store.compact(record);
  await waitFor(() => events.some((entry) => entry.type === "compaction"), 2000, "sdk compaction done");
  store.postMessage(record, "配信されない待機メッセージ");
  const closing = store.close();
  gate.open();
  await closing;
  await compacting.catch(() => {});

  assert.deepEqual(
    events.map((entry) => entry.type),
    ["resync", "compaction", "queued"],
    "closing 中は終端 resync / status と pump を配らない",
  );
  // 保存は行われている (SDK は in-memory なので、保存を飛ばすと entry が失われる)
  const parsed = parseSessionFile(await readFile(sessionJsonlPath(record.id, storeDir), "utf8"), record.id);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind === "ok") {
    assert.equal(parsed.entries.filter((entry) => entry.type === "compaction").length, 1);
  }
});

test("圧縮中は sweep の対象外になる", async () => {
  const { store, record } = await createFixture(withManual({ delayMs: 50 }));

  const compacting = store.compact(record);
  await waitFor(() => record.compacting, 1000, "compaction started");
  record.lastUsedAt = Date.now() - 24 * 60 * 60 * 1000;
  await store.sweep();

  assert.equal(store.get(record.id), record, "圧縮中は外さない");
  await compacting;
  await store.close();
});

test("プロジェクト解除は圧縮の settle 後に所属変更の resync を配る", async () => {
  const projects = new ProjectStore();
  const { store, record } = await createPersistentFixture({ projects, stub: { manualCompaction: { delayMs: 100 } } });
  const project = projects.create({ cwd: "proj-a" });
  assert.ok(project);
  record.projectCwd = project.cwd;
  record.projectId = project.id;
  const events = collect(store, record);

  const compacting = store.compact(record).catch(() => undefined);
  await waitFor(() => record.compacting, 1000, "compaction started");
  projects.remove(project.id);
  await store.releaseProject(project.cwd);
  await compacting;

  const types = events.map((entry) => entry.type);
  assert.deepEqual(types, ["resync", "resync", "status", "resync"], "解除の resync は圧縮の settle の後");
  const last = events.at(-1);
  assert.equal(last?.type === "resync" ? last.data.projectId : project.id, undefined, "所属が外れた payload");
  assert.equal(record.queue.length, 0);

  await store.close();
});
