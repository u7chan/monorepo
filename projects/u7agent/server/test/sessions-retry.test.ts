// BFF 側の再試行状態の回帰テスト。
//
// SDK 実体のイベント順 (sdk-retry.test.ts) を前提に、run.retry / totalRetryCount / resync /
// run_end の契約をスタブで固定する。実キーは使わない。
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { SessionStore } from "../src/sessions";
import type { EventEntry, SessionPayload } from "../src/schema";
import { createStubPi, waitFor, type StubSession } from "./stub-pi";

/** SDK が配るテキスト付きの失敗 assistant を 1 件積む (usage total=0 も実機どおり) */
function appendFailedAssistant(session: StubSession, text: string, errorMessage: string) {
  session.emit({ type: "message_start", message: { role: "assistant" } });
  if (text) {
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  }
  const message = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "error",
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  };
  const entry = session.appendMessage(message);
  session.emit({ type: "message_end", message: entry.message ?? message });
}

/** SDK の context_edit による除外を模す (表示の正である投影から消し、entry_appended を配る) */
function omitLastAssistant(session: StubSession) {
  session.dropLastAssistantFromState();
  session.emit({ type: "entry_appended", entry: { type: "context_edit" } });
}

async function createRecord(pi = createStubPi()) {
  const store = new SessionStore({ pi, catalog: createAgentCatalog() });
  const record = await store.create();
  const session = pi.sessions[0];
  const events: EventEntry[] = [];
  store.subscribe(record, undefined, (entry) => events.push(entry));
  return { store, record, session, events };
}

const textEvents = (events: EventEntry[]): string[] => {
  const out: string[] = [];
  let current = "";
  for (const entry of events) {
    if (entry.type === "text") current += entry.data.delta;
    if (entry.type === "run_end") {
      out.push(current);
      current = "";
    }
  }
  return out;
};

const runRetryEvents = (events: EventEntry[]) =>
  events.filter((entry) => entry.type === "run_retry").map((e) => e.data);
const resyncs = (events: EventEntry[]): SessionPayload[] =>
  events.filter((entry) => entry.type === "resync").map((entry) => entry.data);

test("429→成功: waiting→retrying を配り、失敗試行の本文は表示から消える", async () => {
  const { store, record, session, events } = await createRecord();
  let release!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });

  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "失敗する途中のテキスト", "429 Rate limit reached for org-SECRET on TPM");
    session.emit({ type: "agent_end", willRetry: true });
    session.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 2000,
      errorMessage: "429 Rate limit reached for org-SECRET on TPM",
    });
    omitLastAssistant(session);
    await waitForRelease;
    // 次の試行の本文が始まったら retrying (auto_retry_end は再実行開始の観測点にしない)
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_start", message: { role: "assistant" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "復帰しました" } });
    const ok = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "復帰しました" }],
      stopReason: "stop",
    });
    session.emit({ type: "message_end", message: ok.message ?? ok });
    session.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    session.emit({ type: "agent_settled" });
  };

  store.postMessage(record, "レート制限を跨いで");
  await waitFor(() => runRetryEvents(events).length === 1, 3000, "waiting event");

  const waiting = runRetryEvents(events)[0];
  assert.equal(waiting.retry?.phase, "waiting");
  assert.equal(waiting.retry?.attempt, 1);
  assert.equal(waiting.retry?.maxAttempts, 2);
  assert.equal(waiting.retry?.reason, "rate_limit", "reason は分類コードだけ");
  assert.ok((waiting.retry?.retryAt ?? 0) > waiting.serverNow, "retryAt は serverNow より後");
  assert.equal(waiting.totalRetryCount, 1);
  const payloadWaiting = store.payload(record);
  assert.deepEqual(payloadWaiting.run?.retry, waiting.retry, "payload と SSE が同じ構造化情報を持つ");
  assert.equal(payloadWaiting.serverNow > 0, true, "payload にサーバー基準時刻が載る");
  // 待機中に別タブ / 再接続で参加した購読者は、世代が一致しない resync で同じ retry を受け取る
  const lateResync: EventEntry[] = [];
  store.subscribe(record, "stale-gen:0", (entry) => lateResync.push(entry));
  assert.equal(lateResync[0]?.type, "resync");
  assert.deepEqual(lateResync[0]?.data.run?.retry, waiting.retry);
  // 実機と同じく auto_retry_start 時点では投影が古く、context_edit 後の microtask で resync が届く
  await waitFor(() => resyncs(events).length > 0, 3000, "context edit resync");
  assert.equal(
    resyncs(events).some((payload) => payload.messages.some((message) => message.text.includes("失敗する途中"))),
    false,
    "どの resync も除外後の messages を配る (同期 resync をしない)",
  );
  assert.equal(
    events.some((entry) => entry.type === "text" && entry.data.delta.includes("失敗する途中")),
    true,
    "配信済みの途中テキストは遡って消さない (取り消しは resync)",
  );

  release();
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const retryEvents = runRetryEvents(events);
  assert.equal(retryEvents.length, 3, "waiting → retrying → 解除");
  assert.equal(retryEvents[1].retry?.phase, "retrying");
  assert.equal(retryEvents[2].retry, null);
  assert.equal(record.run?.retry, undefined);
  assert.equal(record.run?.totalRetryCount, 1);
  assert.deepEqual(textEvents(events), ["失敗する途中のテキスト復帰しました"]);
  // run_start / run_end は各 1 回
  assert.equal(events.filter((entry) => entry.type === "run_start").length, 1);
  const runEnd = events.filter((entry) => entry.type === "run_end");
  assert.equal(runEnd.length, 1);
  assert.equal(runEnd[0].data.status, "completed");
  assert.equal(runEnd[0].data.totalRetryCount, 1);
  assert.equal(runEnd[0].data.errorCode, undefined, "成功したランには分類コードを載せない");
  assert.equal(store.payload(record).run?.errorCode, undefined);
  assert.equal(JSON.stringify(events).includes("org-SECRET"), false, "公開経路に生エラーを載せない");
  // 成功した本文は通知にだけ使い、失敗試行の本文は残さない
  assert.equal(store.payload(record).messages.at(-1)?.text, "復帰しました");

  await store.close();
});

