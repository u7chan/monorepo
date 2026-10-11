// 診断情報のクライアント側ロジック。イベントのリングバッファ (上限・セッション切替) と、
// スナップショット / 1 つの JSON への組み立てを、本文を載せない契約ごと固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState, type ChatState } from "../src/hooks/chatReducer";
import {
  buildDiagnosticsReport,
  CLIENT_EVENT_LIMIT,
  clientSnapshotOf,
  createDiagnosticsRecorder,
  DIAGNOSTICS_KIND,
  DIAGNOSTICS_NOTE,
  diagnosticsCompareRows,
  diagnosticsFileName,
  rawLogFileName,
  summarizeEvent,
} from "../src/lib/diagnostics";
import type { EventEntry, SessionDiagnostics, ToolCall } from "../src/types";

function event(seq: number, type: EventEntry["type"] = "status"): EventEntry {
  return { seq, type, data: { state: "thinking", text: `${type}-${seq}` }, at: 1000 + seq } as EventEntry;
}

test("リングバッファは上限で古い方から落とし、落とした件数を残す", () => {
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-1");
  recorder.setGeneration("gen-1");
  for (let seq = 1; seq <= CLIENT_EVENT_LIMIT + 5; seq += 1) recorder.record(event(seq), 2000 + seq);

  const state = recorder.capture();
  assert.equal(state.sessionId, "s-1");
  assert.equal(state.events.length, CLIENT_EVENT_LIMIT);
  assert.equal(state.dropped, 5);
  assert.equal(state.events[0]?.seq, 6, "古いイベントが残っている");
  assert.equal(state.events.at(-1)?.seq, CLIENT_EVENT_LIMIT + 5);
  // 受信時刻はブラウザー側、at はサーバーの発行時刻 (両方残す)
  assert.equal(state.events.at(-1)?.receivedAt, 2000 + CLIENT_EVENT_LIMIT + 5);
  assert.equal(state.events.at(-1)?.at, 1000 + CLIENT_EVENT_LIMIT + 5);
  assert.deepEqual(state.lastCursor, { generation: "gen-1", seq: CLIENT_EVENT_LIMIT + 5 });
  assert.equal(state.lastReceivedAt, 2000 + CLIENT_EVENT_LIMIT + 5);
});

test("セッションを切り替えると保持分を捨て、同じセッションでは保つ", () => {
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-1");
  recorder.setGeneration("gen-1");
  recorder.record(event(1));
  recorder.recordReconnect();
  recorder.recordReconnect();

  recorder.beginSession("s-1");
  assert.equal(recorder.capture().events.length, 1, "同じセッションで捨てている");
  assert.equal(recorder.capture().reconnectCount, 2);

  recorder.beginSession("s-2");
  const state = recorder.capture();
  assert.equal(state.sessionId, "s-2");
  assert.deepEqual(state.events, []);
  assert.equal(state.dropped, 0);
  assert.equal(state.reconnectCount, 0);
  assert.equal(state.lastCursor, null);
  assert.equal(state.lastReceivedAt, null);
});

test("イベントの要約は本文を入れず、長さと件数だけを持つ", () => {
  const text = { seq: 1, type: "text", data: { delta: "とても長い本文" }, at: 1 } as EventEntry;
  assert.deepEqual(summarizeEvent(text), { chars: "とても長い本文".length });

  const toolEnd = {
    seq: 2,
    type: "tool_end",
    data: {
      id: "t-1",
      name: "ask_user",
      isError: false,
      output: "本文",
      answers: [
        { index: 0, skipped: true },
        { index: 1, selected: ["a"] },
      ],
    },
    at: 2,
  } as EventEntry;
  assert.deepEqual(summarizeEvent(toolEnd), {
    id: "t-1",
    name: "ask_user",
    isError: false,
    outputChars: 2,
    answers: 2,
    skipped: 1,
  });

  const runStart = {
    seq: 3,
    type: "run_start",
    data: { runId: "r-1", prompt: "秘密の本文", startedAt: 5 },
    at: 3,
  } as EventEntry;
  assert.deepEqual(summarizeEvent(runStart), { runId: "r-1", promptChars: 5, startedAt: 5 });

  const resync = {
    seq: 4,
    type: "resync",
    data: { sessionId: "s-1", status: "running", lastSeq: 4, run: { id: "r-1" }, queueDepth: 1, messages: [] },
    at: 4,
  } as unknown as EventEntry;
  assert.deepEqual(summarizeEvent(resync), {
    sessionId: "s-1",
    status: "running",
    lastSeq: 4,
    runId: "r-1",
    queueDepth: 1,
  });
});

