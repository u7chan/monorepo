// ツールカードの持ち主と、ツールイベント・圧縮の取り込みの回帰テスト。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState } from "../src/lib/chatState";
import { chatReducer } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import type { ChatState } from "../src/lib/chatState";
import type { CompactionInfo, HistoryPage, MessageMetrics, SessionPayload, ToolCall, Usage } from "../src/types";

/** 実行中・モデル・ツール付きの resync / GET /api/sessions/:id 相当 */
function runningPayload(): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    cwd: "",
    eventGeneration: "gen-1",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    status: "running",
    title: "README をレビューして",
    createdAt: 1,
    lastUsedAt: 2,
    serverNow: 2,
    queueDepth: 2,
    pinned: false,
    lastSeq: 7,
    run: null,
    messages: [
      { role: "user", text: "こんにちは" },
      { role: "assistant", text: "はい" },
    ],
    compactions: [],
  };
}

/** 使用中セッションの状態 (バブル / 実行状態 / 実効モデル) */
function stateWithSession() {
  const resynced = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  return chatReducer(resynced, {
    type: "toolStart",
    id: "tool-1",
    name: "read",
    args: "README.md",
    at: 1700000000002,
  });
}

const USAGE: Usage = {
  input: 8200,
  output: 512,
  cacheRead: 7900,
  cacheWrite: 300,
  totalTokens: 17_040,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0021 },
};

const METRICS: MessageMetrics = { durationMs: 1800, ttftMs: 900, tokensPerSecond: 42.3 };

const COMPACTION: CompactionInfo = {
  id: "entry-compaction-1",
  parentId: "entry-2",
  timestamp: "2026-09-13T00:00:00.000Z",
  summary: "古い会話の要約",
  firstKeptEntryId: "entry-3",
  tokensBefore: 68_000,
  reason: "threshold",
  beforeMessageIndex: 1,
};

function toolCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return { id, name: "bash", args: `$ ${id}`, isError: false, done: true, output: `${id} done`, ...overrides };
}

/** 実行中 run のツール状態を配る payload (resync / GET /api/sessions/:id 相当) */
function payloadWithRunTools(
  messages: { role: "user" | "assistant"; text: string; tools?: ToolCall[] }[],
  toolCalls: ToolCall[],
): SessionPayload {
  return {
    ...runningPayload(),
    messages,
    run: { id: "run-1", status: "running", startedAt: 1700000000000, prompt: "", toolCalls, totalRetryCount: 0 },
  };
}

/** 履歴 API が使える状態 (保持分 1 件)。resync で live のエコーを残すために要る */
function historyWithOld() {
  return chatReducer(initialChatState, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [{ kind: "message", id: "old", context: "active", role: "user", text: "old", runId: "run-old" }],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "old",
      messageCount: 1,
      summarizedMessageCount: 0,
    },
  });
}

/** 実行中の resync (run 付き) を作る */
function streamingPayload(): SessionPayload {
  const payload = runningPayload();
  payload.status = "running";
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  return payload;
}

/** 継続 resync を受けた直後のストリーミング状態 (前半まで受信済み) */
function streamingTurn(): ChatState {
  let state = chatReducer(historyWithOld(), { type: "localUser", text: "質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  return chatReducer(state, { type: "text", delta: "前半", at: 11 });
}

/** assistant カードの本文・所有者ID・ツールID */
function assistantCards(state: ChatState) {
  return state.bubbles
    .filter((bubble) => bubble.role === "assistant")
    .map((bubble) => [bubble.text, bubble.assistantId, bubble.tools.map((card) => card.id)] as const);
}

/** 回答カードを持つバブル (同じ call が 2 枚に増えていないかも見る) */
function askUserCardOwners(state: ChatState, callId: string) {
  return state.bubbles
    .map((bubble) => ({ bubble, cards: bubble.tools.filter((card) => card.id === callId) }))
    .filter((entry) => entry.cards.length > 0);
}

/** 本文なし応答 (run-1:2) のツール。完了分は次の表示本文 (run-1:3) へ繰り上げて投影される */
function bodylessTool(name: "bash" | "ask_user", done: boolean): ToolCall {
  return {
    id: "work-2",
    assistantId: "run-1:2",
    name,
    args: "",
    isError: false,
    done,
    output: done ? "ok" : "",
    ...(name === "ask_user"
      ? { questions: [{ question: "進めますか" }], ...(done ? { answers: [{ index: 0, text: "はい" }] } : {}) }
      : {}),
  };
}

test("running 中の resync は run の重複 call を優先し、tool_end を復元先へ適用する", () => {
  const historyCall: ToolCall = {
    id: "tool-overlap",
    name: "bash",
    args: "old args",
    isError: false,
    done: true,
    output: "old output",
  };
  const runningOverlap: ToolCall = { ...historyCall, args: "current args", done: false, output: "" };
  const runningNew: ToolCall = {
    id: "tool-new",
    name: "read",
    args: "current.txt",
    isError: false,
    done: false,
    output: "",
  };
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "続けて" },
    { role: "assistant", text: "処理中", tools: [historyCall] },
  ];
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "続けて",
    toolCalls: [runningOverlap, runningNew],
    totalRetryCount: 0,
  };

  const resynced = chatReducer(initialChatState, { type: "resync", payload });
  const assistant = resynced.bubbles[1];
  assert.deepEqual(
    assistant?.tools.map((card) => [card.id, card.args, card.phase]),
    [
      ["tool-overlap", "current args", "running"],
      ["tool-new", "current.txt", "running"],
    ],
  );
  assert.deepEqual(resynced.toolBubbleIds, { "tool-overlap": 2, "tool-new": 2 });

  const ended = chatReducer(
    chatReducer(resynced, { type: "toolEnd", id: "tool-overlap", isError: false, output: "fresh output" }),
    { type: "toolEnd", id: "tool-new", isError: true, output: "read failed" },
  );
  assert.deepEqual(
    ended.bubbles[1]?.tools.map((card) => [card.id, card.phase, card.output]),
    [
      ["tool-overlap", "done", "fresh output"],
      ["tool-new", "failed", "read failed"],
    ],
  );
});

test("running の resync は runTools が回答待ちなら活動の文言を回答待ちにする", () => {
  const payload = runningPayload();
  const open: ToolCall = {
    id: "q1",
    name: "ask_user",
    args: "",
    isError: false,
    done: false,
    output: "",
    questions: [{ question: "進めますか" }],
    startedAt: 11,
  };
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "聞いて",
    toolCalls: [open],
    totalRetryCount: 0,
  };

  const waiting = chatReducer(initialChatState, { type: "resync", payload });
  assert.equal(waiting.activity, "回答を待っています…");

  // 回答済み (answers あり) の payload では復帰の文言へ戻る。閉じた区間は経過時間から除かれる
  payload.run = {
    ...payload.run,
    toolCalls: [{ ...open, done: true, endedAt: 12, answers: [{ index: 0, skipped: true }] }],
  };
  const resumed = chatReducer(waiting, { type: "resync", payload });
  assert.equal(resumed.activity, "実行中…（タブを閉じても処理は続きます）");
});

test("compaction イベントは同じ entry を差し替えながら回数と要約を残す", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  const first = chatReducer(state, { type: "compaction", compaction: COMPACTION, count: 1 });
  assert.deepEqual(first.compactions, [COMPACTION]);
  assert.equal(first.activity, "会話を圧縮しました（1回目）");

  // 再送・リプレイで同じ entry が来たら重複させず差し替える
  const updated = { ...COMPACTION, beforeMessageIndex: 0 };
  const replaced = chatReducer(first, { type: "compaction", compaction: updated, count: 1 });
  assert.deepEqual(replaced.compactions, [updated]);

  const second = chatReducer(replaced, {
    type: "compaction",
    compaction: { ...COMPACTION, id: "entry-compaction-2", summary: "2回目の要約", beforeMessageIndex: 0 },
    count: 2,
  });
  assert.deepEqual(
    second.compactions.map((item) => item.summary),
    ["古い会話の要約", "2回目の要約"],
  );
  assert.equal(second.activity, "会話を圧縮しました（2回目）");
  // メッセージの置き換えは resync が担う (イベントだけでは履歴を消さない)
  assert.equal(second.bubbles.length, state.bubbles.length);
});

