// compaction の payload / SSE イベントの検証。実 API は使わず stub で再現する
// (compaction_end は run 中しか観測できないため、postMessage 直後に stub の compact() を叩く)。
import assert from "node:assert/strict";
import test from "node:test";
import { compactionSettingsFromEnv, parseCompactionTokenKnob } from "../src/agent";
import { createAgentCatalog } from "../src/agents";
import { createSecretMasker, REDACTED } from "../src/redact";
import { SessionStore } from "../src/sessions";
import type { SessionRecord } from "../src/sessions";
import type { EventEntry } from "../src/schema";
import { createStubPi, waitFor, type StubSession } from "./stub-pi";

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
async function createFixture(options: { masker?: ReturnType<typeof createSecretMasker> } = {}) {
  const catalog = createAgentCatalog();
  const pi = createStubPi({ chunkDelayMs: CHUNK_DELAY_MS });
  const store = new SessionStore({ pi, catalog, ...options });
  const record = await store.create({ agentId: "agent-general" });
  return { store, record, session: pi.sessions[0] as StubSession };
}

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
  const record = await store.create({ agentId: "agent-general" });

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
  const record = await store.create({ agentId: "agent-general" });
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
