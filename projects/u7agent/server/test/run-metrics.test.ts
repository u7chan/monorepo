// ランの所要時間から ask_user の回答待ちを除く規則の検証。区間は BFF 計測 (ToolCall.startedAt /
// endedAt) だけを正とし、質問の登録 / settle や finish の順序に依存しないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { AppDb } from "../src/app-db";
import { NotificationService } from "../src/notifications";
import { testAppCipher } from "./app-secret-fixture";
import { createSecretMasker } from "../src/redact";
import { askUserWaitTotalMs, runDurationMs } from "../src/run-metrics";
import type { PiSessionEntryLike } from "../src/pi-runtime";
import type { AskUserAnswer, AskUserQuestion, EventEntry, HistoryItem } from "../src/schema";
import {
  SessionStore,
  type PiRuntimeLike,
  type PiSessionEvent,
  type PiSessionEventListener,
  type PiSessionLike,
  type SessionRecord,
} from "../src/sessions";

const CWD = "/tmp/project";
const WEBHOOK = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";

const QUESTIONS: AskUserQuestion[] = [{ question: "進めますか", options: [{ label: "はい" }] }];
const ANSWERS: AskUserAnswer[] = [{ index: 0, selected: ["はい"] }];
const ASK_ARGS = { questions: QUESTIONS };
const DETAILS = { questions: QUESTIONS, answers: ANSWERS };

const ask = (id: string, startedAt?: number, endedAt?: number) => ({
  id,
  name: "ask_user",
  startedAt,
  endedAt,
});
const read = (startedAt: number, endedAt: number) => ({ id: "read-1", name: "read", startedAt, endedAt });

function text(value: string): unknown {
  return { type: "text", text: value };
}

// --- 区間の和 (純関数) ---

test("ask_user の閉じた区間だけを足し、名前の違うツールは数えない", () => {
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 4_000)], 10_000), 3_000);
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 4_000), read(1_000, 9_000)], 10_000), 3_000);
  assert.equal(askUserWaitTotalMs([read(1_000, 9_000)], 10_000), 0);
});

test("離れた区間は足し、重なった区間は和集合で 1 回だけ数える", () => {
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 2_000), ask("b", 3_000, 4_000)], 10_000), 2_000);
  // 並行に 2 枚待っても実時間は 1_000..6_000 の 5 秒だけ
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 5_000), ask("b", 2_000, 6_000)], 10_000), 5_000);
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 3_000), ask("b", 3_000, 4_000)], 10_000), 3_000);
});

test("片方だけ終わった状態では、開いている区間を評価時刻まで数える", () => {
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 3_000), ask("b", 2_000)], 6_000), 5_000);
});

test("開いたままの待機は評価時刻で閉じ、評価時刻より後に終わった区間も評価時刻までにする", () => {
  assert.equal(askUserWaitTotalMs([ask("a", 1_000)], 4_000), 3_000);
  assert.equal(askUserWaitTotalMs([ask("a", 1_000, 9_000)], 5_000), 4_000);
});

test("startedAt が無いカードは区間を作らない (従来どおり待機を引かない)", () => {
  assert.equal(askUserWaitTotalMs([ask("a", undefined, 5_000)], 10_000), 0);
  assert.equal(askUserWaitTotalMs([], 10_000), 0);
});

test("ランの所要時間は回答待ちを引き、負にしない", () => {
  assert.equal(
    runDurationMs({ startedAt: 1_000, endedAt: 11_000, tools: [ask("a", 2_000, 6_000)] }),
    6_000,
    "作業 10 秒のうち回答待ち 4 秒を引く",
  );
  assert.equal(
    runDurationMs({ startedAt: 1_000, endedAt: 3_000, tools: [ask("a", 1_000, 9_000)] }),
    0,
    "区間が実時間を超えても負にしない",
  );
});

// --- ランの確定値と通知 (SessionStore) ---

interface ScriptedSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
}

interface ScriptedSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
  /** SDK の entry 列 (履歴投影が getBranch から読む) */
  branch: PiSessionEntryLike[];
}

/** SDK と同じく、メッセージを agent state と entry 列の両方へ同じ参照で積む */
function pushMessage(session: ScriptedSession, message: Record<string, unknown>): void {
  session.messages.push(message as PiSessionLike["messages"][number]);
  session.branch.push({
    type: "message",
    id: `entry-${session.branch.length + 1}`,
    parentId: null,
    timestamp: "",
    message,
  });
}