test("runTools は resync の payload.run.toolCalls で常に置き換わり、run が無ければ空へ戻る", () => {
  const calls = [toolCall("t1"), toolCall("t2", { done: false, output: "" })];
  const running = chatReducer(initialChatState, {
    type: "resync",
    payload: payloadWithRunTools(
      [
        { role: "user", text: "聞いて" },
        { role: "assistant", text: "処理中" },
      ],
      calls,
    ),
  });
  assert.deepEqual(Object.keys(running.runTools), ["t1", "t2"]);
  assert.equal(running.runTools.t2?.done, false);
  assert.deepEqual(
    running.bubbles.at(-1)?.tools.map((card) => card.id),
    ["t1", "t2"],
    "run のツールカードは補完先の assistant に付く",
  );
  assert.equal(
    running.currentAssistantId,
    null,
    "payload.messages に保存済みの応答を開き直さない (次の delta は新しいカード)",
  );

  // 完了 run でもカードは残るが、currentAssistantId は指さない (既存の契約)
  const completed = chatReducer(running, {
    type: "resync",
    payload: {
      ...payloadWithRunTools(
        [
          { role: "user", text: "聞いて" },
          { role: "assistant", text: "処理中" },
        ],
        calls,
      ),
      status: "completed",
      run: {
        id: "run-1",
        status: "completed",
        startedAt: 1700000000000,
        endedAt: 1700000001000,
        prompt: "",
        toolCalls: calls,
        totalRetryCount: 0,
      },
    },
  });
  assert.deepEqual(Object.keys(completed.runTools), ["t1", "t2"]);
  assert.equal(completed.currentAssistantId, null);

  // 空配列 (run 開始直後) は前の run のカードを残さない
  const cleared = chatReducer(running, {
    type: "resync",
    payload: payloadWithRunTools([{ role: "user", text: "聞いて" }], []),
  });
  assert.deepEqual(cleared.runTools, {});

  // run を持たない payload でも空になる
  const withoutRun = chatReducer(running, { type: "resync", payload: runningPayload() });
  assert.deepEqual(withoutRun.runTools, {});
});

test("runTools は runStart / newChat / セッション切替で初期化し、runEnd では消さない", () => {
  const running = chatReducer(initialChatState, {
    type: "resync",
    payload: payloadWithRunTools(
      [
        { role: "user", text: "聞いて" },
        { role: "assistant", text: "処理中" },
      ],
      [toolCall("t1", { done: false, output: "" })],
    ),
  });
  assert.deepEqual(Object.keys(running.runTools), ["t1"]);

  // runEnd はカードを残す (終了後に遅れて適用される履歴ページへ補うため)
  const ended = chatReducer(running, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.deepEqual(Object.keys(ended.runTools), ["t1"]);
  assert.deepEqual(ended.toolBubbleIds, {}, "索引は次の run のイベントを誤適用しないよう空にする");

  // 次の run は前の run のカードを引き継がない
  assert.deepEqual(chatReducer(ended, { type: "runStart", prompt: "続き", at: 2, startedAt: 2 }).runTools, {});

  // 別セッションへ切り替えたら混ぜない
  const switched = chatReducer(running, {
    type: "resync",
    payload: { ...runningPayload(), sessionId: "session-b" },
  });
  assert.deepEqual(switched.runTools, {});

  // 新規チャットも初期化する
  assert.deepEqual(chatReducer(running, { type: "newChat" }).runTools, {});
});

test("liveToolIds はライブのイベントでだけ増え、セッション切替 / 新規チャットで消える", () => {
  // payload が持ち込んだカードはライブ観測ではない (診断の控えの根拠)
  const restored = chatReducer(initialChatState, {
    type: "resync",
    payload: payloadWithRunTools([{ role: "user", text: "聞いて" }], [toolCall("t1")]),
  });
  assert.deepEqual(restored.liveToolIds, []);

  const started = chatReducer(restored, { type: "toolStart", id: "t2", name: "bash", args: "ls", at: 1 });
  assert.deepEqual(started.liveToolIds, ["t2"]);
  const ended = chatReducer(started, { type: "toolEnd", id: "t2", isError: false, output: "ok" });
  assert.deepEqual(ended.liveToolIds, ["t2"], "同じ id を二重に持たない");
  assert.deepEqual(chatReducer(ended, { type: "toolStart", id: "t3", name: "read", args: "a", at: 2 }).liveToolIds, [
    "t2",
    "t3",
  ]);

  // 別の会話へ切り替えたら持ち越さない (古い id を新しい会話のライブ観測と誤読させない)
  assert.deepEqual(
    chatReducer(ended, { type: "resync", payload: { ...runningPayload(), sessionId: "session-b" } }).liveToolIds,
    [],
  );
  assert.deepEqual(chatReducer(ended, { type: "newChat" }).liveToolIds, []);
});

test("resync の run 側カードは前ターンへ付かず、text / usage も前ターンへ混ぜない (legacy)", () => {
  const resynced = chatReducer(initialChatState, {
    type: "resync",
    payload: payloadWithRunTools(
      [
        { role: "user", text: "1通目" },
        { role: "assistant", text: "1通目の答え" },
        { role: "user", text: "2通目" },
      ],
      [toolCall("t1")],
    ),
  });
  // 補完先 = 最後の user より後の assistant が無いので保留する
  assert.deepEqual(resynced.bubbles[1]?.tools, [], "前ターンの assistant へ付けない");
  assert.deepEqual(resynced.bubbles[1]?.text, "1通目の答え");
  assert.deepEqual(Object.keys(resynced.runTools), ["t1"]);
  assert.equal(resynced.currentAssistantId, null, "前ターンの assistant を指さない");

  const streaming = chatReducer(resynced, { type: "text", delta: "2通目の生成中", at: 3 });
  assert.equal(streaming.bubbles[1]?.text, "1通目の答え", "前ターンの本文へ混ぜない");
  const current = streaming.bubbles.at(-1);
  assert.equal(current?.role, "assistant");
  assert.equal(current?.text, "2通目の生成中");
  assert.deepEqual(
    current?.tools.map((card) => [card.id, card.phase]),
    [["t1", "done"]],
    "保留していたカードが現在ターンへ付く",
  );

  const withUsage = chatReducer(streaming, { type: "usage", usage: USAGE, metrics: METRICS });
  assert.deepEqual(withUsage.bubbles[1]?.usage, undefined, "前ターンへ usage を混ぜない");
  assert.deepEqual(withUsage.bubbles.at(-1)?.usage, USAGE);
});

test("補完先が無い run 側カードは保留し、text / toolStart で補完先ができたら補う", () => {
  const held = (calls: ToolCall[]) =>
    chatReducer(initialChatState, {
      type: "resync",
      payload: payloadWithRunTools([{ role: "user", text: "1通目" }], calls),
    });

  // text が作る assistant バブルへ回る
  const waiting = held([toolCall("t1", { done: false, output: "" })]);
  assert.deepEqual(
    waiting.bubbles.map((bubble) => bubble.role),
    ["user"],
    "補完先が無ければ補完しない",
  );
  const streamed = chatReducer(waiting, { type: "text", delta: "生成中", at: 2 });
  assert.deepEqual(
    streamed.bubbles.at(-1)?.tools.map((card) => [card.id, card.phase]),
    [["t1", "running"]],
  );
  assert.equal(streamed.bubbles.at(-1)?.text, "生成中");

  // toolStart が作る assistant バブルへ、保留分と合わせて回る
  const withTool = chatReducer(held([toolCall("t1", { done: false, output: "" })]), {
    type: "toolStart",
    id: "t2",
    name: "read",
    args: "README.md",
    at: 3,
  });
  assert.deepEqual(
    withTool.bubbles.at(-1)?.tools.map((card) => card.id),
    ["t1", "t2"],
  );
});

test("保留中の run 側カードは新しい toolStart より先に並ぶ (呼び出し順を逆にしない)", () => {
  // 補完先が無いまま resync が run のカード t1 を配り、次に toolStart(t2) が初めて assistant バブルを作る
  const held = chatReducer(initialChatState, {
    type: "resync",
    payload: payloadWithRunTools([{ role: "user", text: "1通目" }], [toolCall("t1", { done: false, output: "" })]),
  });
  assert.deepEqual(Object.keys(held.runTools), ["t1"], "補完先が無ければ保留する");

  const withTool = chatReducer(held, { type: "toolStart", id: "t2", name: "read", args: "README.md", at: 3 });
  assert.deepEqual(Object.keys(withTool.runTools), ["t1", "t2"], "run 側の挿入順を保つ");
  const targetId = withTool.bubbles.at(-1)?.id;
  assert.deepEqual(
    withTool.bubbles.at(-1)?.tools.map((card) => [card.id, card.phase]),
    [
      ["t1", "running"],
      ["t2", "running"],
    ],
    "保留分を先に補ってから新しいカードを足す",
  );
  assert.deepEqual(withTool.toolBubbleIds, { t1: targetId, t2: targetId }, "索引も同じバブルを指す");
});

// --- 生成中の活動表示 (activityState) ---

test("tool_progress は該当 ID の progress だけを更新し、カードや履歴は変えない", () => {
  const state = stateWithSession();
  const next = chatReducer(state, { type: "toolProgress", id: "tool-1", text: "bash rg -n investigate" });

  assert.equal(next.runTools["tool-1"]?.progress, "bash rg -n investigate");
  // バブル側 (履歴寄りの状態) へは写さない。進捗は状態行だけが読む
  assert.deepEqual(next.bubbles, state.bubbles);
  assert.deepEqual(next.toolBubbleIds, state.toolBubbleIds);
  assert.equal("progress" in (state.runTools["tool-1"] ?? {}), false, "元の状態を書き換えている");

  // run 側にカードが無い id は無視する (復元カードを live の出来事として作らない)
  assert.equal(chatReducer(state, { type: "toolProgress", id: "unknown", text: "x" }), state);
});

test("progress は resync で消える (payload が正の復元に live 値を残さない)", () => {
  const progressed = chatReducer(stateWithSession(), {
    type: "toolProgress",
    id: "tool-1",
    text: "結論: docs/subagent.md にある",
  });
  assert.equal(progressed.runTools["tool-1"]?.progress, "結論: docs/subagent.md にある");

  const payload = runningPayload();
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "続けて",
    toolCalls: [{ id: "tool-1", name: "investigate", args: "docs", isError: false, done: false, output: "" }],
    totalRetryCount: 0,
  };
  const resynced = chatReducer(progressed, { type: "resync", payload });

  assert.equal(resynced.runTools["tool-1"]?.done, false, "カードは payload から残る");
  assert.equal("progress" in (resynced.runTools["tool-1"] ?? {}), false, "progress を残している");
});

