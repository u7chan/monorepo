// 履歴の同期 (新規チャット / 再同期 / 履歴ページの取り込み) の回帰テスト。
//
// セッションは最初の送信時に作られるため、エージェント切替や「新しい会話」は chat state を
// 初期値へ戻すだけになる。前の会話の実効モデル・バブル・実行状態が残らないこと、bubble id
// (nextId) をセッション跨ぎで再利用しないこと、resync が取得済みの履歴を保つことも固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState } from "../src/lib/chatState";
import { chatReducer } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import type { ChatState } from "../src/lib/chatState";
import type {
  CompactionInfo,
  ContextUsage,
  HistoryPage,
  MessageMetrics,
  SessionPayload,
  ToolCall,
  Usage,
} from "../src/types";

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

/** 履歴に at を持つ payload (リロード / resync 後はサーバーの値が正) */
function payloadWithTimes(): SessionPayload {
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "こんにちは", at: 1700000000000 },
    { role: "assistant", text: "はい", at: 1700000001000 },
  ];
  return payload;
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

const CONTEXT: ContextUsage = { tokens: 43_008, contextWindow: 128_000, percent: 33.6 };

function payloadWithUsage(): SessionPayload {
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "こんにちは", at: 1700000000000 },
    { role: "assistant", text: "はい", at: 1700000001000, usage: USAGE, metrics: METRICS },
  ];
  payload.context = CONTEXT;
  return payload;
}

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

/** 圧縮中の payload。開始時刻は payload の compactionStartedAt だけを正とする */
function compactingPayload(): SessionPayload {
  return {
    ...runningPayload(),
    status: "compacting",
    compactionStartedAt: 1700000005000,
    run: null,
  };
}

const RUN_ERROR_TEXT = "レート制限により実行に失敗しました（自動再試行4回）。時間をおいて再実行してください";

/** 最終失敗の run を持つ payload (run.errorCode は status === "error" のときだけ載る) */
function failedPayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    ...runningPayload(),
    status: "error",
    queueDepth: 0,
    run: {
      id: "run-1",
      status: "error",
      startedAt: 1700000000000,
      endedAt: 1700000001000,
      error: RUN_ERROR_TEXT,
      errorCode: "rate_limit",
      prompt: "聞いて",
      toolCalls: [],
      totalRetryCount: 4,
    },
    ...overrides,
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

/** 継続 resync の直後に取り直される最新ページ (assistant は任意で部分テキスト) */
function streamingHistoryPage(assistantText?: string): HistoryPage {
  const items: HistoryPage["items"] = [
    { kind: "message", id: "old", context: "active", role: "user", text: "old", runId: "run-old" },
    { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
  ];
  if (assistantText !== undefined) {
    items.push({ kind: "message", id: "a-1", context: "active", role: "assistant", text: assistantText });
  }
  return {
    sessionId: "session-a",
    items,
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "old",
    messageCount: items.length,
    summarizedMessageCount: 0,
  };
}

function renderedMessages(state: ChatState): string[] {
  return chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  })
    .filter((item) => item.kind === "message")
    .map((item) => `${item.bubble.role}:${item.bubble.text}`);
}

function firstTurnPayload(question: string, messages: SessionPayload["messages"]): SessionPayload {
  const payload = runningPayload();
  payload.status = "running";
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "running",
    startedAt: 1,
    prompt: question,
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = messages;
  payload.pendingSends = [{ sendId: "send-1", runId: "run-1", text: question, at: 1, state: "running" }];
  return payload;
}

test("新規チャットで会話状態が初期値へ戻り、実効 Model / Effort も消える", () => {
  const before = stateWithSession();
  assert.notEqual(before.bubbles.length, 0);
  assert.notEqual(before.sessionModel, undefined);

  const after = chatReducer(before, { type: "newChat" });

  assert.equal(after.bubbles.length, 0);
  assert.equal(after.currentAssistantId, null);
  assert.deepEqual(after.toolBubbleIds, {});
  assert.equal(after.runStatus, "idle");
  assert.equal(after.queueDepth, 0);
  assert.equal(after.activity, "");
  assert.equal(after.sessionModel, undefined);
  assert.equal(after.sessionThinkingLevel, undefined);
  assert.equal(after.supportsThinking, false);
  assert.deepEqual(after.availableThinkingLevels, []);
  assert.deepEqual(after.compactions, []);
});

test("新規チャット後も bubble id を再利用しない", () => {
  const used = stateWithSession();
  const nextIdBefore = used.nextId;
  assert.notEqual(nextIdBefore, initialChatState.nextId);

  const reset = chatReducer(used, { type: "newChat" });
  assert.equal(reset.nextId, nextIdBefore);

  const afterNextMessage = chatReducer(reset, { type: "localUser", text: "次の会話", at: 1700000000003 });
  assert.equal(afterNextMessage.bubbles[0]?.id, nextIdBefore);
});

// --- 送信の合図 (sendSeq) ---

test("resync は履歴の at をバブルへ写す", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: payloadWithTimes() });
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.at),
    [1700000000000, 1700000001000],
  );
});

test("at を持たない履歴のバブルは at が undefined になる", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.at),
    [undefined, undefined],
  );
});