test("最大回数超過: 分類済みの理由 + 累計 + 案内を run_end / payload へ配る", async () => {
  const { store, record, session, events } = await createRecord();
  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "途中", "429 Rate limit reached for org-SECRET on TPM");
    session.emit({ type: "agent_end", willRetry: true });
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429 TPM" });
    omitLastAssistant(session);
    session.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 4000, errorMessage: "429 TPM" });
    session.emit({ type: "agent_end", willRetry: false });
    // 最終失敗の assistant は SDK が除外しない (投影に残る) ので、そのまま message_end を配る
    const failed = session.appendMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 Rate limit reached for org-SECRET on TPM: Limit 200000",
    });
    session.emit({ type: "message_end", message: failed.message ?? failed });
    session.emit({ type: "auto_retry_end", success: false, attempt: 2, finalError: "429 TPM" });
    session.emit({ type: "agent_settled" });
  };

  store.postMessage(record, "最終失敗まで");
  await waitFor(() => store.statusOf(record) === "error", 3000, "run error");

  const runEnd = events.filter((entry) => entry.type === "run_end");
  assert.equal(runEnd.length, 1);
  assert.equal(
    runEnd[0].data.error,
    "レート制限により実行に失敗しました（自動再試行2回）。時間をおいて再実行してください",
  );
  assert.equal(runEnd[0].data.totalRetryCount, 2);
  assert.equal(runEnd[0].data.errorCode, "rate_limit", "run_end (SSE) に最終失敗の分類コードを載せる");
  assert.equal(record.run?.retry, undefined, "終了でアクティブな retry を消す");
  assert.equal(record.run?.totalRetryCount, 2, "累計は結果表示用に残す");
  assert.equal(record.run?.errorCode, "rate_limit", "RunState にも立てる");
  const payload = store.payload(record);
  assert.equal(payload.run?.error, runEnd[0].data.error, "payload.run.error も同じ分類済み文言");
  assert.equal(payload.run?.errorCode, "rate_limit", "payload (リロード / resync) からも再実行カードを復元できる");
  assert.equal(JSON.stringify(payload).includes("org-SECRET"), false, "組織IDは公開経路へ出さない");
  assert.equal(JSON.stringify(runRetryEvents(events)).includes("org-SECRET"), false);
  assert.equal(runRetryEvents(events).at(-1)?.retry, null);
  assert.equal(resyncs(events).length >= 1, true, "除外のたびに resync を配る");

  await store.close();
});