// --- ターン終端の所要時間 (run_end → user パブル) ---

test("steering 後の履歴再取得でも run のツールカードを次の応答へ移さない", () => {
  // What: assistant_end → ツール → steering → resync / resyncHistory を挟んでも所有者は 1 枚目のまま
  let state = streamingTurn();
  state = chatReducer(state, { type: "assistantEnd" });
  state = chatReducer(state, { type: "toolStart", id: "tool-1", name: "bash", args: "{}", at: 11 });
  state = chatReducer(state, { type: "toolEnd", id: "tool-1", isError: false, output: "ok" });
  state = chatReducer(state, { type: "localUser", text: "追記", at: 12 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", stateSeq: state.stateSeq });

  const payload = streamingPayload();
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "質問",
    toolCalls: [{ id: "tool-1", name: "bash", args: "{}", isError: false, done: true, output: "ok" }],
    totalRetryCount: 0,
  };
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        { kind: "message", id: "old", context: "active", role: "user", text: "old", runId: "run-old" },
        { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "前半" },
        { kind: "message", id: "u-2", context: "active", role: "user", text: "追記", sendId: "send-2", runId: "run-1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "old",
      messageCount: 4,
      summarizedMessageCount: 0,
    },
  });
  // 履歴マージの後にも run.toolCalls の復元が走る
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, { type: "text", delta: "追記を受け取って次の判断に反映", at: 13 });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["前半", ["tool-1"]],
      ["追記を受け取って次の判断に反映", []],
    ],
    "ツールは要求した 1 枚目だけに付く",
  );
});

test("assistant_end を跨がないツールイベントは開いている応答に付く", () => {
  // What: 同じ応答のストリーミング中に届くツールは、その応答のカードへ付く (境界を跨がない)
  let state = streamingTurn();
  state = chatReducer(state, { type: "toolStart", id: "tool-9", name: "read", args: "{}", at: 11 });
  state = chatReducer(state, { type: "toolEnd", id: "tool-9", isError: false, output: "ok" });
  state = chatReducer(state, { type: "text", delta: "続き", at: 12 });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.text, "前半続き");
  assert.deepEqual(
    assistants[0]?.tools.map((card) => card.id),
    ["tool-9"],
  );
});

test("同じ本文の別応答でも assistantId でツール所有者を分ける", () => {
  // What: 同本文の 2 応答が並ぶ run で、再接続・履歴再取得後もツールカードが要求元の応答に残る
  const call = (id: string, assistantId: string): ToolCall => ({
    id,
    assistantId,
    name: "bash",
    args: "",
    isError: false,
    done: true,
    output: "ok",
  });
  const message = (id: string, assistantId: string, tools: ToolCall[]): HistoryPage["items"][number] => ({
    kind: "message",
    id,
    context: "active",
    role: "assistant",
    text: "確認します",
    assistantId,
    tools,
  });
  const page = (withSecond: boolean): HistoryPage => ({
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "u-1",
        context: "active",
        role: "user",
        text: "確認して",
        sendId: "send-1",
        runId: "run-1",
      },
      message("a-1", "run-1:1", [call("work-1", "run-1:1")]),
      ...(withSecond ? [message("a-2", "run-1:2", [call("work-2", "run-1:2")])] : []),
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: withSecond ? 3 : 2,
    summarizedMessageCount: 0,
  });

  let state = chatReducer(initialChatState, { type: "resyncHistory", page: page(false) });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "確認して",
    at: 10,
    startedAt: 10,
  });
  // 2 応答目は 1 応答目と同じ本文で流れる
  state = chatReducer(state, { type: "text", delta: "確認します", at: 11, assistantId: "run-1:2" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-2",
    name: "bash",
    args: "",
    at: 12,
    assistantId: "run-1:2",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-2", isError: false, output: "ok" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });

  // 再接続: run の全ツールと保存済み 1 応答目を配る
  const payload = streamingPayload();
  payload.messages = [
    { role: "user", text: "確認して" },
    {
      role: "assistant",
      text: "確認します",
      assistantId: "run-1:1",
      tools: [{ ...call("work-1", "run-1:1"), name: "bash", args: "" }],
    },
  ];
  payload.run = {
    id: "run-1",
    status: "running",
    startedAt: 10,
    prompt: "確認して",
    toolCalls: [
      { ...call("work-1", "run-1:1"), name: "bash", args: "" },
      { ...call("work-2", "run-1:2"), name: "bash", args: "" },
    ],
    totalRetryCount: 0,
  };
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, { type: "resyncHistory", page: page(true) });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.assistantId, bubble.tools.map((card) => card.id)]),
    [
      ["確認します", "run-1:1", ["work-1"]],
      ["確認します", "run-1:2", ["work-2"]],
    ],
    "同本文でもツールを相互に移さない",
  );
});

test("新しい会話のツール付き応答でも assistantId が変われば次応答を分ける", () => {
  // What: 履歴ページ未取得の初回ターンでも、steering 後の次応答を前のツール応答へ連結しない
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "前半", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "tool-1",
    name: "bash",
    args: "",
    at: 3,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, { type: "toolEnd", id: "tool-1", isError: false, output: "ok" });
  state = chatReducer(state, { type: "localUser", text: "追記", at: 4 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", stateSeq: state.stateSeq });
  state = chatReducer(state, { type: "text", delta: "追記を受け取って", at: 5, assistantId: "run-1:2" });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["前半", ["tool-1"]],
      ["追記を受け取って", []],
    ],
    "assistant_end が無くても ID が変われば新しいカード",
  );
  const userIndex = state.bubbles.findIndex((bubble) => bubble.sendId === "send-2");
  assert.ok(state.bubbles.findIndex((bubble) => bubble.assistantId === "run-1:1") < userIndex);
  assert.ok(userIndex < state.bubbles.findIndex((bubble) => bubble.assistantId === "run-1:2"));
});

test("assistant_end 後の並列ツール再接続で閉じた応答を本文の補完先にしない", () => {
  // What: 実 SDK の順（assistant_end → ツール開始）でも、再接続と履歴再取得を挟んだ次応答が別カードになる
  const call = (id: string): ToolCall => ({
    id,
    assistantId: "run-1:1",
    name: "bash",
    args: "",
    isError: false,
    done: true,
    output: "ok",
  });
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "A", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "toolStart", id: "t1", name: "bash", args: "", at: 3, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "toolStart", id: "t2", name: "bash", args: "", at: 4, assistantId: "run-1:1" });
  assert.equal(state.currentAssistantId, null, "ツール開始で本文の補完先を開き直さない");

  const payload = streamingPayload();
  payload.messages = [
    { role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
    { role: "assistant", text: "A", assistantId: "run-1:1", tools: [call("t1"), call("t2")] },
  ];
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "running",
    startedAt: 1,
    prompt: "質問",
    toolCalls: [call("t1"), call("t2")],
    totalRetryCount: 0,
  };
  state = chatReducer(state, { type: "resync", payload });
  assert.equal(state.currentAssistantId, null, "再接続の resync でも閉じた応答を開き直さない");
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
        {
          kind: "message",
          id: "a-1",
          context: "active",
          role: "assistant",
          text: "A",
          assistantId: "run-1:1",
          tools: [call("t1"), call("t2")],
        },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 2,
      summarizedMessageCount: 0,
    },
  });
  state = chatReducer(state, { type: "text", delta: "B", at: 5, assistantId: "run-1:2" });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["A", ["t1", "t2"]],
      ["B", []],
    ],
  );
});