test("resync は履歴 tools を ToolCard に変換し、toolBubbleIds を再構築する", () => {
  const ok: ToolCall = {
    id: "tool-ok",
    name: "bash",
    args: "$ ls",
    isError: false,
    done: true,
    output: "files",
  };
  const failed: ToolCall = {
    id: "tool-failed",
    name: "read",
    args: "missing.txt",
    isError: true,
    done: true,
    output: "not found",
  };
  const duplicate: ToolCall = { ...ok, args: "later duplicate" };
  const payload = runningPayload();
  payload.status = "completed";
  payload.messages = [
    { role: "user", text: "履歴を見て" },
    { role: "assistant", text: "確認しました", tools: [ok, failed] },
    { role: "assistant", text: "続き", tools: [duplicate] },
  ];

  const state = chatReducer(initialChatState, { type: "resync", payload });
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.tools.map((card) => [card.id, card.phase, card.args])),
    [
      [],
      [
        ["tool-ok", "done", "$ ls"],
        ["tool-failed", "failed", "missing.txt"],
      ],
      [],
    ],
  );
  assert.deepEqual(state.toolBubbleIds, { "tool-ok": 2, "tool-failed": 2 });
});

test("resync 後の run_start は履歴のバブルを重複させない", () => {
  const note = (path: string) => ["同じ本文", "", "<attached_files>", `- ./${path}`, "</attached_files>"].join("\n");
  const firstPrompt = note("uploads/a.png");
  const secondPrompt = note("uploads/b.png");

  // 送信中に resync が届き、履歴が 2 通とも注記込みで戻る (待ち行列は捨てられる)
  let state = chatReducer(initialChatState, { type: "localUser", text: "同じ本文", at: 100 });
  state = chatReducer(state, { type: "localUser", text: "同じ本文", at: 200 });
  state = chatReducer(state, {
    type: "resync",
    payload: {
      ...runningPayload(),
      messages: [
        { role: "user", text: firstPrompt },
        { role: "user", text: secondPrompt },
      ],
    },
  });
  assert.equal(state.bubbles.length, 2);
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.text),
    [firstPrompt, secondPrompt],
  );
  assert.deepEqual(state.pendingEchoIds, []);

  // run_start が順に届いても、全バブルの完全一致で既存分と分かる
  state = chatReducer(state, { type: "runStart", prompt: firstPrompt, at: 300, startedAt: 300 });
  assert.equal(state.bubbles.length, 2, "A の run_start で増やさない");
  state = chatReducer(state, { type: "runStart", prompt: secondPrompt, at: 400, startedAt: 400 });
  assert.equal(state.bubbles.length, 2, "B の run_start で増やさない");
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.text),
    [firstPrompt, secondPrompt],
    "各バブルが自分の注記を保つ",
  );
});

// --- 応答メタ情報 ---

test("resync は履歴の usage / metrics をバブルへ、context を state へ写す", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: payloadWithUsage() });

  assert.equal(state.bubbles[0]?.usage, undefined);
  assert.equal(state.bubbles[0]?.metrics, undefined);
  assert.deepEqual(state.bubbles[1]?.usage, USAGE);
  assert.deepEqual(state.bubbles[1]?.metrics, METRICS);
  assert.deepEqual(state.context, CONTEXT);
});

test("新規チャットで context も消える", () => {
  const used = chatReducer(initialChatState, { type: "resync", payload: payloadWithUsage() });
  const reset = chatReducer(used, { type: "newChat" });
  assert.equal(reset.context, undefined);
});

// --- compaction ---

test("resync は圧縮履歴を payload で置き換える", () => {
  const payload = { ...runningPayload(), compactions: [COMPACTION] };
  const state = chatReducer(initialChatState, { type: "resync", payload });
  assert.deepEqual(state.compactions, [COMPACTION]);

  // 圧縮の無い payload へ戻すと履歴も消える (サーバー DTO が正)
  const cleared = chatReducer(state, { type: "resync", payload: runningPayload() });
  assert.deepEqual(cleared.compactions, []);
});

test("新しい会話へ戻しても runEndSeq は戻らない", () => {
  const ended = chatReducer(stateWithSession(), { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(chatReducer(ended, { type: "newChat" }).runEndSeq, ended.runEndSeq);
});

// --- 実行中インジケータの経過時間 ---

test("resync は compacting の runStatus / 開始時刻 / 活動を payload から導出する", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });

  assert.equal(state.runStatus, "compacting");
  assert.equal(state.compactionStartedAt, 1700000005000);
  assert.equal(state.activity, "会話を整理中…");
  // 実行中の起点は使い回さない
  assert.equal(state.runStartedAt, undefined);
});

test("終端 resync で compacting と開始時刻が解除される", () => {
  const compacting = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });
  const completed = chatReducer(compacting, {
    type: "resync",
    payload: { ...runningPayload(), status: "completed" },
  });

  assert.equal(completed.runStatus, "completed");
  assert.equal(completed.compactionStartedAt, undefined, "compactionStartedAt は payload が持たないので残さない");
  assert.equal(completed.activity, "", "文言は後続の status が担う");
});

test("切断復帰 (reload) の resync でも compacting が揃う", () => {
  // reload 直後は GET /api/sessions/:id の payload だけで状態を作る
  const reloaded = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });
  assert.equal(reloaded.runStatus, "compacting");
  assert.equal(reloaded.compactionStartedAt, 1700000005000);

  // 別タブの操作は resync で届く (POST の応答は当てにしない)
  const ended = chatReducer(reloaded, { type: "resync", payload: { ...runningPayload(), status: "idle" } });
  assert.equal(ended.runStatus, "idle");
  assert.equal(ended.compactionStartedAt, undefined);
});