/** スクリプトを prompt() の中で一度だけ走らせる最小セッション */
function scriptedSession(run: (session: ScriptedSession) => void): ScriptedSession {
  const listeners = new Set<PiSessionEventListener>();
  const branch: PiSessionEntryLike[] = [];
  const session = {
    sessionId: "pi-run-metrics",
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as PiSessionLike["messages"],
    branch,
    isStreaming: false,
    disposed: false,
    sessionManager: { getBranch: () => branch },
    get isIdle() {
      return !session.isStreaming;
    },
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ["low"],
    setThinkingLevel() {},
    async setModel() {},
    subscribe(listener: PiSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiSessionEvent) {
      for (const listener of listeners) listener(event);
    },
    async abort() {},
    dispose() {
      session.disposed = true;
    },
    async prompt() {
      session.isStreaming = true;
      try {
        run(session as unknown as ScriptedSession);
      } finally {
        session.isStreaming = false;
      }
    },
  };
  return session as unknown as ScriptedSession;
}

function createStore(session: PiSessionLike, notifications?: NotificationService | null): SessionStore {
  return new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    masker: createSecretMasker([]),
    rootCwd: CWD,
    notifications: notifications ?? null,
  });
}

/** スクリプトの間だけ進められる時計 (値の検証を sleep に依存させない) */
function fakeClock(startedAt = 1_000_000) {
  const real = Date.now;
  const clock = {
    now: startedAt,
    install() {
      Date.now = () => clock.now;
    },
    restore() {
      Date.now = real;
    },
  };
  return clock;
}

/** assistant の確認メッセージと user entry を積む (履歴 item の runId を run へ対応付ける) */
function appendUser(session: ScriptedSession): void {
  const user = { role: "user", content: "聞いて", timestamp: 1 };
  pushMessage(session, user);
  session.emit({ type: "message_end", message: user });
}

function appendAsked(session: ScriptedSession, id: string): void {
  const asked = {
    role: "assistant",
    content: [text("確認します"), { type: "toolCall", id, name: "ask_user", arguments: ASK_ARGS }],
    stopReason: "stop",
    timestamp: 2,
  };
  pushMessage(session, asked);
  session.emit({ type: "message_end", message: asked });
}

function appendToolResult(session: ScriptedSession, id: string): void {
  pushMessage(session, {
    role: "toolResult",
    content: [text("ユーザーの回答:")],
    toolCallId: id,
    isError: false,
    details: DETAILS,
    timestamp: 3,
  });
}

function appendDone(session: ScriptedSession): void {
  const done = { role: "assistant", content: [text("続けます")], stopReason: "stop", timestamp: 4 };
  pushMessage(session, done);
  session.emit({ type: "message_end", message: done });
}

function fakeFetch() {
  const calls: Array<{ url: string; body: string }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(null, { status: 204 });
  };
  return { impl, calls };
}

test("run_end / runOutcomes / 履歴 / 通知は同じ所要時間になり、回答待ちを 3 分含めない", async () => {
  const clock = fakeClock();
  const session = scriptedSession((s) => {
    s.emit({ type: "agent_start" });
    appendUser(s);
    appendAsked(s, "call-1");
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args: ASK_ARGS });
    clock.now += 180_000;
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ask_user",
      isError: false,
      result: { content: [text("ユーザーの回答:")], details: DETAILS },
    });
    appendToolResult(s, "call-1");
    appendDone(s);
    clock.now += 10_000;
    s.emit({ type: "agent_settled" });
  });
  const { impl, calls } = fakeFetch();
  const db = AppDb.open({ storeDir: null });
  const notifications = new NotificationService({ db, fetchImpl: impl, cipher: testAppCipher() });
  notifications.save({ webhookUrl: WEBHOOK, enabled: true });
  const store = createStore(session, notifications);
  try {
    const record = await store.create({ notify: true });
    const events: EventEntry[] = [];
    store.subscribe(record, undefined, (entry) => events.push(entry));

    clock.install();
    let runId: string | undefined;
    try {
      runId = store.postMessage(record, "聞いて").runId;
    } finally {
      clock.restore();
    }
    assert.ok(runId, "run id が返る");

    const payload = store.payload(record);
    assert.equal(payload.run?.status, "completed");
    assert.equal(
      (payload.run?.endedAt ?? 0) - (payload.run?.startedAt ?? 0),
      190_000,
      "ラン全体は回答待ち 3 分を含む 190 秒",
    );

    const runEnd = events.find((entry) => entry.type === "run_end");
    assert.ok(runEnd);
    assert.equal(runEnd.data.durationMs, 10_000, "回答待ちを引いた 10 秒");
    assert.equal(record.runOutcomes.get(runId)?.durationMs, runEnd.data.durationMs, "控えと run_end が同じ値");
    assert.equal(record.runOutcomes.get(runId)?.outcome, "completed");

    const history = store.history(record, {});
    assert.ok(history.ok);
    const user = history.page.items.find(
      (item): item is Extract<HistoryItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
    );
    assert.equal(user?.runDurationMs, runEnd.data.durationMs, "履歴 item へ同じ値を写す");
    assert.equal(user?.runOutcome, "completed");

    assert.equal(calls.length, 1, "完了通知を 1 通送る");
    const embed = JSON.parse(calls[0].body) as { embeds: Array<{ description: string }> };
    assert.match(
      embed.embeds[0].description.split("\n")[0] ?? "",
      /・ 10秒 ・ ツール 1件$/,
      "通知の所要時間も回答待ちを引く (190 秒は含めない)",
    );
  } finally {
    notifications.close();
    await store.close();
  }
});