test("本文のない別応答のツールは、次の本文 item まで溜め、別の応答の所有者へは縮退しない", () => {
  // What: 「本文A＋work-1 → 本文なしの別ID応答＋work-2 → 本文B」で、work-2 が A の所有者へ縮退せず、
  // 確定履歴が繰り上げる先 (本文B) と同じ item に付く
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "確認して",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "A", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-1",
    name: "bash",
    args: "",
    at: 3,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-1", isError: false, output: "ok" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  // 本文を持たない 2 応答目。閉じた A が toolTargetAssistantId に残ったまま次 ID のツールが届く
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-2",
    name: "bash",
    args: "",
    at: 4,
    assistantId: "run-1:2",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-2", isError: false, output: "ok" });
  assert.deepEqual(
    assistantCards(state),
    [
      ["A", "run-1:1", ["work-1"]],
      ["", undefined, ["work-2"]],
    ],
    "異なる ID の旧所有者へ work-2 を付けず、本文 item が現れるまで host に溜める",
  );

  // 途中の再接続と履歴再取得でも所有者が変わらない
  const payload = streamingPayload();
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "running",
    startedAt: 1,
    prompt: "確認して",
    toolCalls: [
      { id: "work-1", assistantId: "run-1:1", name: "bash", args: "", isError: false, done: true, output: "ok" },
      { id: "work-2", assistantId: "run-1:2", name: "bash", args: "", isError: false, done: true, output: "ok" },
    ],
    totalRetryCount: 0,
  };
  payload.messages = [
    { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
    {
      role: "assistant",
      text: "A",
      assistantId: "run-1:1",
      tools: [
        { id: "work-1", assistantId: "run-1:1", name: "bash", args: "", isError: false, done: true, output: "ok" },
      ],
    },
  ];
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        {
          kind: "message",
          id: "u-1",
          context: "active",
          role: "user",
          text: "確認して",
          sendId: "send-1",
          runId: "run-1",
        },
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "A", assistantId: "run-1:1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 2,
      summarizedMessageCount: 0,
    },
  });
  state = chatReducer(state, { type: "text", delta: "B", at: 5, assistantId: "run-1:3" });
  assert.deepEqual(
    assistantCards(state),
    [
      ["A", "run-1:1", ["work-1"]],
      ["B", "run-1:3", ["work-2"]],
    ],
    "再接続後も work-2 は次の表示可能な本文 item (履歴の繰り上げ先) に付く",
  );
});

test("本文を持たない ask_user の回答カードは所有者IDを保ったまま再接続で復元する", () => {
  // What: 質問待ちの再接続で payload.run.toolCalls から復元しても、回答カードが 1 件残る
  const questions = [{ question: "進めますか" }];
  const call: ToolCall = {
    id: "q1",
    assistantId: "run-1:1",
    name: "ask_user",
    args: "",
    isError: false,
    done: false,
    output: "",
    questions,
  };
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "聞いて",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "q1",
    name: "ask_user",
    args: "",
    at: 2,
    assistantId: "run-1:1",
    questions,
  });
  assert.equal(askUserCardOwners(state, "q1").length, 1, "ライブでは回答カードが 1 枚");
  assert.equal(askUserCardOwners(state, "q1")[0]?.bubble.assistantId, "run-1:1");

  const payload = streamingPayload();
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "running",
    startedAt: 1,
    prompt: "聞いて",
    toolCalls: [call],
    totalRetryCount: 0,
  };
  payload.messages = [{ role: "user", text: "聞いて", sendId: "send-1", runId: "run-1" }];
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "聞いて", sendId: "send-1", runId: "run-1" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 1,
    summarizedMessageCount: 0,
  };

  // 履歴なしの再接続
  let withoutHistory = chatReducer(state, { type: "resync", payload });
  assert.equal(askUserCardOwners(withoutHistory, "q1").length, 1, "履歴なしの再接続でも回答カードを保つ");
  assert.equal(askUserCardOwners(withoutHistory, "q1")[0]?.bubble.assistantId, "run-1:1", "所有者IDを保つ");

  // 履歴ありの再接続 (履歴取得 → resync)
  let withHistory = chatReducer(state, { type: "resyncHistory", page });
  assert.equal(askUserCardOwners(withHistory, "q1").length, 1, "履歴取得でも回答カードを保つ");
  withHistory = chatReducer(withHistory, { type: "resync", payload });
  assert.equal(askUserCardOwners(withHistory, "q1").length, 1, "履歴ありの再接続でも回答カードを保つ");
  assert.equal(askUserCardOwners(withHistory, "q1")[0]?.bubble.assistantId, "run-1:1", "所有者IDを保つ");
  assert.equal(askUserCardOwners(withoutHistory, "q1")[0]?.bubble.tools.length, 1);

  // 先の応答を assistant_end で閉じた後でも、質問カードは自分のIDを持つカードへ付く
  let afterClosed = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "確認して",
    at: 1,
    startedAt: 1,
  });
  afterClosed = chatReducer(afterClosed, { type: "text", delta: "A", at: 2, assistantId: "run-1:1" });
  afterClosed = chatReducer(afterClosed, { type: "assistantEnd", assistantId: "run-1:1" });
  afterClosed = chatReducer(afterClosed, {
    type: "toolStart",
    id: "q2",
    name: "ask_user",
    args: "",
    at: 3,
    assistantId: "run-1:2",
    questions,
  });
  const closedOwners = askUserCardOwners(afterClosed, "q2");
  assert.equal(closedOwners.length, 1, "閉じた応答へ質問カードを縮退させない");
  assert.equal(closedOwners[0]?.bubble.assistantId, "run-1:2", "質問カードは自分の応答のIDを持つ");
});

test("ID の無い旧回答に、本文のない新ランの結末を付けない", () => {
  // What: 応答IDの注記が無い旧データへ、別ランの Stopped と所要時間を移さない
  const oldItems: HistoryPage["items"] = [
    {
      kind: "message",
      id: "u-old",
      context: "active",
      role: "user",
      text: "前の質問",
      sendId: "send-old",
      runId: "run-old",
    },
    { kind: "message", id: "a-old", context: "active", role: "assistant", text: "旧回答" },
  ];
  const oldPage: HistoryPage = {
    sessionId: "session-a",
    items: oldItems,
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-old",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const restart = runningPayload();
  restart.status = "idle";
  restart.run = null;
  restart.messages = [
    { role: "user", text: "前の質問", sendId: "send-old", runId: "run-old" },
    // 旧形式: assistant の応答ID注記が無い
    { role: "assistant", text: "旧回答" },
  ];
  let state = chatReducer(initialChatState, { type: "resync", payload: restart });
  state = chatReducer(state, { type: "resyncHistory", page: oldPage });

  // 本文を持たないツールだけの応答を実行し、run_end を取りこぼした
  const tool: ToolCall = {
    id: "work-new",
    assistantId: "run-2:1",
    name: "bash",
    args: "",
    isError: false,
    done: true,
    output: "ok",
  };
  state = chatReducer(state, { type: "localUser", text: "別の質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "別の質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-new",
    name: "bash",
    args: "",
    at: 11,
    assistantId: "run-2:1",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-new", isError: false, output: "ok" });

  const stopped = runningPayload();
  stopped.status = "stopped";
  stopped.run = {
    id: "run-2",
    initialSendId: "send-2",
    status: "stopped",
    startedAt: 10,
    endedAt: 15,
    prompt: "別の質問",
    toolCalls: [tool],
    totalRetryCount: 0,
  };
  stopped.messages = [
    { role: "user", text: "前の質問", sendId: "send-old", runId: "run-old" },
    { role: "assistant", text: "旧回答" },
    { role: "user", text: "別の質問", sendId: "send-2", runId: "run-2" },
  ];
  state = chatReducer(state, { type: "resync", payload: stopped });
  const afterResync = state;
  // 履歴取得は旧回答を保持したまま新しい user だけを足す (旧回答のバブルは置き換えない)
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        {
          kind: "message",
          id: "u-2",
          context: "active",
          role: "user",
          text: "別の質問",
          sendId: "send-2",
          runId: "run-2",
        },
      ],
      prevCursor: "a-old",
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-old",
      messageCount: 3,
      summarizedMessageCount: 0,
    },
  });

  assert.equal(
    afterResync.bubbles.find((bubble) => bubble.text === "旧回答")?.turnEnd,
    undefined,
    "終端 resync で旧回答に新ランの結末を付けない",
  );
  const oldAnswer = state.bubbles.find((bubble) => bubble.text === "旧回答");
  assert.equal(oldAnswer?.turnEnd, undefined, "履歴取得後も旧回答に新ランの結末を持たせない");
  assert.equal(oldAnswer?.entryId, "a-old");
  const rendered = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    rendered.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [],
    "Stopped と所要時間をどこにも出さない",
  );
});

