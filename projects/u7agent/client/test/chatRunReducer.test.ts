// 実行 (run) の開始から終端までと、その間に届く本文・usage・状態の回帰テスト。
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatState } from "../src/lib/chatState";
import { chatReducer } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import type { ChatState } from "../src/lib/chatState";
import type { ContextUsage, HistoryPage, MessageMetrics, SessionPayload, Usage } from "../src/types";

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

/** 実行中ラン付きの payload (resync は run.startedAt から起点を拾う) */
function payloadWithRun(): SessionPayload {
  return {
    ...runningPayload(),
    run: {
      id: "run-1",
      status: "running",
      startedAt: 1700000000000,
      prompt: "聞いて",
      toolCalls: [],
      totalRetryCount: 0,
    },
  };
}

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

/** 履歴 item から作った entryId 付きの user パブル 1 件だけを持つ状態 */
function stateWithHistoryUser(runId: string) {
  return chatReducer(initialChatState, {
    type: "resyncHistory",
    page: {
      sessionId: "session-a",
      items: [{ kind: "message", id: "entry-1", context: "active", role: "user", text: "履歴の本文", runId }],
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "entry-1",
      messageCount: 1,
      summarizedMessageCount: 0,
    },
  });
}

/** 送信のローカルエコーへ run id を結び付けた状態 (entryId を持たないライブバブル) */
function stateWithLiveEcho(runId: string) {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });
  return chatReducer(sent, { type: "echoSendId", sendId: runId, runId });
}

const TURN_END: { status: "completed" | "stopped" | "error"; outcome: string; durationMs: number }[] = [
  { status: "completed", outcome: "completed", durationMs: 80_000 },
  { status: "stopped", outcome: "stopped", durationMs: 999 },
  { status: "error", outcome: "error", durationMs: 1 },
];

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

/** 実行中 run の payload。resync が同じ run の継続かを run.id で判定する */
function liveThinkingPayload(runId: string): SessionPayload {
  return {
    ...runningPayload(),
    run: {
      id: runId,
      initialSendId: "send-1",
      status: "running",
      startedAt: 1,
      prompt: "考えて",
      toolCalls: [],
      totalRetryCount: 0,
    },
  };
}

/** run を開始し、thinking の末尾を 1 度観測した状態 */
function thinkingState(runId = "run-1"): ChatState {
  const started = chatReducer(initialChatState, {
    type: "runStart",
    runId,
    prompt: "考えて",
    at: 1,
    startedAt: 1,
  });
  return chatReducer(started, { type: "status", state: "thinking", text: "考え中…", thinking: "末尾の思考" });
}

test("usage アクションは開いている assistant バブルと context を更新する", () => {
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 100, startedAt: 100 });
  const streaming = chatReducer(started, { type: "text", delta: "答え", at: 200 });
  const applied = chatReducer(streaming, {
    type: "usage",
    usage: USAGE,
    metrics: METRICS,
    context: CONTEXT,
  });

  assert.deepEqual(applied.bubbles[1]?.usage, USAGE);
  assert.deepEqual(applied.bubbles[1]?.metrics, METRICS);
  assert.deepEqual(applied.context, CONTEXT);
  assert.equal(applied.bubbles[1]?.text, "答え", "本文はそのまま");

  // ツールループは 1 バブルに統合されるため、後続メッセージの値で上書きされる
  const secondUsage: Usage = { ...USAGE, input: 9000, output: 100 };
  const secondMetrics: MessageMetrics = { durationMs: 400 };
  const overwritten = chatReducer(applied, { type: "usage", usage: secondUsage, metrics: secondMetrics });
  assert.deepEqual(overwritten.bubbles[1]?.usage, secondUsage);
  assert.deepEqual(overwritten.bubbles[1]?.metrics, secondMetrics);
  assert.deepEqual(overwritten.context, CONTEXT, "context はイベントに無ければ直前の値を保つ");
});