test("待機中の stop は stopped で確定し、前のランの本文を finalize で再表示しない", async () => {
  const pi = createStubPi({ reply: "最初の返答です" });
  const { store, record, session, events } = await createRecord(pi);

  // 1 run 目: 通常完了
  store.postMessage(record, "1つ目");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "first run");
  const firstRunMessage = session.messages.at(-1);

  let release!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "2ラン目の失敗", "429 rate limit");
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 5000, errorMessage: "429" });
    omitLastAssistant(session);
    await waitForRelease;
    // SDK は待機中の abort で auto_retry_end(success:false) → agent_settled を配る
    session.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    session.emit({ type: "agent_settled" });
  };

  store.postMessage(record, "2つ目");
  await waitFor(() => runRetryEvents(events).some((data) => data.retry?.phase === "waiting"), 3000, "waiting");
  await store.stop(record);
  release();
  await waitFor(() => store.statusOf(record) === "stopped", 3000, "stopped");

  const secondRunEnd = events.filter((entry) => entry.type === "run_end").at(-1);
  assert.ok(secondRunEnd);
  assert.equal(secondRunEnd.data.status, "stopped");
  assert.equal((secondRunEnd.data as { error?: string }).error, undefined);
  assert.equal(record.run?.retry, undefined);
  assert.equal(record.run?.totalRetryCount, 1, "中止した再試行もスケジュール累計に含める");
  // 2 ラン目の run_start 以降に 1 ラン目の本文が再送されない (観測集合に無い assistant は補完しない)
  const secondRunStart = events.findIndex((entry) => entry.type === "run_start" && entry.data.prompt === "2つ目");
  const afterSecondStart = events.slice(secondRunStart);
  assert.equal(
    afterSecondStart.some((entry) => entry.type === "text" && entry.data.delta.includes("最初の返答です")),
    false,
  );
  assert.equal(record.session.messages.includes(firstRunMessage as never), true, "1 ラン目の履歴は残る");
  await store.close();
});

test("同一ラン内の別系列: attempt は 1 に戻っても totalRetryCount は累計する", async () => {
  const { store, record, session, events } = await createRecord();
  record.session.prompt = async () => {
    // 1 系列目: 失敗 → 再試行で成功 (SDK は成功で attempt をリセットする)
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "1回目の失敗", "429 TPM");
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429 TPM" });
    omitLastAssistant(session);
    session.emit({ type: "message_start", message: { role: "assistant" } });
    const ok = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "1回目の復帰" }],
      stopReason: "stop",
    });
    session.emit({ type: "message_end", message: ok.message ?? ok });
    session.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    // 2 系列目: ツールループ相当の後続 LLM 呼び出しで再び 429 → 再試行して完了
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "2回目の失敗", "429 TPM");
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429 TPM" });
    omitLastAssistant(session);
    session.emit({ type: "message_start", message: { role: "assistant" } });
    const ok2 = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "2回目の復帰" }],
      stopReason: "stop",
    });
    session.emit({ type: "message_end", message: ok2.message ?? ok2 });
    session.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    session.emit({ type: "agent_settled" });
  };
  store.postMessage(record, "2つの系列");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "completion");

  const retries = runRetryEvents(events);
  assert.deepEqual(
    retries.map((data) => data.retry?.attempt ?? null),
    [1, 1, null, 1, 1, null],
    "attempt は系列ごとに 1 から始まる",
  );
  assert.equal(record.run?.totalRetryCount, 2, "累計は系列を跨いで数える");
  assert.equal(events.filter((entry) => entry.type === "run_start").length, 1);
  assert.equal(events.filter((entry) => entry.type === "run_end").length, 1);
  await store.close();
});

test("新しいランは retry と累計を初期化し、run_start / run_end を各 1 回だけ配る", async () => {
  const { store, record, session, events } = await createRecord();
  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "失敗", "429 rate limit");
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429" });
    omitLastAssistant(session);
    session.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "429" });
    // 最終失敗の assistant は SDK が除外せず投影に残る
    const finalFailure = session.appendMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 rate limit",
    });
    session.emit({ type: "message_end", message: finalFailure.message ?? finalFailure });
    session.emit({ type: "agent_settled" });
  };
  store.postMessage(record, "失敗ラン");
  await waitFor(() => store.statusOf(record) === "error", 3000, "error run");
  assert.equal(record.run?.totalRetryCount, 1);

  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_start", message: { role: "assistant" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "次のラン" } });
    const ok = session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "次のラン" }],
      stopReason: "stop",
    });
    session.emit({ type: "message_end", message: ok.message ?? ok });
    session.emit({ type: "agent_settled" });
  };
  store.postMessage(record, "成功ラン");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "second run");

  assert.equal(record.run?.totalRetryCount, 0, "新しいランでは 0 へ戻す");
  assert.equal(events.filter((entry) => entry.type === "run_start").length, 2);
  assert.equal(events.filter((entry) => entry.type === "run_end").length, 2);
  assert.equal(runRetryEvents(events).at(-1)?.totalRetryCount, 1);
  await store.close();
});