test("resync は payload.run.errorCode から失敗を復元し、status が error でなければ載せない", () => {
  const resynced = chatReducer(initialChatState, { type: "resync", payload: failedPayload() });
  assert.deepEqual(resynced.runError, { code: "rate_limit", text: RUN_ERROR_TEXT });
  assert.equal(resynced.activity, "");

  // キュー待ちの payload (run は失敗のまま、status は queued) ではカードを出さない
  const queued = chatReducer(initialChatState, { type: "resync", payload: failedPayload({ status: "queued" }) });
  assert.equal(queued.runError, undefined);
  assert.equal(queued.runStatus, "queued", "状態行は待機の案内のまま (既存の表示を変えない)");

  // コードが無い旧 payload は現行の文言のまま
  const legacy = chatReducer(initialChatState, {
    type: "resync",
    payload: failedPayload({
      run: {
        id: "run-1",
        status: "error",
        startedAt: 1,
        endedAt: 2,
        error: RUN_ERROR_TEXT,
        prompt: "x",
        toolCalls: [],
        totalRetryCount: 0,
      },
    }),
  });
  assert.equal(legacy.runError, undefined);
  assert.equal(legacy.activity, `エラー: ${RUN_ERROR_TEXT}`);
});

test("新しい会話のストリーミング中も、同じ実行の resync は応答を 1 カードに保つ", () => {
  // What: 追加入力の注入で resync が届いても、続く delta が同じ assistant へ入り live のカードが割れない
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "前半", at: 11 });
  const streaming = state.currentAssistantId;
  assert.notEqual(streaming, null);

  const payload = streamingPayload();
  payload.messages = [{ role: "user", text: "質問" }];
  state = chatReducer(state, { type: "resync", payload });
  assert.equal(state.currentAssistantId, streaming, "補完先を維持する");
  assert.equal(state.currentRunId, "run-1");

  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
    ["前半後半"],
    "同じバブルへ連結する",
  );
});

test("同じ実行の resync の後も Done は 1 枚になった最終応答へ付く", () => {
  // What: 継続の resync を挟んでも Done が分割されず、最後の本文あり応答の 1 か所だけに出る
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
  state = chatReducer(state, { type: "text", delta: "前半", at: 11 });
  const streaming = state.currentAssistantId;
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  assert.equal(state.currentAssistantId, streaming);
  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  state = chatReducer(state, {
    type: "runEnd",
    runId: "run-1",
    status: "completed",
    queueDepth: 0,
    durationMs: 5000,
  });
  assert.equal(state.currentRunId, undefined);

  const assistants = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((item) => (item.kind === "message" ? item.bubble.text : "")),
    ["前半後半"],
  );
  assert.deepEqual(assistants[0]?.kind === "message" ? assistants[0].turnEnd : undefined, {
    outcome: "completed",
    durationMs: 5000,
  });
});

test("失敗試行の取り消しを意図する resync だけが未確定の応答を捨てる", () => {
  // What: context_edit 由来の resync は従来どおり未確定バブルを捨て、次の応答を新しいカードで始める
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "失敗した試行", at: 11 });
  const payload = streamingPayload();
  payload.resyncReason = "attempt_discarded";
  state = chatReducer(state, { type: "resync", payload });
  assert.equal(state.currentAssistantId, null);
  assert.equal(
    state.bubbles.some((bubble) => bubble.text === "失敗した試行"),
    false,
    "取り消した試行の本文を残さない",
  );

  state = chatReducer(state, { type: "text", delta: "やり直し", at: 12 });
  assert.equal(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => bubble.text)
      .at(-1),
    "やり直し",
    "取り消した本文を持ち越さない",
  );
});

test("継続 resync の補完先は直後の履歴再取得でも失われない", () => {
  // What: resync と次の delta の間に resyncHistory が走っても、同じ assistant バブルへ本文を連結する
  let state = streamingTurn();
  const streaming = state.currentAssistantId;
  assert.notEqual(streaming, null);
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  assert.equal(state.currentAssistantId, streaming);
  state = chatReducer(state, { type: "resyncHistory", page: streamingHistoryPage() });
  assert.equal(state.currentAssistantId, streaming, "履歴再取得で補完先を落とさない");

  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
    ["前半後半"],
  );
});

test("履歴再取得を挟んだ継続 resync でも Done は最終 assistant に 1 回だけ", () => {
  // What: 継続 resync → 履歴再取得 → 後半 delta → run_end の後も、カードが割れず Done が 1 か所に出る
  let state = streamingTurn();
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  state = chatReducer(state, { type: "resyncHistory", page: streamingHistoryPage() });
  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  state = chatReducer(state, {
    type: "runEnd",
    runId: "run-1",
    status: "completed",
    queueDepth: 0,
    durationMs: 5000,
  });

  const items = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.bubble.role === "assistant");
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? item.bubble.text : "")),
    ["前半後半"],
  );
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? item.turnEnd : undefined)),
    [{ outcome: "completed", durationMs: 5000 }],
    "Done は最終 assistant に 1 回だけ付く",
  );
});