test("usage は本文・ツールカードより先に届いても次の assistant バブルへ回す", () => {
  // 1 つ目の run: 本文と usage が揃った assistant バブル
  const first = chatReducer(initialChatState, { type: "runStart", prompt: "1回目", at: 100, startedAt: 100 });
  const firstText = chatReducer(first, { type: "text", delta: "回答1", at: 200 });
  const firstUsage = chatReducer(firstText, { type: "usage", usage: USAGE, metrics: METRICS });
  const firstBubbleId = firstUsage.bubbles.at(-1)?.id;
  assert.deepEqual(firstUsage.bubbles.at(-1)?.usage, USAGE);

  // 2 つ目の run はツール呼び出しだけ。SDK は message_end → tool_execution_start の順なので usage が先に届く
  const second = chatReducer(firstUsage, { type: "runStart", prompt: "2回目", at: 300, startedAt: 300 });
  const countBeforeUsage = second.bubbles.length;
  const secondUsage: Usage = { ...USAGE, input: 9000, output: 100 };
  const secondMetrics: MessageMetrics = { durationMs: 400, ttftMs: 200 };
  const pending = chatReducer(second, { type: "usage", usage: secondUsage, metrics: secondMetrics });

  assert.equal(pending.bubbles.length, countBeforeUsage, "まだバブルを作らない (空のバブルを出さない)");
  assert.deepEqual(
    pending.bubbles.find((bubble) => bubble.id === firstBubbleId)?.usage,
    USAGE,
    "前の run のバブルを上書きしない",
  );
  assert.deepEqual(pending.bubbles.find((bubble) => bubble.id === firstBubbleId)?.metrics, METRICS);

  const withTool = chatReducer(pending, { type: "toolStart", id: "tool-1", name: "read", args: "README.md", at: 400 });
  assert.equal(withTool.bubbles.length, countBeforeUsage + 1, "ツールカードで作られるバブルへ回る");
  const lastBubble = withTool.bubbles.at(-1);
  assert.deepEqual(lastBubble?.usage, secondUsage);
  assert.deepEqual(lastBubble?.metrics, secondMetrics);
  assert.equal(lastBubble?.tools.length, 1);

  // 保留値は使ったら消える (次の応答へ持ち越さない)
  assert.equal(withTool.pendingUsage, undefined);
  assert.equal(withTool.pendingMetrics, undefined);
});

test("最初の応答でも usage を捨てず、後から届く本文へ付ける", () => {
  // 非ストリーミングの最終本文は BFF の finish で message_end より後に届く
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 100, startedAt: 100 });
  const countBeforeUsage = started.bubbles.length;
  const pending = chatReducer(started, { type: "usage", usage: USAGE, metrics: METRICS });
  assert.equal(pending.bubbles.length, countBeforeUsage, "user バブルだけのまま");

  const text = chatReducer(pending, { type: "text", delta: "回答", at: 200 });
  assert.equal(text.bubbles.length, countBeforeUsage + 1);
  const assistant = text.bubbles.at(-1);
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.text, "回答");
  assert.deepEqual(assistant?.usage, USAGE);
  assert.deepEqual(assistant?.metrics, METRICS);
  assert.equal(text.pendingUsage, undefined);
});

test("保留した usage は run をまたがず、resync でも消える", () => {
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 100, startedAt: 100 });
  const pending = chatReducer(started, { type: "usage", usage: USAGE, metrics: METRICS });

  // バブルができないまま run が終わったら捨てる
  const ended = chatReducer(pending, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(ended.pendingUsage, undefined);
  const nextTool = chatReducer(ended, { type: "toolStart", id: "tool-1", name: "read", args: "x", at: 300 });
  assert.equal(nextTool.bubbles[0]?.usage, undefined, "次の run へ持ち越さない");

  // resync はサーバー payload が正なので保留値を捨てる
  const resynced = chatReducer(pending, { type: "resync", payload: payloadWithUsage() });
  assert.equal(resynced.pendingUsage, undefined);
  assert.deepEqual(resynced.bubbles[1]?.usage, USAGE);
});

test("run_end の context は usage の値を上書きする", () => {
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 100, startedAt: 100 });
  const stale: ContextUsage = { tokens: null, contextWindow: 128_000, percent: null };
  const withUsage = chatReducer(started, { type: "usage", usage: USAGE, metrics: METRICS, context: stale });
  assert.deepEqual(withUsage.context, stale);

  const ended = chatReducer(withUsage, {
    type: "runEnd",
    status: "completed",
    queueDepth: 0,
    context: CONTEXT,
  });
  assert.deepEqual(ended.context, CONTEXT, "SDK の履歴反映後の値を採用する");

  // context を伴わない run_end では直前の値を保つ
  const kept = chatReducer(ended, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.deepEqual(kept.context, CONTEXT);
});