test("質問の登録 / settle の時刻ではなくツール計測を正にする", async () => {
  const clock = fakeClock();
  let store: SessionStore;
  let record: SessionRecord;
  const session = scriptedSession((s) => {
    s.emit({ type: "agent_start" });
    appendUser(s);
    appendAsked(s, "call-1");
    // 登録や settle がツールの区間とずれても、控える値は tool_execution_start / end で決まる
    void store.askUserHost().ask(record.id, "call-1", QUESTIONS, undefined);
    s.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args: ASK_ARGS });
    clock.now += 30_000;
    store.answerQuestion(record, "call-1", ANSWERS);
    clock.now += 60_000;
    s.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "ask_user",
      isError: false,
      result: { content: [text("ユーザーの回答:")], details: DETAILS },
    });
    appendToolResult(s, "call-1");
    appendDone(s);
    clock.now += 10_000;
    s.emit({ type: "agent_settled" });
  });
  store = createStore(session);
  try {
    record = await store.create();
    clock.install();
    let runId: string | undefined;
    try {
      runId = store.postMessage(record, "聞いて").runId;
    } finally {
      clock.restore();
    }
    assert.ok(runId);
    assert.equal(
      record.runOutcomes.get(runId)?.durationMs,
      10_000,
      "登録から settle までの 30 秒ではなく、ツール区間の 90 秒を引く",
    );
  } finally {
    await store.close();
  }
});

test("開いたまま停止した待機も finish の時点で閉じ、控えた値を後から書き換えない", async () => {
  const clock = fakeClock();
  const session = scriptedSession(() => {});
  session.prompt = () => {
    session.isStreaming = true;
    // 最初の 5 秒は作業してから質問を出し、回答を待ったまま止まる
    clock.now += 5_000;
    appendUser(session);
    appendAsked(session, "call-1");
    session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask_user", args: ASK_ARGS });
    return new Promise(() => {});
  };
  session.abort = async () => {
    session.isStreaming = false;
    session.emit({ type: "agent_settled" });
  };
  const store = createStore(session);
  try {
    const record = await store.create();
    const events: EventEntry[] = [];
    store.subscribe(record, undefined, (entry) => events.push(entry));

    clock.install();
    let runId: string | undefined;
    try {
      runId = store.postMessage(record, "聞いて").runId;
      clock.now += 60_000;
      await store.stop(record);
    } finally {
      clock.restore();
    }
    assert.ok(runId);

    assert.equal(record.tools.get("call-1")?.endedAt, undefined, "tool_end は届いていない");
    assert.equal(
      events.some((entry) => entry.type === "tool_end"),
      false,
    );
    const runEnd = events.find((entry) => entry.type === "run_end");
    assert.equal(runEnd?.data.durationMs, 5_000, "回答待ち 60 秒を引いた作業 5 秒");
    assert.equal(record.runOutcomes.get(runId)?.durationMs, runEnd.data.durationMs);
    assert.equal(record.runOutcomes.get(runId)?.outcome, "stopped");
  } finally {
    await store.close();
  }
});