test("attempt_discarded は履歴再取得を挟んでも未確定バブルを捨てる", () => {
  // What: 失敗試行の取り消しでは、履歴再取得が後から届いても試行中の本文を復活させない
  let state = streamingTurn();
  const payload = streamingPayload();
  payload.resyncReason = "attempt_discarded";
  state = chatReducer(state, { type: "resync", payload });
  assert.equal(state.currentAssistantId, null);
  state = chatReducer(state, { type: "resyncHistory", page: streamingHistoryPage() });
  assert.equal(state.currentAssistantId, null);
  assert.equal(
    state.bubbles.some((bubble) => bubble.text === "前半"),
    false,
    "取り消した試行の本文を残さない",
  );

  state = chatReducer(state, { type: "text", delta: "やり直し", at: 12 });
  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => bubble.text)
      .at(-1),
    "やり直し",
    "次の応答は新しいカードで始める",
  );
});

test("履歴に同じ応答の部分テキストがあっても二重カードにしない", () => {
  // What: 保存済みの assistant item と streaming 中のバブルをライブ本文で 1 枚に寄せ、再取得でも巻き戻さない
  let state = streamingTurn();
  const streaming = state.currentAssistantId;
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  state = chatReducer(state, { type: "resyncHistory", page: streamingHistoryPage("前半") });
  assert.equal(state.currentAssistantId, streaming, "履歴 item のカードへ補完先を引き継ぐ");
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => [bubble.text, bubble.entryId]),
    [["前半", "a-1"]],
  );

  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
    ["前半後半"],
  );
  // 同じ最新ページをもう一度取り直しても、ライブで伸びた本文を履歴の部分テキストへ戻さない
  state = chatReducer(state, { type: "resyncHistory", page: streamingHistoryPage("前半") });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
    ["前半後半"],
  );
  assert.equal(state.currentAssistantId, streaming);
});

test("前ターンの assistant は今ターンの本文一致で上書き・移動しない", () => {
  // What: 履歴マージの照合を今ターンへ限定し、完全一致でも前ターンのカードを書き換えない
  const page = (): HistoryPage => ({
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-prev", context: "active", role: "user", text: "前の質問", runId: "run-old" },
      {
        kind: "message",
        id: "a-prev",
        context: "active",
        role: "assistant",
        text: "はい",
        turnEnd: { outcome: "completed", durationMs: 80 },
      },
      {
        kind: "message",
        id: "u-now",
        context: "active",
        role: "user",
        text: "今の質問",
        sendId: "send-1",
        runId: "run-1",
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-prev",
    messageCount: 3,
    summarizedMessageCount: 0,
  });

  for (const liveText of ["はい、別の応答です", "はい"]) {
    let state = chatReducer(initialChatState, { type: "resyncHistory", page: page() });
    state = chatReducer(state, {
      type: "runStart",
      runId: "run-1",
      initialSendId: "send-1",
      prompt: "今の質問",
      at: 10,
      startedAt: 10,
    });
    state = chatReducer(state, { type: "text", delta: liveText, at: 11 });
    state = chatReducer(state, { type: "resync", payload: streamingPayload() });
    state = chatReducer(state, { type: "resyncHistory", page: page() });

    const previous = state.bubbles.find((bubble) => bubble.entryId === "a-prev");
    assert.equal(previous?.text, "はい", `前ターンの本文を ${liveText} で上書きしない`);
    assert.deepEqual(previous?.turnEnd, { outcome: "completed", durationMs: 80 }, "前ターンの Done を引き継がない");
    const previousIndex = state.bubbles.findIndex((bubble) => bubble.entryId === "a-prev");
    const currentUserIndex = state.bubbles.findIndex((bubble) => bubble.sendId === "send-1");
    const live = state.bubbles.filter((bubble) => bubble.role === "assistant" && bubble.entryId === undefined);
    assert.deepEqual(
      live.map((bubble) => bubble.text),
      [liveText],
      "今ターンの応答は別カードとして残す",
    );
    assert.ok(previousIndex < currentUserIndex, "前ターンのカードを現在の質問より後ろへ動かさない");
    assert.ok(currentUserIndex < state.bubbles.findIndex((bubble) => bubble.id === live[0]?.id));
  }
});

test("assistant_end で閉じた失敗試行も attempt_discarded で捨てる", () => {
  // What: message_end 後に届く取り消しの resync でも、閉じた失敗試行のカードを残さない
  let state = streamingTurn();
  state = chatReducer(state, { type: "assistantEnd" });
  const payload = streamingPayload();
  payload.resyncReason = "attempt_discarded";
  state = chatReducer(state, { type: "resync", payload });

  assert.equal(state.currentAssistantId, null);
  assert.equal(
    state.bubbles.some((bubble) => bubble.text === "前半"),
    false,
    "閉じた失敗試行も取り消す",
  );
});

test("履歴ページ未取得の会話でも assistant_end のカードは継続 resync で落とさない", () => {
  // What: 最初の会話では payload.messages から組み直す経路でも、閉じた応答と次の応答が 2 カードで残る
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "前半", at: 11 });
  state = chatReducer(state, { type: "assistantEnd" });

  const payload = streamingPayload();
  payload.messages = [{ role: "user", text: "質問" }];
  state = chatReducer(state, { type: "resync", payload });
  assert.equal(
    state.bubbles.some((bubble) => bubble.role === "assistant" && bubble.text === "前半"),
    true,
    "閉じた応答を payload.messages の再構成で落とさない",
  );

  state = chatReducer(state, { type: "text", delta: "後半", at: 12 });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => bubble.text),
    ["前半", "後半"],
  );
});