test("usage だけのイベントでもバブルが無ければ context だけ反映する", () => {
  const state = chatReducer(initialChatState, { type: "usage", context: CONTEXT });
  assert.deepEqual(state.context, CONTEXT);
  assert.deepEqual(state.bubbles, []);
});

test("run_end と、running を抜けた resync で runEndSeq が進む", () => {
  const running = stateWithSession();

  // 通常の run_end
  const ended = chatReducer(running, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(ended.runEndSeq, running.runEndSeq + 1);

  // run_start と run_end が同じバッチで届いても、reducer は 1 回ずつ数える
  // (描画を挟まないため、画面側は running を観測できない。右パネルの取り直しはこの値だけを起点にする)
  const batched = chatReducer(chatReducer(running, { type: "runStart", prompt: "続けて", at: 1, startedAt: 1 }), {
    type: "runEnd",
    status: "completed",
    queueDepth: 0,
  });
  assert.equal(batched.runEndSeq, running.runEndSeq + 1);
  assert.equal(batched.runStatus, "idle");

  // run_end を受け取れない復帰 (切断した SSE の resync) でも、running から抜けていれば進む
  const resynced = chatReducer(running, {
    type: "resync",
    payload: { ...runningPayload(), status: "completed" },
  });
  assert.equal(resynced.runEndSeq, running.runEndSeq + 1);

  // running のままの resync では進めない (実行中に取り直さない)
  const stillRunning = chatReducer(running, { type: "resync", payload: runningPayload() });
  assert.equal(stillRunning.runEndSeq, running.runEndSeq);
});

test("runStartedAt は実行中の間だけサーバーの開始時刻を持つ", () => {
  const payload = payloadWithRun();

  // 実行中に取り直した (reload / 再接続の resync) ときは payload の開始時刻
  const resynced = chatReducer(initialChatState, { type: "resync", payload });
  assert.equal(resynced.runStartedAt, 1700000000000);

  // 実行中でも run を配らない payload (テストスタブ等) と、実行中でない resync は起点を落とす
  const withoutRun = chatReducer(resynced, { type: "resync", payload: runningPayload() });
  assert.equal(withoutRun.runStartedAt, undefined);
  const completed = chatReducer(
    { ...resynced, runStartedAt: 1700000000000 },
    { type: "resync", payload: { ...payload, status: "completed" } },
  );
  assert.equal(completed.runStartedAt, undefined);
});

test("runStartedAt はキューをまたいで持ち越さず、次のランで入れ替わる", () => {
  const started = chatReducer(initialChatState, {
    type: "runStart",
    prompt: "1回目",
    at: 100,
    startedAt: 100,
  });

  // 次のメッセージが待機中でも、実行中のランは起点を持ち続ける
  const queued = chatReducer(started, { type: "queued", position: 1, queueDepth: 1 });
  assert.equal(queued.runStartedAt, 100);

  // ランが終わると待機中 (queueDepth > 0) でも起点を落とし、次の run_start で入れ替える
  const ended = chatReducer(queued, { type: "runEnd", status: "completed", queueDepth: 1 });
  assert.equal(ended.runStatus, "queued");
  assert.equal(ended.runStartedAt, undefined);

  const next = chatReducer(ended, { type: "runStart", prompt: "2回目", at: 300, startedAt: 300 });
  assert.equal(next.runStartedAt, 300);
});

test("runStartedAt は受信時刻ではなくサーバーの開始時刻を使う", () => {
  // 切断中に始まった run の run_start がリプレイされても、クライアント側の受信時刻ではぶれない
  const started = chatReducer(initialChatState, {
    type: "runStart",
    prompt: "聞いて",
    at: 5000,
    startedAt: 1700000000123,
  });
  assert.equal(started.runStartedAt, 1700000000123);

  assert.equal(chatReducer(started, { type: "runEnd", status: "completed", queueDepth: 0 }).runStartedAt, undefined);
  assert.equal(chatReducer(started, { type: "newChat" }).runStartedAt, undefined);
});

test("runEnd (completed) は runStatus を idle へ戻し、状態行の語だけを残す", () => {
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 100, startedAt: 100 });
  const ended = chatReducer(started, { type: "runEnd", status: "completed", queueDepth: 0, durationMs: 72_000 });

  assert.equal(ended.runStatus, "idle", "completion の表示は runStatus が idle へ戻っても残る");
  // 実行中の経過時間は終了と同時に落とす (状態行の数字と二重に出さない)
  assert.equal(ended.runStartedAt, undefined);
  // 合計時間は会話のメタ行 (`Done · 1m 12s`) が担う。状態行に残すとリロード / 再接続で消える値が二重になる
  assert.equal(ended.activity, "完了");
});