test("ID 注記のない旧データでも、同文の 2 応答へツールを 1:1 で戻す", () => {
  // What: assistant の注記だけが無い JSONL を読み直しても、履歴取得で work-1 が 2 件目へ複製されない
  const work = (id: string): ToolCall => ({
    id,
    name: "bash",
    args: "",
    isError: false,
    done: true,
    output: "ok",
  });
  const restart = runningPayload();
  restart.status = "completed";
  restart.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "completed",
    startedAt: 1,
    endedAt: 9,
    prompt: "確認して",
    toolCalls: [],
    totalRetryCount: 0,
  };
  restart.messages = [
    { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
    // 旧形式: assistant の応答ID注記が無く、本文は同じ
    { role: "assistant", text: "確認します", tools: [work("work-1")] },
    { role: "assistant", text: "確認します", tools: [work("work-2")] },
  ];
  let state = chatReducer(initialChatState, { type: "resync", payload: restart });
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        {
          kind: "message",
          id: "u-1",
          context: "active",
          role: "user",
          text: "確認して",
          sendId: "send-1",
          runId: "run-1",
        },
        {
          kind: "message",
          id: "a-1",
          context: "active",
          role: "assistant",
          text: "確認します",
          tools: [work("work-1")],
        },
        {
          kind: "message",
          id: "a-2",
          context: "active",
          role: "assistant",
          text: "確認します",
          tools: [work("work-2")],
        },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 3,
      summarizedMessageCount: 0,
    },
  });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.entryId, bubble.tools.map((card) => card.id)]),
    [
      ["確認します", "a-1", ["work-1"]],
      ["確認します", "a-2", ["work-2"]],
    ],
    "同じ履歴応答を 2 つの live 応答へ使い回さない",
  );
});