test("取り消しの resync でも投影に残る完了済みの応答は消さない", () => {
  // What: 失敗試行の取り消しで、既に保存済みの同じ run の応答カードまで巻き込まない
  let state = streamingTurn();
  state = chatReducer(state, { type: "assistantEnd" });
  const payload = streamingPayload();
  payload.messages = [
    { role: "user", text: "質問" },
    { role: "assistant", text: "前半" },
  ];
  payload.resyncReason = "attempt_discarded";
  state = chatReducer(state, { type: "resync", payload });

  assert.equal(
    state.bubbles.some((bubble) => bubble.role === "assistant" && bubble.text === "前半"),
    true,
    "投影に残る応答は取り消さない",
  );
});

test("会話切替で前の会話の確定済み応答を持ち越さない", () => {
  // What: A の完了直後に空の B へ切り替えても A の回答が残らず、B の履歴取得でも復活しない
  const payloadA = runningPayload();
  payloadA.sessionId = "session-a";
  payloadA.status = "idle";
  payloadA.run = null;
  payloadA.messages = [];

  let state = chatReducer(initialChatState, { type: "resync", payload: payloadA });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-a",
    initialSendId: "send-a",
    prompt: "A の質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "A の回答", at: 11 });
  state = chatReducer(state, { type: "assistantEnd" });
  assert.equal(
    state.bubbles.some((bubble) => bubble.text === "A の回答"),
    true,
  );

  const payloadB = runningPayload();
  payloadB.sessionId = "session-b";
  payloadB.piSessionId = "pi-session-b";
  payloadB.status = "idle";
  payloadB.run = null;
  payloadB.messages = [];
  state = chatReducer(state, { type: "resync", payload: payloadB });
  assert.deepEqual(state.bubbles, [], "会話切替で A のライブ応答を残さない");

  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-b",
      items: [],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: null,
      messageCount: 0,
      summarizedMessageCount: 0,
    },
  });
  assert.deepEqual(state.bubbles, [], "後続の履歴取得でも A を復活させない");
});

test("最初のターンが速く完了しても live の user が先で Done が残る", () => {
  // What: 完了直後の resync / 履歴再取得で、最初の user と応答の順序・Done が巻き戻らない
  let state = chatReducer(initialChatState, { type: "localUser", text: "質問", at: 1 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "usage", usage: USAGE, metrics: METRICS, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 1234 });

  const payload = runningPayload();
  payload.status = "completed";
  payload.run = {
    id: "run-1",
    status: "completed",
    startedAt: 1,
    endedAt: 3,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [
    { role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
    { role: "assistant", text: "回答", assistantId: "run-1:1" },
  ];
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "回答", assistantId: "run-1:1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 2,
      summarizedMessageCount: 0,
    },
  });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
    "user が assistant より先に並ぶ",
  );
  const items = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [["回答", { outcome: "completed", durationMs: 1234 }]],
    "Done が応答に残る",
  );
});

test("再接続後の steering でも user と応答末尾を重複させない", () => {
  // What: 履歴の先頭部分と再接続後の末尾 delta を assistantId で 1 枚に寄せ、user も 1 件に保つ
  const page = (): HistoryPage => ({
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
      {
        kind: "message",
        id: "a-1",
        context: "active",
        role: "assistant",
        text: "前半",
        assistantId: "run-1:1",
      },
      { kind: "message", id: "u-2", context: "active", role: "user", text: "追記", sendId: "send-2", runId: "run-1" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 3,
    summarizedMessageCount: 0,
  });

  let state = chatReducer(initialChatState, { type: "resyncHistory", page: page() });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  // 再接続後は履歴に無い末尾だけが delta で届く
  state = chatReducer(state, { type: "text", delta: "後半", at: 2, assistantId: "run-1:1" });
  // 自動履歴再取得のページにも同じ応答が前の本文まで載っている
  const refreshed = page();
  refreshed.items = refreshed.items.map((item) =>
    item.kind === "message" && item.role === "assistant" ? { ...item, text: "前半後半" } : item,
  );
  state = chatReducer(state, { type: "resyncHistory", page: refreshed });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "text", delta: "追記を受け取って", at: 4, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 900 });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "前半後半"],
      ["user", "追記"],
      ["assistant", "追記を受け取って"],
    ],
    "user も応答も重複しない",
  );
  assert.equal(new Set(state.bubbles.map((bubble) => bubble.id)).size, state.bubbles.length);
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? item.bubble.text : "")),
    ["追記を受け取って"],
    "Done は最後の応答に残る",
  );
});

test("接続スナップショットは同じ assistantId の live 末尾を履歴側の 1 枚へ寄せる", () => {
  // What: 再接続時の payload.messages が先頭を含み、live が末尾だけでも 1 カード・正しい順序になる
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "末尾", at: 2, assistantId: "run-1:1" });
  const payload = streamingPayload();
  payload.messages = [
    { role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
    { role: "assistant", text: "前半末尾", assistantId: "run-1:1" },
  ];
  state = chatReducer(state, { type: "resync", payload });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text, bubble.assistantId]),
    [
      ["user", "質問", undefined],
      ["assistant", "前半末尾", "run-1:1"],
    ],
    "snapshot を正として重複を置き換える",
  );
  assert.equal(state.currentAssistantId, state.bubbles.at(-1)?.id);
});