// --- 手動圧縮 (compacting) ---

test("圧縮の開始時刻は run_start / run_end / setRun をまたいで残らない", () => {
  const compacting = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });
  const started = chatReducer(compacting, { type: "runStart", prompt: "次の実行", at: 9, startedAt: 9 });
  assert.equal(started.runStartedAt, 9);
  assert.equal(started.compactionStartedAt, undefined, "次の run は圧縮の起点を引き継がない");

  const queuedStatus = chatReducer(compacting, { type: "setRun", runStatus: "queued", queueDepth: 1 });
  assert.equal(queuedStatus.compactionStartedAt, undefined);

  const ended = chatReducer(compacting, { type: "runEnd", status: "stopped", queueDepth: 0 });
  assert.equal(ended.compactionStartedAt, undefined);

  // 新しい会話へ戻しても残らない
  assert.equal(chatReducer(compacting, { type: "newChat" }).compactionStartedAt, undefined);
});

test("要求時の世代が古い停止応答の setRun は状態を作り直さない", () => {
  // What: 終端や次の run の後に届いた応答を、要求時の世代との一致で捨てる
  const started = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    prompt: "停止対象",
    at: 1,
    startedAt: 1,
  });
  const requestSeq = started.stateSeq;
  const ended = chatReducer(started, { type: "runEnd", runId: "run-1", status: "stopped", queueDepth: 0 });
  const late = chatReducer(ended, {
    type: "setRun",
    runStatus: "stopped",
    queueDepth: 0,
    activity: "停止要求を送信しました",
    stateSeq: requestSeq,
  });
  assert.equal(late, ended, "古い応答では状態を作り直さない");

  const current = chatReducer(started, {
    type: "setRun",
    runStatus: "stopped",
    queueDepth: 0,
    activity: "停止要求を送信しました",
    stateSeq: requestSeq,
  });
  assert.equal(current.activity, "停止要求を送信しました", "世代が一致すれば適用する");
});

// --- 最終失敗の分類コード (エラーカードの再実行) ---

test("runEnd は分類コードを保持し、カードを出すときだけ活動欄の文言を空にする", () => {
  const ended = chatReducer(initialChatState, {
    type: "runEnd",
    status: "error",
    queueDepth: 0,
    error: RUN_ERROR_TEXT,
    errorCode: "rate_limit",
  });

  assert.deepEqual(ended.runError, { code: "rate_limit", text: RUN_ERROR_TEXT });
  assert.equal(ended.runStatus, "error");
  assert.equal(ended.activity, "", "同じ 1 文をカードと状態行に二重に出さない");
});

test("runEnd はカードを出さない分類でもコードを保持し、文言は状態行に残す", () => {
  const ended = chatReducer(initialChatState, {
    type: "runEnd",
    status: "error",
    queueDepth: 0,
    error: "入力がモデルのコンテキスト上限を超えました",
    errorCode: "context_overflow",
  });

  assert.equal(ended.runError?.code, "context_overflow");
  assert.equal(ended.activity, "エラー: 入力がモデルのコンテキスト上限を超えました");
});

test("runEnd は分類コードが無ければ従来どおり汎用文言を出す", () => {
  const ended = chatReducer(initialChatState, { type: "runEnd", status: "error", queueDepth: 0 });

  assert.equal(ended.runError, undefined);
  assert.equal(ended.activity, "エラー: 実行に失敗しました");
});