test("待機イベントのリプレイには現在の serverNow を持つ resync を続けて配る", async () => {
  const { store, record, session } = await createRecord();
  let release!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    appendFailedAssistant(session, "", "429 TPM");
    session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429 TPM" });
    omitLastAssistant(session);
    await waitForRelease;
    session.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
    session.emit({ type: "agent_settled" });
  };
  store.postMessage(record, "リプレイ");
  await waitFor(() => record.run?.retry?.phase === "waiting", 3000, "waiting");

  // 切断前のカーソルで再購読する (run_retry がイベントログからリプレイされる)
  const replayed: EventEntry[] = [];
  store.subscribe(record, `${record.generation}:0`, (entry) => replayed.push(entry));
  const retryEntry = replayed.find((entry): entry is Extract<EventEntry, { type: "run_retry" }> => {
    return entry.type === "run_retry";
  });
  assert.ok(retryEntry, "run_retry がリプレイされる");
  assert.notEqual(retryEntry.data.retry, null);
  const tail = replayed.at(-1);
  assert.ok(tail, "リプレイ結果がある");
  assert.equal(tail.type, "resync", "リプレイの末尾に現在のスナップショットを続ける");
  if (tail.type !== "resync") assert.fail("resync expected");
  assert.deepEqual(tail.data.run?.retry, record.run?.retry, "現在の retry 状態を持つ");
  assert.ok(tail.data.serverNow >= retryEntry.data.serverNow, "リプレイされた serverNow より新しい基準時刻を配る");

  release();
  await waitFor(() => store.statusOf(record) === "completed", 3000, "completion");
  await store.close();
});

test("分類できない例外もコードを載せ、原文は公開経路へ出さない", async () => {
  const { store, record, events } = await createRecord();
  record.session.prompt = async () => {
    throw new Error("stub exploded for org-SECRET");
  };
  store.postMessage(record, "未知の失敗");
  await waitFor(() => store.statusOf(record) === "error", 3000, "run error");

  const runEnd = events.filter((entry) => entry.type === "run_end");
  assert.equal(runEnd.length, 1);
  assert.equal(runEnd[0].data.status, "error");
  assert.equal(runEnd[0].data.errorCode, "unknown", "分類できない失敗も unknown としてコードを載せる");
  assert.equal(
    runEnd[0].data.error,
    "実行に失敗しました。原因を特定できませんでした。接続と設定を確認して、もう一度実行してください",
  );
  assert.equal(store.payload(record).run?.errorCode, "unknown");
  assert.equal(JSON.stringify(events).includes("org-SECRET"), false, "上流の原文は公開経路へ出さない");

  await store.close();
});

test("停止要求と例外が同時のときは stopped のまま errorCode を載せない", async () => {
  const { store, record, session, events } = await createRecord();
  let release!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 停止要求の後に prompt() が拒否される状況 (listener 例外 / reject と stop が重なる)
  record.session.prompt = async () => {
    session.emit({ type: "agent_start" });
    await waitForRelease;
    throw new Error("429 Rate limit reached for org-SECRET on TPM");
  };

  store.postMessage(record, "停止と例外");
  await waitFor(() => record.run?.status === "running", 3000, "run start");
  await store.stop(record);
  release();
  await waitFor(() => store.statusOf(record) === "stopped", 3000, "stopped");

  const runEnd = events.filter((entry) => entry.type === "run_end").at(-1);
  assert.ok(runEnd);
  assert.equal(runEnd.data.status, "stopped", "停止を正とする");
  assert.equal(runEnd.data.errorCode, undefined, "停止直後に再実行カードを出させない");
  assert.equal(record.run?.errorCode, undefined);
  assert.equal(store.payload(record).run?.errorCode, undefined);
  assert.equal(JSON.stringify(events).includes("org-SECRET"), false);

  await store.close();
});