test("本文なし応答の再接続カードと繰り上げ投影で同じツールを 2 回出さない", () => {
  // What: 合成した所有者カードと、完了ツールを次の本文へ繰り上げた投影が重なっても call は 1 枚だけ
  const scenario = (name: "bash" | "ask_user", withHistory: boolean): ChatState => {
    const label = `${name}/${withHistory ? "履歴あり" : "履歴なし"}`;
    let state = chatReducer(initialChatState, {
      type: "runStart",
      runId: "run-1",
      initialSendId: "send-1",
      prompt: "確認して",
      at: 1,
      startedAt: 1,
    });
    state = chatReducer(state, { type: "text", delta: "A", at: 2, assistantId: "run-1:1" });
    state = chatReducer(state, {
      type: "toolStart",
      id: "work-1",
      name: "bash",
      args: "",
      at: 3,
      assistantId: "run-1:1",
    });
    state = chatReducer(state, { type: "toolEnd", id: "work-1", isError: false, output: "ok" });
    state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
    // 本文を持たない 2 応答目のツール
    const running2 = bodylessTool(name, false);
    state = chatReducer(state, {
      type: "toolStart",
      id: running2.id,
      name,
      args: "",
      at: 4,
      assistantId: "run-1:2",
      ...(running2.questions === undefined ? {} : { questions: running2.questions }),
    });
    const page: HistoryPage = {
      sessionId: "session-a",
      items: [
        {
          kind: "message",
          id: "u-1",
          context: "active",
          role: "user",
          text: "確認して",
          sendId: "send-1",
          runId: "run-1",
        },
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "A", assistantId: "run-1:1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 2,
      summarizedMessageCount: 0,
    };
    if (withHistory) state = chatReducer(state, { type: "resyncHistory", page });

    // work-2 の実行中に再接続する (所有者のカードを合成して救済する)
    const reconnect = streamingPayload();
    reconnect.run = {
      id: "run-1",
      initialSendId: "send-1",
      status: "running",
      startedAt: 1,
      prompt: "確認して",
      toolCalls: [
        { id: "work-1", assistantId: "run-1:1", name: "bash", args: "", isError: false, done: true, output: "ok" },
        running2,
      ],
      totalRetryCount: 0,
    };
    reconnect.messages = [
      { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
      { role: "assistant", text: "A", assistantId: "run-1:1" },
    ];
    state = chatReducer(state, { type: "resync", payload: reconnect });
    assert.equal(
      state.bubbles.filter((bubble) => bubble.tools.some((card) => card.id === "work-2")).length,
      1,
      `${label}: 再接続中もカードは 1 枚`,
    );

    // 完了 → 本文 B。完了したツールは次の表示本文 (B) へ繰り上げて投影される
    state = chatReducer(state, {
      type: "toolEnd",
      id: "work-2",
      isError: false,
      output: "ok",
      ...(name === "ask_user" ? { answers: [{ index: 0, text: "はい" }] } : {}),
    });
    state = chatReducer(state, { type: "text", delta: "B", at: 6, assistantId: "run-1:3" });
    state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:3" });

    const carried = bodylessTool(name, true);
    const completed = runningPayload();
    completed.status = "completed";
    completed.run = {
      id: "run-1",
      initialSendId: "send-1",
      status: "completed",
      startedAt: 1,
      endedAt: 9,
      prompt: "確認して",
      toolCalls: [
        { id: "work-1", assistantId: "run-1:1", name: "bash", args: "", isError: false, done: true, output: "ok" },
        carried,
      ],
      totalRetryCount: 0,
    };
    completed.messages = [
      { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
      {
        role: "assistant",
        text: "A",
        assistantId: "run-1:1",
        tools: [
          { id: "work-1", assistantId: "run-1:1", name: "bash", args: "", isError: false, done: true, output: "ok" },
        ],
      },
      { role: "assistant", text: "B", assistantId: "run-1:3", tools: [carried] },
    ];
    state = chatReducer(state, { type: "resync", payload: completed });
    state = chatReducer(state, {
      type: "resyncHistory",
      page: {
        ...page,
        items: [
          ...page.items,
          {
            kind: "message",
            id: "a-2",
            context: "active",
            role: "assistant",
            text: "B",
            assistantId: "run-1:3",
            tools: [carried],
          },
        ],
        messageCount: 3,
      },
    });
    return state;
  };

  for (const name of ["bash", "ask_user"] as const) {
    for (const withHistory of [false, true]) {
      const label = `${name}/${withHistory ? "履歴あり" : "履歴なし"}`;
      const state = scenario(name, withHistory);
      const owners = state.bubbles.filter((bubble) => bubble.tools.some((card) => card.id === "work-2"));
      assert.equal(owners.length, 1, `${label}: 同じ call を 2 枚に出さない`);
      assert.equal(owners[0]?.text, "B", `${label}: 繰り上げ投影の本文にだけ残る`);
      assert.deepEqual(
        state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
        ["A", "B"],
        `${label}: ツールを失った空の合成カードを残さない`,
      );
    }
  }
});

test("停止した本文なし応答のツールカードは、次の run と再読み込みの後も 1 か所に残る", () => {
  // What: 停止直後に見える停止ツールのカードが、次の run の終端 resync / 履歴取得 / 再読み込みで
  // 消えず、所有者も枚数も live・履歴・再読み込みで一致する
  const stoppedTool: ToolCall = {
    id: "work-stop",
    assistantId: "run-1:1",
    name: "bash",
    args: "$ sleep 120",
    isError: true,
    done: true,
    output: "This operation was aborted",
    startedAt: 11,
    endedAt: 20,
  };
  const oldPage: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "a-old-u", context: "active", role: "user", text: "前の質問" },
      { kind: "message", id: "a-old-a", context: "active", role: "assistant", text: "旧回答" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-old-u",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  // 停止した run の user だけが履歴に載っている (本文の無い応答は、まだ結果も無いので item にならない)
  const stoppedPage: HistoryPage = {
    ...oldPage,
    items: [
      ...oldPage.items,
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "停止用",
        sendId: "send-1",
        runId: "run-1",
      },
    ],
    prevCursor: "a-old-a",
    messageCount: 3,
  };
  const idle = (messages: SessionPayload["messages"]): SessionPayload => ({
    ...runningPayload(),
    status: "idle",
    run: null,
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    messages,
  });
  const cardsOf = (state: ChatState): [number, string][] =>
    state.bubbles.flatMap((bubble) => bubble.tools.map((card): [number, string] => [bubble.id, card.id]));
  const ownersOfStop = (state: ChatState): number[] =>
    state.bubbles.filter((bubble) => bubble.tools.some((card) => card.id === "work-stop")).map((bubble) => bubble.id);

  let state = chatReducer(initialChatState, {
    type: "resync",
    payload: idle([
      { role: "user", text: "前の質問" },
      { role: "assistant", text: "旧回答" },
    ]),
  });
  state = chatReducer(state, { type: "resyncHistory", page: oldPage });

  // 本文なし応答のツールを実行し、run_end を取りこぼしたまま停止する
  state = chatReducer(state, { type: "localUser", text: "停止用", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "停止用",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-stop",
    name: "bash",
    args: "$ sleep 120",
    at: 11,
    assistantId: "run-1:1",
  });
  const stopped = chatReducer(state, {
    type: "resync",
    payload: {
      ...idle([
        { role: "user", text: "前の質問" },
        { role: "assistant", text: "旧回答" },
        { role: "user", text: "停止用", sendId: "send-1", runId: "run-1" },
      ]),
      status: "stopped",
      run: {
        id: "run-1",
        initialSendId: "send-1",
        status: "stopped",
        startedAt: 10,
        endedAt: 20,
        prompt: "停止用",
        toolCalls: [stoppedTool],
        totalRetryCount: 0,
      },
    },
  });
  state = chatReducer(stopped, { type: "resyncHistory", page: stoppedPage });
  assert.deepEqual(ownersOfStop(state), [state.bubbles.at(-1)?.id], "停止直後は本文なし応答のカードとして 1 枚見える");

  // 中止の toolResult が履歴に載った後の終端 resync。合成カードは同じ応答の item に統合する
  const withTailItem: HistoryPage = {
    ...stoppedPage,
    items: [
      ...stoppedPage.items,
      {
        kind: "message",
        id: "a-a1",
        context: "active",
        role: "assistant",
        text: "",
        assistantId: "run-1:1",
        tools: [stoppedTool],
      },
    ],
    messageCount: 4,
  };
  state = chatReducer(state, { type: "resyncHistory", page: withTailItem });
  assert.deepEqual(ownersOfStop(state).length, 1, "合成カードと履歴 item を 2 枚にしない");
  assert.equal(
    state.bubbles.find((bubble) => bubble.id === ownersOfStop(state)[0])?.entryId,
    "a-a1",
    "履歴 item を所有者にする",
  );

  // 同じ会話で次の run を完了する
  state = chatReducer(state, { type: "localUser", text: "次の質問", at: 30 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "次の質問",
    at: 30,
    startedAt: 30,
  });
  state = chatReducer(state, { type: "text", delta: "B", at: 31, assistantId: "run-2:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-2:1" });
  const messages: SessionPayload["messages"] = [
    { role: "user", text: "前の質問" },
    { role: "assistant", text: "旧回答" },
    { role: "user", text: "停止用", sendId: "send-1", runId: "run-1" },
    { role: "user", text: "次の質問", sendId: "send-2", runId: "run-2" },
    { role: "assistant", text: "B", assistantId: "run-2:1" },
  ];
  state = chatReducer(state, {
    type: "resync",
    payload: {
      ...idle(messages),
      run: {
        id: "run-2",
        initialSendId: "send-2",
        status: "completed",
        startedAt: 30,
        endedAt: 33,
        prompt: "次の質問",
        toolCalls: [],
        totalRetryCount: 0,
      },
    },
  });
  // 修正後のサーバーの履歴: 停止したツールは自分のターンの item (本文なし) に載り、次の応答へは移らない
  const nextPage: HistoryPage = {
    ...oldPage,
    items: [
      ...oldPage.items,
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "停止用",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-a1",
        context: "active",
        role: "assistant",
        text: "",
        assistantId: "run-1:1",
        tools: [stoppedTool],
      },
      {
        kind: "message",
        id: "a-u2",
        context: "active",
        role: "user",
        text: "次の質問",
        sendId: "send-2",
        runId: "run-2",
      },
      {
        kind: "message",
        id: "a-b",
        context: "active",
        role: "assistant",
        text: "B",
        assistantId: "run-2:1",
        turnEnd: { outcome: "completed", durationMs: 3000 },
      },
    ],
    prevCursor: "a-old-a",
    messageCount: 7,
  };
  state = chatReducer(state, { type: "resyncHistory", page: nextPage });

  const assertAfterNextRun = (current: ChatState, label: string): void => {
    assert.deepEqual(
      cardsOf(current).filter(([, id]) => id === "work-stop"),
      [[ownersOfStop(current)[0] ?? -1, "work-stop"]],
      `${label}: 停止したツールは 1 枚だけ`,
    );
    assert.equal(ownersOfStop(current).length, 1, `${label}: 1 か所にだけ残る`);
    const owner = current.bubbles.find((bubble) => bubble.id === ownersOfStop(current)[0]);
    assert.equal(owner?.entryId, "a-a1", `${label}: 停止した応答の item が持ち主`);
    assert.equal(owner?.text, "", `${label}: 本文は捏造しない`);
    const answer = current.bubbles.find((bubble) => bubble.entryId === "a-b");
    assert.deepEqual(answer?.tools, [], `${label}: 次のターンの本文へ移さない`);
    const rendered = chatRenderItems({
      bubbles: current.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).flatMap((item) => (item.kind === "message" ? item.bubble.tools.map((card) => card.id) : []));
    assert.deepEqual(rendered, ["work-stop"], `${label}: 表示も 1 枚`);
  };
  assertAfterNextRun(state, "次の run の終端 resync と履歴取得の後");

  // 再読み込み: 履歴だけから組み直す
  let reloaded = chatReducer(initialChatState, { type: "resync", payload: idle(messages) });
  reloaded = chatReducer(reloaded, { type: "resyncHistory", page: nextPage });
  assertAfterNextRun(reloaded, "再読み込みの後");
  const ownerEntry = (current: ChatState): string | undefined =>
    current.bubbles.find((bubble) => bubble.id === ownersOfStop(current)[0])?.entryId;
  assert.deepEqual(ownerEntry(state), ownerEntry(reloaded), "live と再読み込みで所有者が一致する");
});

test("同じターンの本文なしツール応答が複数でも、所有者ごとにカードを 1 枚ずつ残す", () => {
  // What: 停止したターンに本文なし応答 A → B が続くとき、live は 1 枚の host に溜め、履歴取得後は
  // 履歴の item が所有者になり、次の run の終端 resync・再読み込みの後も 1 枚ずつ残る (重複も欠落もしない)
  const toolOf = (id: string, assistantId: string, output: string, isError: boolean): ToolCall => ({
    id,
    assistantId,
    name: "bash",
    args: "$ pwd",
    isError,
    done: true,
    output,
    startedAt: 11,
    endedAt: 12,
  });
  const workA = toolOf("work-a", "run-1:1", "ok", false);
  const workB = toolOf("work-b", "run-1:2", "This operation was aborted", true);
  const oldPage: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "a-old-u", context: "active", role: "user", text: "前の質問" },
      { kind: "message", id: "a-old-a", context: "active", role: "assistant", text: "旧回答" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-old-u",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const stoppedPage: HistoryPage = {
    ...oldPage,
    items: [
      ...oldPage.items,
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "停止用",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-a1",
        context: "active",
        role: "assistant",
        text: "",
        assistantId: "run-1:1",
        tools: [workA],
      },
      {
        kind: "message",
        id: "a-a2",
        context: "active",
        role: "assistant",
        text: "",
        assistantId: "run-1:2",
        tools: [workB],
      },
    ],
    prevCursor: "a-old-a",
    messageCount: 5,
  };
  const messages: SessionPayload["messages"] = [
    { role: "user", text: "前の質問" },
    { role: "assistant", text: "旧回答" },
    { role: "user", text: "停止用", sendId: "send-1", runId: "run-1" },
    { role: "user", text: "次の質問", sendId: "send-2", runId: "run-2" },
    { role: "assistant", text: "B", assistantId: "run-2:1" },
  ];
  const idle = (payloadMessages: SessionPayload["messages"]): SessionPayload => ({
    ...runningPayload(),
    status: "idle",
    run: null,
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    messages: payloadMessages,
  });
  /** カード id -> [所有者の応答ID, 所属 item の entryId] (所有者はカードを持たないバブル側の値) */
  const ownersOf = (state: ChatState): [string, string | undefined, string | undefined][] =>
    state.bubbles.flatMap((bubble) =>
      bubble.tools.map((card): [string, string | undefined, string | undefined] => [
        card.id,
        bubble.assistantId,
        bubble.entryId,
      ]),
    );

  let state = chatReducer(initialChatState, {
    type: "resync",
    payload: idle([
      { role: "user", text: "前の質問" },
      { role: "assistant", text: "旧回答" },
    ]),
  });
  state = chatReducer(state, { type: "resyncHistory", page: oldPage });

  // 本文なし応答 A → B のツールを実行し、run_end を取りこぼしたまま停止する
  state = chatReducer(state, { type: "localUser", text: "停止用", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "停止用",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-a",
    name: "bash",
    args: "$ pwd",
    at: 11,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-a", isError: false, output: "ok" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-b",
    name: "bash",
    args: "$ sleep 120",
    at: 12,
    assistantId: "run-1:2",
  });
  const live = chatReducer(state, {
    type: "resync",
    payload: {
      ...idle([
        { role: "user", text: "前の質問" },
        { role: "assistant", text: "旧回答" },
        { role: "user", text: "停止用", sendId: "send-1", runId: "run-1" },
      ]),
      status: "stopped",
      run: {
        id: "run-1",
        initialSendId: "send-1",
        status: "stopped",
        startedAt: 10,
        endedAt: 20,
        prompt: "停止用",
        toolCalls: [workA, workB],
        totalRetryCount: 0,
      },
    },
  });
  const liveOwners = ownersOf(live).map(([id, owner]) => [id, owner]);
  assert.deepEqual(
    liveOwners,
    [
      ["work-a", "run-1:1"],
      ["work-b", "run-1:2"],
    ],
    "本文 item が無いまま run が終わったターンは、確定履歴と同じく本文なし応答ごとの item に分かれる",
  );

  state = chatReducer(live, { type: "resyncHistory", page: stoppedPage });
  const liveAfterHistory = state;
  assert.deepEqual(
    ownersOf(state).map(([id, owner, entry]) => [id, owner, entry]),
    [
      ["work-a", "run-1:1", "a-a1"],
      ["work-b", "run-1:2", "a-a2"],
    ],
    "履歴取得で確定履歴の item が所有者になる (重複させない)",
  );

  // 同じ会話で次の run を完了する
  state = chatReducer(state, { type: "localUser", text: "次の質問", at: 30 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "次の質問",
    at: 30,
    startedAt: 30,
  });
  state = chatReducer(state, { type: "text", delta: "B", at: 31, assistantId: "run-2:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-2:1" });
  state = chatReducer(state, {
    type: "resync",
    payload: {
      ...idle(messages),
      run: {
        id: "run-2",
        initialSendId: "send-2",
        status: "completed",
        startedAt: 30,
        endedAt: 33,
        prompt: "次の質問",
        toolCalls: [],
        totalRetryCount: 0,
      },
    },
  });
  const nextPage: HistoryPage = {
    ...stoppedPage,
    items: [
      ...stoppedPage.items,
      {
        kind: "message",
        id: "a-u2",
        context: "active",
        role: "user",
        text: "次の質問",
        sendId: "send-2",
        runId: "run-2",
      },
      {
        kind: "message",
        id: "a-b",
        context: "active",
        role: "assistant",
        text: "B",
        assistantId: "run-2:1",
        turnEnd: { outcome: "completed", durationMs: 3000 },
      },
    ],
    messageCount: 7,
  };
  state = chatReducer(state, { type: "resyncHistory", page: nextPage });

  const expected = [
    ["work-a", "run-1:1", "a-a1"],
    ["work-b", "run-1:2", "a-a2"],
  ];
  const assertOwners = (current: ChatState, label: string): void => {
    assert.deepEqual(
      ownersOf(current).map(([id, owner, entry]) => [id, owner, entry]),
      expected,
      `${label}: 所有者ごとに 1 枚ずつ残る`,
    );
    const answer = current.bubbles.find((bubble) => bubble.entryId === "a-b");
    assert.deepEqual(answer?.tools, [], `${label}: 次のターンの本文へ移さない`);
    const rendered = chatRenderItems({
      bubbles: current.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).flatMap((item) =>
      item.kind === "message" ? item.bubble.tools.map((card) => [card.id, item.bubble.entryId]) : [],
    );
    assert.deepEqual(
      rendered,
      [
        ["work-a", "a-a1"],
        ["work-b", "a-a2"],
      ],
      `${label}: 表示も 1 枚ずつ`,
    );
  };
  assertOwners(state, "次の run の終端 resync と履歴取得の後");

  // 再読み込み: 履歴だけから組み直す
  let reloaded = chatReducer(initialChatState, { type: "resync", payload: idle(messages) });
  reloaded = chatReducer(reloaded, { type: "resyncHistory", page: nextPage });
  assertOwners(reloaded, "再読み込みの後");
  assert.deepEqual(
    ownersOf(reloaded).map(([id, owner]) => [id, owner]),
    ownersOf(liveAfterHistory).map(([id, owner]) => [id, owner]),
    "live (履歴取得後) と再読み込みで所有者が一致する",
  );
});

test("同じターンの後に本文 C が届くと、live も C のカードへ収束する", () => {
  // What: A(本文なし tool a) → B(本文なし tool b) → C(本文) のターンで、live のカードを再読み込みと
  // 同じ C へ寄せ、本文なしの空カードを残さず、各 toolCallId を 1 枚にする
  const call = (id: string, assistantId: string): ToolCall => ({
    id,
    assistantId,
    name: "bash",
    args: "$ pwd",
    isError: false,
    done: true,
    output: "ok",
    startedAt: 11,
    endedAt: 12,
  });
  const workA = call("work-a", "run-1:1");
  const workB = call("work-b", "run-1:2");
  const answerC = "answer-C";
  const payload: SessionPayload = {
    ...runningPayload(),
    status: "idle",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    run: null,
    messages: [
      { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
      // 履歴の投影は本文なし応答 A/B のツールを C へ繰り上げる
      { role: "assistant", text: answerC, assistantId: "run-1:3", tools: [workA, workB] },
    ],
  };
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "確認して",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-c",
        context: "active",
        role: "assistant",
        text: answerC,
        assistantId: "run-1:3",
        tools: [workA, workB],
        turnEnd: { outcome: "completed", durationMs: 4000 },
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  /** カード id -> 所有者の応答ID。重複も検出できるよう全件返す */
  const owners = (state: ChatState): [string, string | undefined][] =>
    state.bubbles.flatMap((bubble) =>
      bubble.tools.map((card): [string, string | undefined] => [card.id, bubble.assistantId]),
    );

  // live: イベントだけを適用する (履歴ページの適用なし)
  let live = chatReducer(initialChatState, {
    type: "resync",
    payload: { ...payload, status: "running", run: null, messages: [] },
  });
  live = chatReducer(live, { type: "localUser", text: "確認して", at: 10 });
  live = chatReducer(live, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: live.stateSeq });
  live = chatReducer(live, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "確認して",
    at: 10,
    startedAt: 10,
  });
  for (const [id, assistantId] of [
    ["work-a", "run-1:1"],
    ["work-b", "run-1:2"],
  ] as const) {
    live = chatReducer(live, { type: "toolStart", id, name: "bash", args: "$ pwd", at: 11, assistantId });
    live = chatReducer(live, { type: "toolEnd", id, isError: false, output: "ok" });
  }
  // 本文 C が届いて確定する。ここが live の最終状態 (終端 resync / 履歴取得より前)
  live = chatReducer(live, { type: "text", delta: answerC, at: 13, assistantId: "run-1:3" });
  live = chatReducer(live, { type: "assistantEnd", assistantId: "run-1:3" });

  assert.deepEqual(
    owners(live),
    [
      ["work-a", "run-1:3"],
      ["work-b", "run-1:3"],
    ],
    "live のカードは本文 C へ寄る",
  );
  assert.deepEqual(
    live.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => [bubble.text, bubble.tools.length]),
    [[answerC, 2]],
    "本文なしの空カードを残さない",
  );

  // 終端 resync を適用しても所有者は変わらない
  const settled = chatReducer(live, {
    type: "resync",
    payload: {
      ...payload,
      run: {
        id: "run-1",
        initialSendId: "send-1",
        status: "completed",
        startedAt: 10,
        endedAt: 14,
        prompt: "確認して",
        toolCalls: [workA, workB],
        totalRetryCount: 0,
      },
    },
  });
  assert.deepEqual(owners(settled), owners(live), "終端 resync で所有者が戻らない");

  // 再読み込み: payload + 履歴だけから組み直す
  const reloaded = chatReducer(chatReducer(initialChatState, { type: "resync", payload }), {
    type: "resyncHistory",
    page,
  });
  assert.deepEqual(owners(reloaded), owners(live), "live と再読み込みで所有者が一致する");
  assert.deepEqual(
    reloaded.bubbles.flatMap((bubble) => bubble.tools.map((card) => card.id)),
    ["work-a", "work-b"],
    "各 toolCallId は 1 枚",
  );
});