test("停止で確定した runEnd は分類コードを載せない (停止と例外が同時の場合)", () => {
  const ended = chatReducer(initialChatState, {
    type: "runEnd",
    status: "stopped",
    queueDepth: 0,
    error: RUN_ERROR_TEXT,
    errorCode: "rate_limit",
  });

  assert.equal(ended.runError, undefined, "停止直後に再実行カードを出さない");
  assert.equal(ended.activity, "停止しました");
});

test("キュー待ちを挟んだ失敗はカードを出さず、文言を状態行に残す", () => {
  const ended = chatReducer(initialChatState, {
    type: "runEnd",
    status: "error",
    queueDepth: 1,
    error: RUN_ERROR_TEXT,
    errorCode: "rate_limit",
  });

  assert.equal(ended.runStatus, "queued", "次のランが pump されるまでのカードのフラッシュを避ける");
  assert.equal(ended.activity, `エラー: ${RUN_ERROR_TEXT}`);
});

test("新しいラン・成功・停止・実行中への移行・チャット切替で失敗を消す", () => {
  const failed = chatReducer(initialChatState, {
    type: "runEnd",
    status: "error",
    queueDepth: 0,
    error: RUN_ERROR_TEXT,
    errorCode: "rate_limit",
  });
  assert.notEqual(failed.runError, undefined);

  assert.equal(chatReducer(failed, { type: "runStart", prompt: "続き", at: 1, startedAt: 1 }).runError, undefined);
  assert.equal(chatReducer(failed, { type: "runEnd", status: "completed", queueDepth: 0 }).runError, undefined);
  assert.equal(chatReducer(failed, { type: "runEnd", status: "stopped", queueDepth: 0 }).runError, undefined);
  // 送信の応答で実行中へ移ったら、run_start が遅れても古い失敗を残さない
  assert.equal(chatReducer(failed, { type: "setRun", runStatus: "running" }).runError, undefined);
  assert.equal(chatReducer(failed, { type: "newChat" }).runError, undefined);
});

// --- 直近 run のツールカード (runTools) ---