test("クライアント状態のスナップショットは本文を載せず、カードの要約を持つ", () => {
  const runTool: ToolCall = {
    id: "t-1",
    name: "ask_user",
    args: '{"questions":[]}',
    isError: false,
    done: false,
    output: "回答待ち",
    questions: [{ index: 0, question: "本文" } as never, { index: 1, question: "本文" } as never],
  };
  const chat: ChatState = {
    ...initialChatState,
    sessionId: "s-1",
    runStatus: "running",
    queueDepth: 2,
    runStartedAt: 100,
    activity: "回答を待っています…",
    activityState: "tool",
    currentAssistantId: 3,
    liveToolIds: ["t-1"],
    pendingEchoIds: [1],
    clearedRunIds: ["r-old"],
    retry: { phase: "waiting", attempt: 1, maxAttempts: 2, retryAt: 500, reason: "rate_limit" },
    runError: { code: "rate_limit", text: "混雑しています" },
    runEndSeq: 4,
    runTools: { "t-1": runTool },
    bubbles: [
      {
        id: 3,
        role: "assistant",
        text: "本文",
        tools: [
          {
            id: "t-1",
            name: "ask_user",
            args: "{}",
            phase: "done",
            output: "出力",
            questions: [{ index: 0, question: "本文" } as never],
            answers: [{ index: 0, skipped: true }],
          },
        ],
        skillLoads: [],
      },
    ],
  };
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-1");
  recorder.setGeneration("gen-1");
  recorder.record(event(1), 10);

  const snapshot = clientSnapshotOf(chat, recorder.capture());
  assert.equal(snapshot.sessionId, "s-1");
  assert.equal(snapshot.runStatus, "running");
  assert.equal(snapshot.queueDepth, 2);
  assert.equal(snapshot.runStartedAt, 100);
  assert.equal(snapshot.activity, "回答を待っています…");
  assert.equal(snapshot.currentAssistantId, 3);
  assert.deepEqual(snapshot.liveToolIds, ["t-1"]);
  assert.deepEqual(snapshot.pendingEchoIds, [1]);
  assert.deepEqual(snapshot.clearedRunIds, ["r-old"]);
  assert.deepEqual(snapshot.retry, {
    phase: "waiting",
    attempt: 1,
    maxAttempts: 2,
    retryAt: 500,
    reason: "rate_limit",
  });
  assert.deepEqual(snapshot.runError, { code: "rate_limit", text: "混雑しています" });
  assert.equal(snapshot.bubbles.count, 1);
  assert.equal(snapshot.bubbles.lastRole, "assistant");
  assert.equal(snapshot.history.supported, false);
  assert.equal(snapshot.events.limit, CLIENT_EVENT_LIMIT);
  assert.equal(snapshot.events.available, 1);
  assert.deepEqual(snapshot.events.lastCursor, { generation: "gen-1", seq: 1 });

  // runTools とバブル側の 2 系統を、質問数 / answers の有無 / skipped の数だけで見えるようにする
  assert.deepEqual(snapshot.runTools, [
    {
      id: "t-1",
      name: "ask_user",
      phase: "running",
      questionCount: 2,
      answerCount: 0,
      hasAnswers: false,
      skippedCount: 0,
    },
  ]);
  assert.deepEqual(snapshot.bubbleTools, [
    {
      bubbleId: 3,
      tools: [
        {
          id: "t-1",
          name: "ask_user",
          phase: "done",
          questionCount: 1,
          answerCount: 1,
          hasAnswers: true,
          skippedCount: 1,
        },
      ],
    },
  ]);
  // 本文 (質問 / 回答 / メッセージ) が 1 つも残っていない
  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes("本文"), "質問 / メッセージの本文が載っている");
  assert.ok(!json.includes("回答待ち"), "ツール出力の本文が載っている");
});