test("assistant_end を取りこぼしても、run_end で本文の応答へカードを寄せる", () => {
  // What: run_end だけが届く復帰でも、確定した本文の応答が本文なし応答のカードを引き取る
  let state = chatReducer(initialChatState, {
    type: "resync",
    payload: { ...runningPayload(), status: "running", run: null, messages: [] },
  });
  state = chatReducer(state, { type: "localUser", text: "確認して", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "確認して",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-a",
    name: "bash",
    args: "$ pwd",
    at: 11,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, { type: "toolEnd", id: "work-a", isError: false, output: "ok" });
  state = chatReducer(state, { type: "text", delta: "answer-C", at: 13, assistantId: "run-1:2" });

  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 3000 });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [["answer-C", ["work-a"]]],
    "run_end でも本文の応答がカードを持つ",
  );
});

test("本文なし ask_user の回答後に本文が続くと、live も回答カードの所有者を揃える", () => {
  // What: 本文なしの ask_user → 回答 → 本文 C のターンで、live と再読み込みの回答カードの所有者・
  // 件数が一致する
  const question = [{ question: "進めますか", options: [{ label: "はい" }, { label: "いいえ" }] }];
  const askCard: ToolCall = {
    id: "ask-1",
    assistantId: "run-1:1",
    name: "ask_user",
    args: "",
    isError: false,
    done: true,
    output: "",
    startedAt: 11,
    endedAt: 12,
    questions: question,
    answers: [{ index: 0, selected: ["はい"] }],
  };
  const answerC = "answer-C";
  const payload: SessionPayload = {
    ...runningPayload(),
    status: "idle",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    run: null,
    messages: [
      { role: "user", text: "聞いて", sendId: "send-1", runId: "run-1" },
      { role: "assistant", text: answerC, assistantId: "run-1:2", tools: [askCard] },
    ],
  };
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "聞いて",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-c",
        context: "active",
        role: "assistant",
        text: answerC,
        assistantId: "run-1:2",
        tools: [askCard],
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const cardsOf = (state: ChatState): [string, string | undefined][] =>
    state.bubbles.flatMap((bubble) =>
      bubble.tools.map((card): [string, string | undefined] => [card.id, bubble.assistantId]),
    );

  let live = chatReducer(initialChatState, {
    type: "resync",
    payload: { ...payload, status: "running", run: null, messages: [] },
  });
  live = chatReducer(live, { type: "localUser", text: "聞いて", at: 10 });
  live = chatReducer(live, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: live.stateSeq });
  live = chatReducer(live, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "聞いて",
    at: 10,
    startedAt: 10,
  });
  live = chatReducer(live, {
    type: "toolStart",
    id: "ask-1",
    name: "ask_user",
    args: "",
    at: 11,
    assistantId: "run-1:1",
    questions: question,
  });
  live = chatReducer(live, {
    type: "toolEnd",
    id: "ask-1",
    isError: false,
    output: "",
    answers: [{ index: 0, selected: ["はい"] }],
  });
  live = chatReducer(live, { type: "text", delta: answerC, at: 13, assistantId: "run-1:2" });
  live = chatReducer(live, { type: "assistantEnd", assistantId: "run-1:2" });
  const reloaded = chatReducer(chatReducer(initialChatState, { type: "resync", payload }), {
    type: "resyncHistory",
    page,
  });

  assert.deepEqual(cardsOf(live), [["ask-1", "run-1:2"]], "live の回答カードは本文 C へ寄る");
  assert.deepEqual(cardsOf(reloaded), cardsOf(live), "live と再読み込みで回答カードの所有者が一致する");
  assert.equal(live.bubbles.filter((bubble) => bubble.role === "assistant").length, 1, "回答待ちの空カードを残さない");
});