test("run_end を取りこぼしても payload の終端から Done を復元する", () => {
  // What: 再接続 payload が run 終了を示すとき、最後の本文あり assistant に Done を戻す
  let state = chatReducer(initialChatState, { type: "localUser", text: "質問", at: 1 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  // run_end は受信していない

  const payload = runningPayload();
  payload.status = "completed";
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "completed",
    startedAt: 1,
    endedAt: 11,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [
    { role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
    { role: "assistant", text: "回答", assistantId: "run-1:1" },
  ];
  state = chatReducer(state, { type: "resync", payload });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
  );
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [["回答", { outcome: "completed", durationMs: 10 }]],
  );
});

test("接頭辞が同じでも別 assistantId の配信中応答を履歴 item へ吸収しない", () => {
  // What: ID が両方あるときは本文の先頭一致で entryId 付きの別応答へ寄せない
  let state = chatReducer(initialChatState, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "はい", assistantId: "run-1:1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 2,
      summarizedMessageCount: 0,
    },
  });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "はい、別の応答です", at: 2, assistantId: "run-1:2" });
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
      { kind: "message", id: "a-1", context: "active", role: "assistant", text: "はい", assistantId: "run-1:1" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  state = chatReducer(state, { type: "resyncHistory", page });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.assistantId, bubble.entryId]),
    [
      ["はい", "run-1:1", "a-1"],
      ["はい、別の応答です", "run-1:2", undefined],
    ],
  );
});

test("同じ質問の次ラン中に resync しても前ランの Done を移さない", () => {
  // What: user の逆順本文一致で、新ランの user / assistant に旧ランの結末をコピーしない
  let state = chatReducer(initialChatState, { type: "localUser", text: "同じ質問", at: 1 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "同じ質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "旧回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 1000 });

  state = chatReducer(state, { type: "localUser", text: "同じ質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "同じ質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "新回答", at: 11, assistantId: "run-2:1" });

  const payload = streamingPayload();
  payload.messages = [
    { role: "user", text: "同じ質問", sendId: "send-2", runId: "run-2" },
    { role: "assistant", text: "新回答", assistantId: "run-2:1" },
  ];
  payload.run = {
    id: "run-2",
    initialSendId: "send-2",
    status: "running",
    startedAt: 10,
    prompt: "同じ質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  state = chatReducer(state, { type: "resync", payload });

  const users = state.bubbles.filter((bubble) => bubble.role === "user");
  assert.deepEqual(
    users.map((bubble) => [bubble.text, bubble.sendId, bubble.runId, bubble.runDurationMs]),
    [
      ["同じ質問", "send-1", "run-1", 1000],
      ["同じ質問", "send-2", "run-2", undefined],
    ],
    "旧ランの結末は旧 user に残り、新 user へ移らない",
  );
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? item.bubble.text : "")),
    ["旧回答"],
    "Done は旧ランの応答に残る",
  );
});

test("新規会話の1通目は接続スナップショットで user → assistant に並ぶ", () => {
  // What: ローカルエコーが無いまま assistant が先に在っても、payload の user の後ろへ差し込む
  let state = chatReducer(initialChatState, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.role),
    ["assistant"],
    "user が未受信の状態を作る",
  );

  const payload = runningPayload();
  payload.status = "running";
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "running",
    startedAt: 1,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [{ role: "user", text: "質問", sendId: "send-1", runId: "run-1" }];
  state = chatReducer(state, { type: "resync", payload });
  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
    "payload の user の後ろへ live の assistant を差し込む",
  );

  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
      { kind: "message", id: "a-1", context: "active", role: "assistant", text: "回答", assistantId: "run-1:1" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  state = chatReducer(state, { type: "resyncHistory", page });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 1200 });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
    "履歴取得後も順序を保つ",
  );
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [["回答", { outcome: "completed", durationMs: 1200 }]],
    "Done は最後の応答に 1 回",
  );
});

test("新規会話の1通目は run_end が無くても payload の終端から Done を復元する", () => {
  // What: 終端 resync が payload に未保存の現在応答を残し、Done をその応答へ付ける
  let state = chatReducer(initialChatState, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });

  const payload = runningPayload();
  payload.status = "completed";
  payload.run = {
    id: "run-1",
    initialSendId: "send-1",
    status: "completed",
    startedAt: 1,
    endedAt: 11,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [{ role: "user", text: "質問", sendId: "send-1", runId: "run-1" }];
  state = chatReducer(state, { type: "resync", payload });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
  );
  assert.equal(state.currentAssistantId, null, "終端では本文の補完先を閉じる");
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [["回答", { outcome: "completed", durationMs: 10 }]],
  );
});

test("未確定の assistant と user エコーは payload の列の対応位置へ差し込む", () => {
  // What: 履歴に未保存の次ターンでも、payload の末尾へ単純 append せず user → assistant の順を保つ
  const initial = runningPayload();
  initial.status = "idle";
  initial.run = null;
  initial.messages = [
    { role: "user", text: "前の質問" },
    { role: "assistant", text: "前の回答" },
  ];
  let state = chatReducer(initialChatState, { type: "resync", payload: initial });

  state = chatReducer(state, { type: "localUser", text: "追記", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "追記",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "次の回答", at: 11, assistantId: "run-2:1" });

  const payload = runningPayload();
  payload.run = {
    id: "run-2",
    initialSendId: "send-2",
    status: "running",
    startedAt: 10,
    prompt: "追記",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [
    { role: "user", text: "前の質問" },
    { role: "assistant", text: "前の回答" },
  ];
  state = chatReducer(state, { type: "resync", payload });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "前の質問"],
      ["assistant", "前の回答"],
      ["user", "追記"],
      ["assistant", "次の回答"],
    ],
    "live のみの user / assistant を末尾へ単純 append しない",
  );
});