function serverDiagnostics(): SessionDiagnostics {
  return {
    kind: "u7agent-session-diagnostics",
    version: 1,
    sessionId: "s-1",
    capturedAt: 1000,
    eventGeneration: "gen-1",
    lastSeq: 7,
    status: "running",
    meta: {
      spaceId: "default",
      title: "テスト",
      agentId: "agent-general",
      workdir: "",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 2,
      notify: false,
      pinned: false,
      sendsDirty: false,
    },
    queue: { depth: 0, runIds: [] },
    run: null,
    questions: [],
    events: { limit: 500, maxBytes: 1, available: 3, items: [], dropped: 1, truncated: 0 },
    raw: { available: true, bytes: 10 },
  };
}

test("1 つの JSON は自己記述を持ち、取れない側は理由を残す", () => {
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-1");
  recorder.setGeneration("gen-1");
  recorder.record(event(7), 20);
  recorder.recordReconnect();

  const report = buildDiagnosticsReport({
    sessionId: "s-1",
    openSessionId: "s-1",
    chat: { ...initialChatState, sessionId: "s-1", runStatus: "running" },
    recorder: recorder.capture(),
    server: serverDiagnostics(),
    clientBuild: "test@1",
    capturedAt: 5000,
  });
  assert.equal(report.kind, DIAGNOSTICS_KIND);
  assert.equal(report.version, 1);
  assert.equal(report.note, DIAGNOSTICS_NOTE);
  assert.equal(report.capturedAt, 5000);
  assert.equal(report.clientBuild, "test@1");
  assert.equal(report.eventGeneration, "gen-1");
  assert.equal(report.lastSeq, 7);
  assert.equal(report.reconnectCount, 1);
  assert.equal(report.drops.server, 1);
  assert.equal(report.client?.runStatus, "running");
  assert.equal(report.clientUnavailable, null);

  // 開いていない会話ではクライアント状態を付けず、理由を残す
  const other = buildDiagnosticsReport({
    sessionId: "s-1",
    openSessionId: "s-2",
    chat: { ...initialChatState, sessionId: "s-2" },
    recorder: recorder.capture(),
    server: null,
    serverError: "HTTP 500",
    clientBuild: "test@1",
  });
  assert.equal(other.client, null);
  assert.equal(other.clientUnavailable, "not-open");
  assert.equal(other.server, null);
  assert.equal(other.serverError, "HTTP 500");
});

test("保存名は <id8>-<yyyymmdd-hhmm> を持つ", () => {
  const at = new Date(2026, 9, 12, 8, 5).getTime();
  assert.equal(diagnosticsFileName("3f2b9a1c7d", at), "u7agent-diagnostics-3f2b9a1c-20261012-0805.json");
  assert.equal(rawLogFileName("3f2b9a1c7d", at), "u7agent-raw-3f2b9a1c-20261012-0805.jsonl");
});

test("突き合わせは値を並べるだけで、取れない側は — にする", () => {
  const rows = diagnosticsCompareRows(serverDiagnostics(), null);
  assert.deepEqual(
    rows.map((row) => [row.label, row.server, row.client]),
    [
      ["状態", "running", "—"],
      ["キュー深度", "0", "—"],
      ["実行中の run id", "—", "—"],
      ["最終 seq", "7", "—"],
      ["世代", "gen-1", "—"],
      ["イベント保持", "3", "—"],
      ["省略", "1", "—"],
      ["再接続", "—", "—"],
    ],
  );
});