test("履歴が assistant_end を追い越しても、本文へ繰り上げたカードを重複させない", () => {
  // What: 本文 C の delta 受信後に C 保存済みの履歴応答を先に適用し、その後に assistant_end /
  // 終端 resync を適用しても、C のカードは a / b の 2 枚のままで live と再読み込みが一致する
  const call = (id: string, assistantId: string): ToolCall => ({
    id,
    assistantId,
    name: "bash",
    args: "$ pwd",
    isError: false,
    done: true,
    output: "ok",
    startedAt: 11,
    endedAt: 12,
  });
  const workA = call("work-a", "run-1:1");
  const workB = call("work-b", "run-1:2");
  const answerC = "answer-C";
  const payload: SessionPayload = {
    ...runningPayload(),
    status: "idle",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    run: null,
    messages: [
      { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
      { role: "assistant", text: answerC, assistantId: "run-1:3", tools: [workA, workB] },
    ],
  };
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "確認して",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-c",
        context: "active",
        role: "assistant",
        text: answerC,
        assistantId: "run-1:3",
        tools: [workA, workB],
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const owners = (state: ChatState): [string, string | undefined][] =>
    state.bubbles.flatMap((bubble) =>
      bubble.tools.map((card): [string, string | undefined] => [card.id, bubble.assistantId]),
    );
  const expected = [
    ["work-a", "run-1:3"],
    ["work-b", "run-1:3"],
  ];
  /** 本文 C の delta までを受信した live (履歴はまだ届いていない) */
  const streaming = (): ChatState => {
    let state = chatReducer(initialChatState, {
      type: "resync",
      payload: { ...payload, status: "running", run: null, messages: [] },
    });
    state = chatReducer(state, { type: "localUser", text: "確認して", at: 10 });
    state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
    state = chatReducer(state, {
      type: "runStart",
      runId: "run-1",
      initialSendId: "send-1",
      prompt: "確認して",
      at: 10,
      startedAt: 10,
    });
    for (const [id, assistantId] of [
      ["work-a", "run-1:1"],
      ["work-b", "run-1:2"],
    ] as const) {
      state = chatReducer(state, { type: "toolStart", id, name: "bash", args: "$ pwd", at: 11, assistantId });
      state = chatReducer(state, { type: "toolEnd", id, isError: false, output: "ok" });
    }
    return chatReducer(state, { type: "text", delta: answerC, at: 13, assistantId: "run-1:3" });
  };
  const terminal = (state: ChatState): ChatState =>
    chatReducer(state, {
      type: "resync",
      payload: {
        ...payload,
        run: {
          id: "run-1",
          initialSendId: "send-1",
          status: "completed",
          startedAt: 10,
          endedAt: 14,
          prompt: "確認して",
          toolCalls: [workA, workB],
          totalRetryCount: 0,
        },
      },
    });

  // 履歴が assistant_end を追い越す順序。履歴適用の時点で同じ C に 2 度載せない
  const mergedFirst = chatReducer(streaming(), { type: "resyncHistory", page });
  assert.deepEqual(owners(mergedFirst), expected, "履歴適用の時点で重複させない");
  const historyFirst = terminal(chatReducer(mergedFirst, { type: "assistantEnd", assistantId: "run-1:3" }));
  assert.deepEqual(owners(historyFirst), expected, "追い越しても a / b の 2 枚のまま");
  assert.deepEqual(
    historyFirst.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.length]),
    [[answerC, 2]],
    "空の合成カードを残さない",
  );

  // 逆順 (assistant_end → 履歴 → 終端 resync) でも同じ
  const endFirst = terminal(
    chatReducer(chatReducer(streaming(), { type: "assistantEnd", assistantId: "run-1:3" }), {
      type: "resyncHistory",
      page,
    }),
  );
  assert.deepEqual(owners(endFirst), expected, "履歴が後から届いても重複させない");

  // 再読み込みと一致する
  const reloaded = chatReducer(chatReducer(initialChatState, { type: "resync", payload }), {
    type: "resyncHistory",
    page,
  });
  assert.deepEqual(owners(historyFirst), owners(reloaded), "履歴が先でも live と再読み込みで一致する");
  assert.deepEqual(owners(endFirst), owners(reloaded), "履歴が後でも live と再読み込みで一致する");
});