test("再接続で live 本文が履歴より短くても長い履歴本文を保つ", () => {
  // What: 同じ assistantId の再接続 live が末尾だけでも、履歴 item の完全な本文で上書きする
  const long = "あ".repeat(120);
  const short = long.slice(48);
  const firstPage: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
      { kind: "message", id: "a-1", context: "active", role: "assistant", text: "前の回答", assistantId: "run-1:1" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  let state = chatReducer(initialChatState, { type: "resyncHistory", page: firstPage });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "localUser", text: "質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, { type: "text", delta: short, at: 11, assistantId: "run-2:1" });

  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "u-2",
        context: "active",
        role: "user",
        text: "質問",
        sendId: "send-2",
        runId: "run-2",
      },
      {
        kind: "message",
        id: "a-2",
        context: "active",
        role: "assistant",
        text: long,
        assistantId: "run-2:1",
      },
    ],
    prevCursor: "a-1",
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 4,
    summarizedMessageCount: 0,
  };
  state = chatReducer(state, { type: "resyncHistory", page });

  const assistant = state.bubbles.find((bubble) => bubble.assistantId === "run-2:1");
  assert.equal(assistant?.text, long, "短い live で履歴本文を上書きしない");
  assert.equal(
    state.bubbles.filter((bubble) => bubble.role === "assistant").length,
    2,
    "短い live を別カードとして残さない",
  );
});

test("履歴側に ID が無い旧データでも短い live 本文で上書きしない", () => {
  // What: 応答IDが片方だけの同一ターンは、一意な本文一致で長い履歴本文へ寄せる
  const long = "い".repeat(120);
  const short = long.slice(48);
  const firstPage: HistoryPage = {
    sessionId: "session-a",
    items: [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
      { kind: "message", id: "a-1", context: "active", role: "assistant", text: "前の回答" },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  let state = chatReducer(initialChatState, { type: "resyncHistory", page: firstPage });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "localUser", text: "質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-2", stateSeq: state.stateSeq });
  state = chatReducer(state, { type: "text", delta: short, at: 11, assistantId: "run-2:1" });

  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "u-2",
        context: "active",
        role: "user",
        text: "質問",
        sendId: "send-2",
        runId: "run-2",
      },
      { kind: "message", id: "a-2", context: "active", role: "assistant", text: long },
    ],
    prevCursor: "a-1",
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "u-1",
    messageCount: 4,
    summarizedMessageCount: 0,
  };
  state = chatReducer(state, { type: "resyncHistory", page });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((bubble) => bubble.text),
    ["前の回答", long],
    "短い live を別カードとして残さない",
  );
});

test("payload に user が無くても終端 run の Done を最後の応答へ付ける", () => {
  // What: Done の復元が user バブルの有無に依存しない
  let state = chatReducer(initialChatState, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  const payload = runningPayload();
  payload.status = "completed";
  payload.run = {
    id: "run-1",
    status: "completed",
    startedAt: 1,
    endedAt: 11,
    prompt: "質問",
    toolCalls: [],
    totalRetryCount: 0,
  };
  payload.messages = [];
  state = chatReducer(state, { type: "resync", payload });

  assert.deepEqual(
    state.bubbles.map((bubble) => bubble.role),
    ["assistant"],
    "user が無くても応答を残す",
  );
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    done.map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : [])),
    [["回答", { outcome: "completed", durationMs: 10 }]],
  );
});

test("新規会話の1通目: run_start → resync → text → run_end で user → assistant と Done", () => {
  // What: 実イベント順でも user が先に並び、Done が最後の応答に 1 回だけ付く
  const question = "はい前のターンです1。";
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: question,
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, {
    type: "resync",
    payload: firstTurnPayload(question, [{ role: "user", text: question, sendId: "send-1", runId: "run-1" }]),
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "usage", usage: USAGE, metrics: METRICS });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 500 });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", question],
      ["assistant", "回答"],
    ],
  );
  assert.deepEqual(renderedMessages(state), [`user:${question}`, "assistant:回答"]);
  const assistant = state.bubbles.find((bubble) => bubble.role === "assistant");
  assert.deepEqual(assistant?.turnEnd, { outcome: "completed", durationMs: 500 });
  const done = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.equal(done.length, 1, "Done は 1 回だけ");
  assert.equal(done[0]?.kind === "message" ? done[0].bubble.text : "", "回答");
});

test("新規会話の1通目: payload が assistant のみでも pending の user を応答の前に置く", () => {
  // What: 接続スナップショットの messages が assistant だけでも、pending の initial send を先頭へ戻す
  const question = "はい前のターンです1。";
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: question,
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, {
    type: "resync",
    payload: firstTurnPayload(question, [{ role: "assistant", text: "", assistantId: "run-1:1" }]),
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 500 });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", question],
      ["assistant", "回答"],
    ],
  );
  assert.deepEqual(renderedMessages(state), [`user:${question}`, "assistant:回答"]);
  const assistant = state.bubbles.find((bubble) => bubble.role === "assistant");
  assert.deepEqual(assistant?.turnEnd, { outcome: "completed", durationMs: 500 });
});