test("status の state が活動表示の由来になり、run_end で消える", () => {
  const started = chatReducer(initialChatState, { type: "runStart", prompt: "聞いて", at: 1, startedAt: 1 });
  assert.equal(started.activityState, undefined, "run_start の時点ではモデルは動いていない");

  const thinking = chatReducer(started, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(thinking.activityState, "thinking");
  assert.equal(thinking.activity, "考え中…");

  const tool = chatReducer(thinking, { type: "status", state: "tool", text: "read を実行中…" });
  assert.equal(tool.activityState, "tool", "由来は文言ではなくサーバーの state から取る");

  const ended = chatReducer(tool, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(ended.activityState, undefined, "終わった run の由来を残さない");
});

test("resync の実行中は由来を持たない (文言が長く、次の status で再開する)", () => {
  const running = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  assert.equal(running.runStatus, "running");
  assert.equal(running.activityState, undefined, "復帰の長い文言に光を当てている");

  const thinking = chatReducer(running, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(thinking.activityState, "thinking", "run 自身の短いラベルが出た時点で再開する");

  const finished = chatReducer(thinking, {
    type: "resync",
    payload: { ...runningPayload(), status: "completed" as const },
  });
  assert.equal(finished.activityState, undefined, "run_end を取りこぼした復帰でも残さない");
});

// --- investigate の live 進捗 (tool_progress) ---

test("run_end は runId 一致の user パブルへ所要時間と結末を写す", () => {
  for (const { status, outcome, durationMs } of TURN_END) {
    // 履歴 item のバブル (entryId あり)
    const fromHistory = chatReducer(stateWithHistoryUser("run-h"), {
      type: "runEnd",
      runId: "run-h",
      status,
      queueDepth: 0,
      durationMs,
    });
    assert.deepEqual(
      fromHistory.bubbles.map((bubble) => [bubble.runDurationMs, bubble.runOutcome]),
      [[durationMs, outcome]],
      "履歴のパブルへ写す",
    );

    // 送信直後のローカルエコー (entryId なし)。run 中の resync で置き換わっても runId で対応が取れる
    const fromEcho = chatReducer(stateWithLiveEcho("run-l"), {
      type: "runEnd",
      runId: "run-l",
      status,
      queueDepth: 0,
      durationMs,
    });
    assert.deepEqual(
      fromEcho.bubbles.map((bubble) => [bubble.runDurationMs, bubble.runOutcome]),
      [[durationMs, outcome]],
      "entryId が無くても写す",
    );
  }
});

test("run_end の値は別 run / 旧サーバー / 終端以外では写さない", () => {
  const live = stateWithLiveEcho("run-l");
  const other = chatReducer(live, {
    type: "runEnd",
    runId: "run-other",
    status: "completed",
    queueDepth: 0,
    durationMs: 80_000,
  });
  assert.equal(other.bubbles[0]?.runDurationMs, undefined, "run id が違えば写さない");

  const old = chatReducer(live, { type: "runEnd", runId: "run-l", status: "completed", queueDepth: 0 });
  assert.equal(old.bubbles[0]?.runDurationMs, undefined, "durationMs の無い旧サーバーでは写さない");

  // run_end の status は 7 値。終端以外は結末として通さない (行を出さない)
  for (const status of ["idle", "running", "queued", "compacting"] as const) {
    const nonTerminal = chatReducer(live, {
      type: "runEnd",
      runId: "run-l",
      status,
      queueDepth: 0,
      durationMs: 80_000,
    });
    assert.equal(nonTerminal.bubbles[0]?.runOutcome, undefined, `${status} は終端ではない`);
  }
});

test("assistant_end は同じ実行の次の応答を新しいカードにし、追加入力をその間に置く", () => {
  // What: 応答の終端でカードを閉じ、steering の user を 2 つの assistant の間に描画する
  let state = streamingTurn();
  const first = state.currentAssistantId;
  state = chatReducer(state, { type: "localUser", text: "追記", at: 11 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  assert.equal(state.currentAssistantId, first, "注入の resync では同じ応答を続ける");

  state = chatReducer(state, { type: "assistantEnd" });
  assert.equal(state.currentAssistantId, null, "応答の終端で次の delta の補完先を閉じる");
  state = chatReducer(state, { type: "text", delta: "次", at: 12 });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((bubble) => bubble.text),
    ["前半", "次"],
    "次の応答を前の応答へ連結しない",
  );
  const firstIndex = state.bubbles.findIndex((bubble) => bubble.text === "前半");
  const userIndex = state.bubbles.findIndex((bubble) => bubble.role === "user" && bubble.sendId === "send-2");
  const secondIndex = state.bubbles.findIndex((bubble) => bubble.text === "次");
  assert.ok(firstIndex < userIndex && userIndex < secondIndex, "user は 2 つの assistant の間にある");

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
  });
  const withDone = items.filter((item) => item.kind === "message" && item.turnEnd !== undefined);
  assert.deepEqual(
    withDone.map((item) => (item.kind === "message" ? item.bubble.text : "")),
    ["次"],
    "Done は最後の応答だけに付く",
  );
});

test("ツール付き応答の後も assistant_end でカードを閉じ、steering の次応答を分ける", () => {
  // What: ツール実行 → steering 追記 → 次応答で live が 1 カードに混ざらない (GUI 受入の再現)
  let state = streamingTurn();
  state = chatReducer(state, { type: "assistantEnd" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "tool-1",
    name: "bash",
    args: '{"command":"true"}',
    at: 11,
  });
  state = chatReducer(state, { type: "toolEnd", id: "tool-1", isError: false, output: "ok" });
  state = chatReducer(state, { type: "localUser", text: "追記", at: 12 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-2", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, { type: "resync", payload: streamingPayload() });
  state = chatReducer(state, { type: "text", delta: "追記を受け取って次の判断に反映", at: 13 });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.deepEqual(
    assistants.map((bubble) => bubble.text),
    ["前半", "追記を受け取って次の判断に反映"],
  );
  assert.deepEqual(
    assistants[0]?.tools.map((card) => card.id),
    ["tool-1"],
    "ツールは前者のカードに残る",
  );
  assert.equal(assistants[1]?.tools.length, 0);
  const userIndex = state.bubbles.findIndex((bubble) => bubble.sendId === "send-2");
  assert.ok(
    state.bubbles.findIndex((bubble) => bubble.text === "前半") < userIndex &&
      userIndex < state.bubbles.findIndex((bubble) => bubble.text === "追記を受け取って次の判断に反映"),
  );
});

test("同じターンでも assistant_end で閉じた前の応答へ今の応答を寄せない", () => {
  // What: 応答の境界を観測済みなら、同じ user ターン内の先行応答と本文が重なっても別カードのまま残す
  const page = (assistant: boolean): HistoryPage => {
    const items: HistoryPage["items"] = [
      { kind: "message", id: "u-1", context: "active", role: "user", text: "質問", sendId: "send-1", runId: "run-1" },
    ];
    if (assistant) {
      items.push({ kind: "message", id: "a-1", context: "active", role: "assistant", text: "はい" });
    }
    return {
      sessionId: "session-a",
      items,
      prevCursor: null,
      hasMore: false,
      nextCursor: null,
      activeContextStartId: "u-1",
      messageCount: items.length,
      summarizedMessageCount: 0,
    };
  };

  let state = chatReducer(initialChatState, { type: "resyncHistory", page: page(false) });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "はい", at: 11 });
  state = chatReducer(state, { type: "assistantEnd" });
  state = chatReducer(state, { type: "text", delta: "はい、別の応答です", at: 12 });

  state = chatReducer(state, { type: "resyncHistory", page: page(true) });
  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => [bubble.text, bubble.entryId]),
    [
      ["はい", "a-1"],
      ["はい、別の応答です", undefined],
    ],
    "閉じた先行応答を今の応答で上書きしない",
  );
});

