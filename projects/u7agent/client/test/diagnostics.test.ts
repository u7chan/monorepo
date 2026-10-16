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
  diagnosticsDropsLine,
  diagnosticsFileName,
  rawLogConfirmRequest,
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
  for (let seq = 1; seq <= CLIENT_EVENT_LIMIT + 5; seq += 1) recorder.record(event(seq), "s-1", 2000 + seq);

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
  recorder.record(event(1), "s-1");
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
  recorder.record(event(1), "s-1", 10);

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
    events: { limit: 500, maxBytes: 1, available: 3, items: [], dropped: 1, truncated: 2 },
    raw: { available: true, bytes: 10 },
  };
}

test("1 つの JSON は自己記述を持ち、取れない側は理由を残す", () => {
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-1");
  recorder.setGeneration("gen-1");
  recorder.record(event(7), "s-1", 20);
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
  assert.equal(report.drops.serverTruncated, 2);
  assert.equal(report.drops.client, 0);
  assert.equal(report.client?.runStatus, "running");
  assert.equal(report.clientUnavailable, null);
  assert.equal(diagnosticsDropsLine(report), "省略: サーバー 1 件 / クライアント 0 件 / 切り詰め: 2 件");

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

test("別の会話の診断には、対象 server の相関キーを使い他会話の観測値を持ち込まない", () => {
  const recorder = createDiagnosticsRecorder();
  recorder.beginSession("s-a");
  recorder.setGeneration("a-gen");
  recorder.record(event(120), "s-a", 10);
  recorder.recordReconnect();
  recorder.record(event(1), "s-a", 11);
  for (let seq = 0; seq < CLIENT_EVENT_LIMIT; seq += 1) recorder.record(event(200 + seq), "s-a", 20 + seq);
  assert.equal(recorder.capture().dropped > 0, true, "上限で落ちていない");

  const report = buildDiagnosticsReport({
    sessionId: "s-b",
    openSessionId: "s-a",
    chat: { ...initialChatState, sessionId: "s-a", runStatus: "running" },
    recorder: recorder.capture(),
    server: {
      ...serverDiagnostics(),
      sessionId: "s-b",
      eventGeneration: "b-gen",
      lastSeq: 7,
      events: { ...serverDiagnostics().events, dropped: 0, truncated: 0 },
    },
    clientBuild: "test@1",
  });
  assert.equal(report.client, null);
  assert.equal(report.clientUnavailable, "not-open");
  assert.equal(report.eventGeneration, "b-gen", "他会話の世代が相関キーへ入っている");
  assert.equal(report.lastSeq, 7, "他会話の seq が相関キーへ入っている");
  assert.equal(report.reconnectCount, 0, "他会話の再接続回数が入っている");
  assert.equal(report.drops.client, 0, "他会話の省略件数が入っている");
  assert.equal(diagnosticsDropsLine(report), "");
});

test("カーソルは payload の seed で埋まり、世代が変わったら新しい世代の seq へ戻る", () => {
  const recorder = createDiagnosticsRecorder();
  // 会話を開いた直後 (SSE イベント前) は payload の位置を相関キーにする
  recorder.seedCursor("s-1", "gen-1", 42);
  assert.deepEqual(recorder.capture().lastCursor, { generation: "gen-1", seq: 42 });

  // 再起動 / sweep で世代が変わったら、旧世代の seq を残さない (実在しないカーソルを報告しない)
  recorder.setGeneration("gen-2");
  assert.deepEqual(recorder.capture().lastCursor, { generation: "gen-2", seq: 0 });
  recorder.record({ seq: 3, type: "status", data: { state: "thinking", text: "g" }, at: 3 } as EventEntry, "s-1", 30);
  assert.deepEqual(recorder.capture().lastCursor, { generation: "gen-2", seq: 3 });

  // 別セッションのイベントは記録しない (切替直後の旧接続を混ぜない)
  recorder.record(event(9), "s-1", 40);
  recorder.record(event(99), "s-other", 41);
  const state = recorder.capture();
  assert.equal(state.events.at(-1)?.seq, 9);
  assert.deepEqual(state.lastCursor, { generation: "gen-2", seq: 9 });
});

test("生ログの確認は開示のリスクを伝え、danger にはしない", () => {
  const request = rawLogConfirmRequest("決済画面の検証");
  assert.equal(request.kind, "confirm");
  assert.equal(request.confirmLabel, "ダウンロードする");
  assert.deepEqual(request.subject, { label: "対象の会話", value: "決済画面の検証" });
  assert.ok(
    request.body?.some((line) => line.includes("生のまま")),
    "生の値を含む注意が本文に無い",
  );
  assert.notEqual(request.danger, true, "開示の確認を danger トーンにしている");
  assert.equal(rawLogConfirmRequest("").subject, undefined);
});

test("省略の 1 行は、落ちた件数と切り詰めた件数を報告する", () => {
  const truncated = { ...serverDiagnostics(), events: { ...serverDiagnostics().events, dropped: 0, truncated: 2 } };
  const report = buildDiagnosticsReport({
    sessionId: "s-1",
    openSessionId: "s-1",
    chat: { ...initialChatState, sessionId: "s-1" },
    recorder: createDiagnosticsRecorder().capture(),
    server: truncated,
    clientBuild: "test@1",
  });
  assert.equal(diagnosticsDropsLine(report), "省略: サーバー 0 件 / クライアント 0 件 / 切り詰め: 2 件");

  // 省略が無いときは空文字 (呼び出し側の結果行に行を足さない)
  const clean = { ...serverDiagnostics(), events: { ...serverDiagnostics().events, dropped: 0, truncated: 0 } };
  const cleanReport = buildDiagnosticsReport({
    sessionId: "s-1",
    openSessionId: "s-1",
    chat: { ...initialChatState, sessionId: "s-1" },
    recorder: createDiagnosticsRecorder().capture(),
    server: clean,
    clientBuild: "test@1",
  });
  assert.equal(diagnosticsDropsLine(cleanReport), "");
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
      ["省略（イベント）", "1", "—"],
      ["切り詰め（data）", "2", "—"],
      ["再接続", "—", "—"],
    ],
  );
});