test("新規会話の1通目: run_end を落としても終端 payload から Done を復元する", () => {
  // What: run_end 未受信でも終端 resync の run から Done を最後の応答へ付ける
  const question = "はい前のターンです1。";
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: question,
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, {
    type: "resync",
    payload: firstTurnPayload(question, [{ role: "user", text: question, sendId: "send-1", runId: "run-1" }]),
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });

  const terminal = firstTurnPayload(question, [{ role: "user", text: question, sendId: "send-1", runId: "run-1" }]);
  terminal.status = "completed";
  terminal.run = { ...terminal.run!, status: "completed", endedAt: 11 };
  terminal.pendingSends = [];
  state = chatReducer(state, { type: "resync", payload: terminal });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", question],
      ["assistant", "回答"],
    ],
  );
  assert.deepEqual(renderedMessages(state), [`user:${question}`, "assistant:回答"]);
  const assistant = state.bubbles.find((bubble) => bubble.role === "assistant");
  assert.deepEqual(assistant?.turnEnd, { outcome: "completed", durationMs: 10 });
});

test("新規会話の1通目: pending が steering でも render は user → assistant", () => {
  // What: 開始送信が BFF の steering 状態で届いても、initial send を待機中として隠さない
  const question = "はい前のターンです1。";
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: question,
    at: 1,
    startedAt: 1,
  });
  const payload = firstTurnPayload(question, [{ role: "user", text: question, sendId: "send-1", runId: "run-1" }]);
  payload.pendingSends = [{ sendId: "send-1", runId: "run-1", text: question, at: 1, state: "steering", position: 1 }];
  state = chatReducer(state, { type: "resync", payload });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "usage", usage: USAGE, metrics: METRICS });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 500 });

  assert.deepEqual(renderedMessages(state), [`user:${question}`, "assistant:回答"]);
});

test("新規会話の1通目: 履歴取得が assistant だけでも render は user → assistant", () => {
  // What: 履歴ページが先に assistant を返しても、live の initial send をその手前へ戻す
  const question = "はい前のターンです1。";
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: question,
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, {
    type: "resync",
    payload: firstTurnPayload(question, [{ role: "user", text: question, sendId: "send-1", runId: "run-1" }]),
  });
  state = chatReducer(state, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [
        { kind: "message", id: "a-1", context: "active", role: "assistant", text: "回答", assistantId: "run-1:1" },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: null,
      messageCount: 1,
      summarizedMessageCount: 0,
    },
  });
  state = chatReducer(state, { type: "usage", usage: USAGE, metrics: METRICS });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0, durationMs: 500 });

  assert.deepEqual(renderedMessages(state), [`user:${question}`, "assistant:回答"]);
});

test("終端 resync を繰り返しても、実行の最後の応答にだけ Done を残す", () => {
  // What: 最後の応答が既に結末を持つとき、逆順探索で前の応答へ Done と所要時間を足さない
  const scenario = (withHistory: boolean): ChatState => {
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
    state = chatReducer(state, { type: "text", delta: "B", at: 4, assistantId: "run-1:2" });
    state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
    state = chatReducer(state, {
      type: "runEnd",
      runId: "run-1",
      status: "completed",
      queueDepth: 0,
      durationMs: 5000,
    });

    const work = {
      id: "work-1",
      assistantId: "run-1:1",
      name: "bash",
      args: "",
      isError: false,
      done: true,
      output: "ok",
    };
    const payload = runningPayload();
    payload.status = "completed";
    payload.run = {
      id: "run-1",
      initialSendId: "send-1",
      status: "completed",
      startedAt: 1,
      endedAt: 6,
      prompt: "確認して",
      toolCalls: [work],
      totalRetryCount: 0,
    };
    payload.messages = [
      { role: "user", text: "確認して", sendId: "send-1", runId: "run-1" },
      { role: "assistant", text: "A", assistantId: "run-1:1", tools: [work] },
      { role: "assistant", text: "B", assistantId: "run-1:2" },
    ];
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
        {
          kind: "message",
          id: "a-1",
          context: "active",
          role: "assistant",
          text: "A",
          assistantId: "run-1:1",
          tools: [work],
        },
        {
          kind: "message",
          id: "a-2",
          context: "active",
          role: "assistant",
          text: "B",
          assistantId: "run-1:2",
          turnEnd: { outcome: "completed", durationMs: 5000 },
        },
      ],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: 3,
      summarizedMessageCount: 0,
    };
    if (withHistory) state = chatReducer(state, { type: "resyncHistory", page });
    // 同じ終端 payload を 2 回適用する
    state = chatReducer(state, { type: "resync", payload });
    state = chatReducer(state, { type: "resync", payload });
    return state;
  };

  for (const withHistory of [false, true]) {
    const label = withHistory ? "履歴あり" : "履歴なし";
    const state = scenario(withHistory);
    assert.deepEqual(
      state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => [bubble.text, bubble.turnEnd]),
      [
        ["A", undefined],
        ["B", { outcome: "completed", durationMs: 5000 }],
      ],
      `${label}: 結末は実行の最後の応答だけ`,
    );
    const done = chatRenderItems({
      bubbles: state.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
    })
      .filter((item) => item.kind === "message" && item.turnEnd !== undefined)
      .map((item) => (item.kind === "message" ? [item.bubble.text, item.turnEnd] : []));
    assert.deepEqual(done, [["B", { outcome: "completed", durationMs: 5000 }]], `${label}: Done は 1 か所だけ`);
  }
});