test("message_end の不足本文は assistant_end より前に届き、1 カードに usage と Done が残る", () => {
  // What: サーバーの text(末尾) → usage → assistant_end の順で適用しても、live が 1 カードのまま閉じる
  let state = chatReducer(initialChatState, { type: "localUser", text: "質問", at: 10 });
  state = chatReducer(state, { type: "echoSendId", sendId: "send-1", runId: "run-1", stateSeq: state.stateSeq });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 10,
    startedAt: 10,
  });
  state = chatReducer(state, { type: "text", delta: "先頭の本文", at: 11, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "text", delta: "と末尾の本文", at: 12, assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "usage",
    usage: USAGE,
    metrics: METRICS,
    context: CONTEXT,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "runEnd",
    runId: "run-1",
    status: "completed",
    queueDepth: 0,
    durationMs: 5000,
  });

  const assistants = state.bubbles.filter((bubble) => bubble.role === "assistant");
  assert.equal(assistants.length, 1, "1 応答を 2 カードに割らない");
  assert.equal(assistants[0]?.text, "先頭の本文と末尾の本文");
  assert.equal(assistants[0]?.assistantId, "run-1:1");
  assert.deepEqual(assistants[0]?.usage, USAGE);
  assert.deepEqual(assistants[0]?.metrics, METRICS);
  const items = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message" && item.bubble.role === "assistant");
  assert.deepEqual(
    items.map((item) => (item.kind === "message" ? item.turnEnd : undefined)),
    [{ outcome: "completed", durationMs: 5000 }],
    "Done は同じ 1 カードに残る",
  );
});

test("assistant_end を取りこぼしても次の応答IDが変われば新しいカードを開く", () => {
  // What: 境界イベントが無くても、delta の assistantId が変わった時点で前の応答へ連結しない
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "text", delta: "先の応答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "text", delta: "次の応答", at: 3, assistantId: "run-1:2" });

  assert.deepEqual(
    state.bubbles.filter((bubble) => bubble.role === "assistant").map((bubble) => [bubble.text, bubble.assistantId]),
    [
      ["先の応答", "run-1:1"],
      ["次の応答", "run-1:2"],
    ],
  );
  assert.equal(state.currentAssistantId, state.bubbles.at(-1)?.id);
  assert.equal(state.bubbles.find((bubble) => bubble.assistantId === "run-1:1")?.settled, true);
});

test("応答が先に届いても run_start は user を応答の手前へ置く", () => {
  // What: 新規会話で run_start が text より遅れても、user を末尾へ append しない
  let state = chatReducer(initialChatState, { type: "text", delta: "回答", at: 2, assistantId: "run-1:1" });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "質問",
    at: 1,
    startedAt: 1,
  });

  assert.deepEqual(
    state.bubbles.map((bubble) => [bubble.role, bubble.text]),
    [
      ["user", "質問"],
      ["assistant", "回答"],
    ],
  );
});

test("assistant のモデルは payload と assistant_end の両方からバブルへ入る", () => {
  // What: 履歴の model はそのまま写し、live は assistant_end まで出さず、届いた値 (null = 不明を含む) で確定する
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "質問" },
    { role: "assistant", text: "応答", model: "openai/gpt-6-luna" },
  ];
  let state = chatReducer(initialChatState, { type: "resync", payload });
  const fromPayload = state.bubbles.find((bubble) => bubble.text === "応答");
  assert.equal(fromPayload?.model, "openai/gpt-6-luna");
  assert.equal(state.bubbles.find((bubble) => bubble.text === "質問")?.model, undefined, "user はモデルを持たない");

  state = chatReducer(state, { type: "text", delta: "追記", at: 3, assistantId: "run-1:2" });
  const streaming = state.bubbles.find((bubble) => bubble.assistantId === "run-1:2");
  assert.equal(streaming?.model, undefined, "ストリーミング中はモデルを出さない");

  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2", model: "openai/gpt-6-luna" });
  assert.equal(state.bubbles.find((bubble) => bubble.assistantId === "run-1:2")?.model, "openai/gpt-6-luna");

  state = chatReducer(state, { type: "text", delta: "不明な応答", at: 4, assistantId: "run-1:3" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:3", model: null });
  assert.equal(state.bubbles.find((bubble) => bubble.assistantId === "run-1:3")?.model, null, "不明は null で確定する");
});

test("thinking の末尾は status で入り、phase が移ると text だけ消える", () => {
  const thinking = thinkingState();
  assert.equal(thinking.thinkingText, "末尾の思考");

  // writing / tool / question では tail を消す
  for (const [state, text] of [
    ["writing", "応答を書いています…"],
    ["tool", "bash を実行中…"],
    ["question", "回答を待っています…"],
  ] as const) {
    const next = chatReducer(thinking, { type: "status", state, text });
    assert.equal(next.thinkingText, undefined, `${state} で tail を消す`);
    assert.equal(next.activity, text, "phase のラベルは status の文言を使う");
  }
});

test("status の再送では phase のラベルを変えず、tail だけを差し替える", () => {
  const thinking = thinkingState();
  const resent = chatReducer(thinking, { type: "status", state: "thinking", text: "考え中…", thinking: "次の末尾" });
  assert.equal(resent.thinkingText, "次の末尾");
  assert.equal(resent.activity, "考え中…");
  // thinking を載せない status は tail のクリアを意味する
  const cleared = chatReducer(resent, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(cleared.thinkingText, undefined);
});

test("旧サーバー / 取りこぼしに備えて text / toolStart / assistantEnd でも tail を消す", () => {
  const thinking = thinkingState();
  assert.equal(chatReducer(thinking, { type: "text", delta: "本文", at: 2 }).thinkingText, undefined);
  assert.equal(
    chatReducer(thinking, { type: "toolStart", id: "call-1", name: "read", args: "a.md", at: 2 }).thinkingText,
    undefined,
  );
  assert.equal(chatReducer(thinking, { type: "assistantEnd", assistantId: "run-1:1" }).thinkingText, undefined);
});

test("切断を検知したら tail だけを消す", () => {
  const thinking = thinkingState();
  const disconnected = chatReducer(thinking, { type: "thinkingCleared" });
  assert.equal(disconnected.thinkingText, undefined);
  // リプレイされた status は thinking を載せない (古い tail を再表示しない)
  const replayed = chatReducer(disconnected, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(replayed.thinkingText, undefined);
});

test("resync / runEnd / newChat は tail を落とす", () => {
  const thinking = thinkingState("run-1");
  assert.equal(
    chatReducer(thinking, { type: "resync", payload: liveThinkingPayload("run-1") }).thinkingText,
    undefined,
  );

  const ended = chatReducer(thinking, { type: "runEnd", runId: "run-1", status: "completed", queueDepth: 0 });
  assert.equal(ended.thinkingText, undefined);

  const fresh = chatReducer(thinking, { type: "newChat" });
  assert.equal(fresh.thinkingText, undefined);
});
