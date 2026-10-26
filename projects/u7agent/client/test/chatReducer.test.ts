// 新規チャット (未作成チャットへ戻す) のリセットの回帰テスト。
//
// セッションは最初の送信時に作られるため、エージェント切替や「新しい会話」は
// chat state を初期値へ戻すだけになる。前の会話の実効モデル・バブル・実行状態が
// 残らないことと、bubble id (nextId) をセッション跨ぎで再利用しないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { chatReducer, initialChatState, type ChatState } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import { queuedSendsOf } from "../src/lib/queueWait";
import type {
  CompactionInfo,
  ContextUsage,
  HistoryPage,
  MessageMetrics,
  PendingSend,
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

test("sendSeq は送信 (localUser) でだけ増える", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });
  assert.equal(sent.sendSeq, initialChatState.sendSeq + 1);
  assert.equal(chatReducer(sent, { type: "localUser", text: "もう一度", at: 2 }).sendSeq, 2);
});

test("sendSeq は resync / run_start / echo の破棄で変わらない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });

  // 履歴を全置換する再接続。末尾が user でも送信と誤読しない
  const resynced = chatReducer(sent, { type: "resync", payload: runningPayload() });
  assert.equal(resynced.sendSeq, 1);
  assert.equal(chatReducer(resynced, { type: "resync", payload: runningPayload() }).sendSeq, 1);

  // サーバー側の受信 (run_start) は送信ではない
  assert.equal(chatReducer(sent, { type: "runStart", prompt: "聞いて", at: 2, startedAt: 2 }).sendSeq, 1);

  // post に失敗して echo を戻しても減らさない (最下部へ戻したままにする)
  assert.equal(chatReducer(sent, { type: "dropLocalUser" }).sendSeq, 1);
});

test("sendSeq は新規チャットへ引き継ぎ、単調に保つ", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "聞いて", at: 1 });
  const reset = chatReducer(sent, { type: "newChat" });

  // 減らすと、新規チャットへの切替を「送信」と誤読させる
  assert.equal(reset.sendSeq, 1);
  assert.equal(chatReducer(reset, { type: "localUser", text: "次の会話", at: 2 }).sendSeq, 2);
});

// --- メッセージ時刻 ---

/** 履歴に at を持つ payload (リロード / resync 後はサーバーの値が正) */
function payloadWithTimes(): SessionPayload {
  const payload = runningPayload();
  payload.messages = [
    { role: "user", text: "こんにちは", at: 1700000000000 },
    { role: "assistant", text: "はい", at: 1700000001000 },
  ];
  return payload;
}

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

test("ローカル生成のバブルは action で受け取った時刻を使う", () => {
  const user = chatReducer(initialChatState, { type: "localUser", text: "送信中", at: 100 });
  assert.equal(user.bubbles[0]?.at, 100);

  // runStart はローカルエコー済みの user バブルを重複させない (時刻は最初のバブルのまま)
  const echoed = chatReducer(user, { type: "runStart", prompt: "送信中", at: 200, startedAt: 200 });
  assert.deepEqual(
    echoed.bubbles.map((bubble) => bubble.at),
    [100],
  );

  const started = chatReducer(initialChatState, { type: "runStart", prompt: "新しい会話", at: 200, startedAt: 200 });
  assert.equal(started.bubbles[0]?.at, 200);

  // 応答中のバブルは生成元イベントの時刻で作り、以後の delta では上書きしない
  const streaming = chatReducer(started, { type: "text", delta: "応答", at: 300 });
  assert.equal(streaming.bubbles[1]?.at, 300);
  const more = chatReducer(streaming, { type: "text", delta: "の続き", at: 400 });
  assert.equal(more.bubbles[1]?.at, 300);

  // 本文が無くツールだけの assistant も同じ経路で時刻を持つ
  const toolOnly = chatReducer(initialChatState, {
    type: "toolStart",
    id: "tool-1",
    name: "read",
    args: "README.md",
    at: 500,
  });
  assert.equal(toolOnly.bubbles[0]?.at, 500);
  assert.equal(toolOnly.bubbles[0]?.text, "");
});

test("runStart は添付の注記をローカルエコーと同一視し、注記込みの本文へ差し替える", () => {
  const prompt = ["これを見て", "", "<attached_files>", "- ./uploads/a.png", "</attached_files>"].join("\n");
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "これを見て", at: 100 });

  const started = chatReducer(echoed, { type: "runStart", prompt, at: 200, startedAt: 200 });
  assert.equal(started.bubbles.length, 1, "バブルを重複させない");
  assert.equal(started.bubbles[0]?.text, prompt, "注記込みの本文へ差し替える");
  assert.equal(started.bubbles[0]?.at, 100, "ローカルエコーの時刻を保つ");

  // 同じ本文の別メッセージを二重に足さない
  const repeated = chatReducer(started, { type: "runStart", prompt, at: 300, startedAt: 300 });
  assert.equal(repeated.bubbles.length, 1);

  // 添付の無い通常送信は従来どおり (本文が同じなら足さない)
  const plain = chatReducer(initialChatState, { type: "localUser", text: "ふつうの本文", at: 100 });
  const plainStarted = chatReducer(plain, { type: "runStart", prompt: "ふつうの本文", at: 200, startedAt: 200 });
  assert.equal(plainStarted.bubbles.length, 1);
  assert.equal(plainStarted.bubbles[0]?.text, "ふつうの本文");
});

test("runStart は展開済みのスキルブロックをローカルエコーと同一視し、展開後の本文へ差し替える", () => {
  // /skill: は BFF が展開してから届くため、run_start の本文はブロック込みになる
  const block = [
    '<skill name="writer" location="/workspace/.agents/skills/writer/SKILL.md">',
    "References are relative to /workspace/.agents/skills/writer.",
    "",
    "本文です。",
    "</skill>",
    "",
    "短く書いて",
  ].join("\n");
  const echoed = chatReducer(initialChatState, { type: "localUser", text: "/skill:writer 短く書いて", at: 100 });

  const started = chatReducer(echoed, { type: "runStart", prompt: block, at: 200, startedAt: 200 });
  assert.equal(started.bubbles.length, 1, "バブルを重複させない");
  assert.equal(started.bubbles[0]?.text, block, "展開後の本文へ差し替える");
  assert.equal(started.bubbles[0]?.at, 100, "ローカルエコーの時刻を保つ");

  // 未知の名前は展開されない (本文がそのまま届く) ので、通常の送信と同じ扱い
  const unknown = chatReducer(chatReducer(initialChatState, { type: "localUser", text: "/skill:ghost", at: 100 }), {
    type: "runStart",
    prompt: "/skill:ghost",
    at: 200,
    startedAt: 200,
  });
  assert.equal(unknown.bubbles.length, 1);
  assert.equal(unknown.bubbles[0]?.text, "/skill:ghost");
});

test("同一本文・異なる添付を続けて送っても run_start は送信順のバブルを差し替える", () => {
  const note = (path: string) => ["同じ本文", "", "<attached_files>", `- ./${path}`, "</attached_files>"].join("\n");
  const firstPrompt = note("uploads/a.png");
  const secondPrompt = note("uploads/b.png");

  // 実行中に同じ本文を送ると、2 つ目のエコーがキューに積まれる
  let state = chatReducer(initialChatState, { type: "localUser", text: "同じ本文", at: 100 });
  state = chatReducer(state, { type: "localUser", text: "同じ本文", at: 200 });
  assert.equal(state.bubbles.length, 2, "ローカルエコーは 2 つ出る");

  // 先に届く run_start は先に送ったバブルへ、次は後ろのバブルへ割り当たる
  const first = chatReducer(state, { type: "runStart", prompt: firstPrompt, at: 300, startedAt: 300 });
  assert.deepEqual(
    first.bubbles.map((bubble) => bubble.text),
    [firstPrompt, "同じ本文"],
    "先頭のバブルだけを差し替える",
  );
  assert.deepEqual(first.pendingEchoIds, [state.bubbles[1]?.id], "2 つ目のエコーは順番待ちのまま");
  const second = chatReducer(first, { type: "runStart", prompt: secondPrompt, at: 400, startedAt: 400 });
  assert.deepEqual(
    second.bubbles.map((bubble) => bubble.text),
    [firstPrompt, secondPrompt],
  );
  assert.deepEqual(second.pendingEchoIds, []);
  assert.equal(second.bubbles[0]?.at, 100, "時刻はエコーのものを保つ");
  assert.equal(second.bubbles[1]?.at, 200);
});

test("送信に失敗したエコーを戻し、次の同一本文が正しく割り当たる", () => {
  const prompt = ["同じ本文", "", "<attached_files>", "- ./uploads/a.png", "</attached_files>"].join("\n");

  const echoed = chatReducer(initialChatState, { type: "localUser", text: "同じ本文", at: 100 });
  const dropped = chatReducer(echoed, { type: "dropLocalUser" });
  assert.deepEqual(dropped.bubbles, [], "失敗したエコーは残さない");
  assert.deepEqual(dropped.pendingEchoIds, []);
  // 待ち行列が空のときに戻しても何も起きない
  assert.equal(chatReducer(dropped, { type: "dropLocalUser" }), dropped);

  const retried = chatReducer(dropped, { type: "localUser", text: "同じ本文", at: 200 });
  const started = chatReducer(retried, { type: "runStart", prompt, at: 300, startedAt: 300 });
  assert.equal(started.bubbles.length, 1, "失敗分のバブルが残っていない");
  assert.equal(started.bubbles[0]?.text, prompt, "再送のバブルが自分の注記を受け取る");
  assert.equal(started.bubbles[0]?.at, 200);
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

test("resync は履歴の usage / metrics をバブルへ、context を state へ写す", () => {
  const state = chatReducer(initialChatState, { type: "resync", payload: payloadWithUsage() });

  assert.equal(state.bubbles[0]?.usage, undefined);
  assert.equal(state.bubbles[0]?.metrics, undefined);
  assert.deepEqual(state.bubbles[1]?.usage, USAGE);
  assert.deepEqual(state.bubbles[1]?.metrics, METRICS);
  assert.deepEqual(state.context, CONTEXT);
});

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

test("新規チャットで context も消える", () => {
  const used = chatReducer(initialChatState, { type: "resync", payload: payloadWithUsage() });
  const reset = chatReducer(used, { type: "newChat" });
  assert.equal(reset.context, undefined);
});

// --- compaction ---

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

test("resync は圧縮履歴を payload で置き換える", () => {
  const payload = { ...runningPayload(), compactions: [COMPACTION] };
  const state = chatReducer(initialChatState, { type: "resync", payload });
  assert.deepEqual(state.compactions, [COMPACTION]);

  // 圧縮の無い payload へ戻すと履歴も消える (サーバー DTO が正)
  const cleared = chatReducer(state, { type: "resync", payload: runningPayload() });
  assert.deepEqual(cleared.compactions, []);
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

test("新しい会話へ戻しても runEndSeq は戻らない", () => {
  const ended = chatReducer(stateWithSession(), { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(chatReducer(ended, { type: "newChat" }).runEndSeq, ended.runEndSeq);
});

// --- 実行中インジケータの経過時間 ---

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

/** 圧縮中の payload。開始時刻は payload の compactionStartedAt だけを正とする */
function compactingPayload(): SessionPayload {
  return {
    ...runningPayload(),
    status: "compacting",
    compactionStartedAt: 1700000005000,
    run: null,
  };
}

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

test("圧縮中に届いた queued は compacting を維持し、文言も圧縮中として出す", () => {
  const compacting = chatReducer(initialChatState, { type: "resync", payload: compactingPayload() });
  const queued = chatReducer(compacting, { type: "queued", position: 1, queueDepth: 1 });

  assert.equal(queued.runStatus, "compacting");
  assert.equal(queued.compactionStartedAt, 1700000005000);
  assert.equal(queued.activity, "圧縮中…", "件数はコンポーザー直上のブロックが正なので状態行は活動の語だけ");
  assert.equal(queued.queueDepth, 1);

  // 圧縮でないときは従来どおり running
  const running = chatReducer(chatReducer(initialChatState, { type: "runStart", prompt: "p", at: 1, startedAt: 1 }), {
    type: "queued",
    position: 1,
    queueDepth: 1,
  });
  assert.equal(running.runStatus, "running");
  assert.equal(running.activity, "実行中…");
});

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

test("未送信へ切り替わる経路と再送は、前のランの所要時間を消す", () => {
  const ended = chatReducer(stateWithHistoryUser("run-h"), {
    type: "runEnd",
    runId: "run-h",
    status: "stopped",
    queueDepth: 0,
    durationMs: 80_000,
  });
  assert.equal(ended.bubbles[0]?.runDurationMs, 80_000);

  // 停止で待機キューを破棄した (queue_cleared)
  const cleared = chatReducer(ended, { type: "queueCleared", sendIds: ["run-h"] });
  assert.deepEqual(
    cleared.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );

  // payload が未送信として配った (再起動後)
  const payload = runningPayload();
  payload.sessionId = "session-a";
  payload.messages = [];
  payload.pendingSends = [{ sendId: "run-h", runId: "run-h", text: "履歴の本文", at: 1, state: "unsent" }];
  const unsent = chatReducer(ended, { type: "resync", payload });
  assert.deepEqual(
    unsent.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );

  // 再送は pending へ戻すときに古い値を消し、再送失敗でも戻さない
  const resent = chatReducer(unsent, { type: "resendUnsent", sendId: "run-h" });
  assert.deepEqual(
    resent.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[false, undefined, undefined]],
  );
  const failed = chatReducer(resent, { type: "resendFailed", sendId: "run-h" });
  assert.deepEqual(
    failed.bubbles.map((bubble) => [bubble.unsent === true, bubble.runDurationMs, bubble.runOutcome]),
    [[true, undefined, undefined]],
  );
});

// --- 待機キューの表示 (チップ / リング / 状態行) ---

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

/** 送信のエコーへ応答の run id と待機の順位 (queued の queueDepth) を結び付ける */
function queuedEcho(state: ChatState, text: string, runId: string, position?: number) {
  const echoed = chatReducer(state, { type: "localUser", text, at: 10 });
  return chatReducer(echoed, {
    type: "echoSendId",
    sendId: runId,
    runId,
    ...(position === undefined ? {} : { queuePosition: position }),
  });
}

/** 待機 / 実行中 / 未送信が並ぶ payload (status と queueDepth は呼び出し側が決める) */
function pendingPayload(
  pendingSends: PendingSend[],
  status: SessionPayload["status"] = "running",
  queueDepth = pendingSends.length,
) {
  const payload = runningPayload();
  payload.status = status;
  payload.queueDepth = queueDepth;
  payload.pendingSends = pendingSends;
  payload.messages = [];
  return payload;
}

test("送信応答が queued を返したら待機の表示になり、実行を始めた応答ではならない", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 2);
  const bubble = queued.bubbles.find((item) => item.runId === "run-b");
  assert.deepEqual([bubble?.queued, bubble?.queuePosition], [true, 2], "順位は応答の queueDepth");

  const direct = queuedEcho(initialChatState, "すぐ実行", "run-1");
  assert.equal(direct.bubbles.find((item) => item.runId === "run-1")?.queued, undefined);
});

test("run_start が応答より先に届いた run は、遅れて届いた queued の応答で待機中にしない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "待機する本文", at: 10 });
  const started = chatReducer(sent, {
    type: "runStart",
    runId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const assigned = chatReducer(started, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });

  assert.equal(assigned.bubbles.find((item) => item.runId === "run-b")?.queued, undefined);
  assert.equal(assigned.startingRunId, undefined, "開始の合図は run_start が立てる (応答では立てない)");
});

test("実行中に送ったエコーは配列の末尾に留まり、実行中ターンの本文は前のバブルへ積まれる", () => {
  // What: 送信のエコーで currentAssistantId を落とすと、次に届く delta がエコーより後ろへ新しいバブルを作り、
  // 実行に移った待機中の送信が実行中ターンの応答の途中に見える
  const running = chatReducer(initialChatState, { type: "runStart", prompt: "長いターン", at: 1, startedAt: 1 });
  const firstHalf = chatReducer(running, { type: "text", delta: "前半", at: 2 });
  const sent = chatReducer(firstHalf, { type: "localUser", text: "待機する本文", at: 3 });
  const queued = chatReducer(sent, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });
  const secondHalf = chatReducer(queued, { type: "text", delta: "後半", at: 4 });

  assert.deepEqual(
    secondHalf.bubbles.map((bubble) => [bubble.role, bubble.text, bubble.queued === true]),
    [
      ["user", "長いターン", false],
      ["assistant", "前半後半", false],
      ["user", "待機する本文", true],
    ],
    "応答は実行中のバブルへ続けて積み、待機中のエコーは末尾に留まる",
  );

  // 待機が実行に移ったら、その応答はエコーの後ろの新しいバブルになる
  const startedB = chatReducer(secondHalf, {
    type: "runStart",
    runId: "run-b",
    prompt: "待機する本文",
    at: 5,
    startedAt: 5,
  });
  assert.deepEqual(
    chatReducer(startedB, { type: "text", delta: "B の応答", at: 6 }).bubbles.map((bubble) => bubble.text),
    ["長いターン", "前半後半", "待機する本文", "B の応答"],
  );
});

test("実行中ターンの応答より前に積まれた待機は、実行に移った時点で末尾へ移る", () => {
  // What: 最初の delta より前に 2 通目を送ると、前のターンの応答が待機のエコーより後ろに作られる。
  // run_start で待機を末尾へ移さないと、実行に移った送信が前のターンの応答の途中に現れる
  let state = chatReducer(initialChatState, { type: "localUser", text: "A", at: 1 });
  state = chatReducer(state, { type: "runStart", runId: "run-a", prompt: "A", at: 2, startedAt: 2 });
  state = chatReducer(state, { type: "echoSendId", sendId: "run-a", runId: "run-a" });
  state = chatReducer(state, { type: "localUser", text: "B", at: 3 });
  state = chatReducer(state, { type: "echoSendId", sendId: "run-b", runId: "run-b", queuePosition: 1 });
  state = chatReducer(state, { type: "text", delta: "A の応答", at: 4 });
  state = chatReducer(state, { type: "runEnd", runId: "run-a", status: "completed", queueDepth: 1, durationMs: 1000 });

  // 待機中は transcript に出ないため、応答が後ろにあっても描画は [A, 応答] のまま
  assert.deepEqual(renderOrder(state), ["user:A", "assistant:A の応答"]);
  assert.deepEqual(
    state.bubbles.map((bubble) => `${bubble.role}:${bubble.text}`),
    ["user:A", "user:B", "assistant:A の応答"],
    "窓の中では待機のエコーより後ろに応答が積まれる",
  );

  const started = chatReducer(state, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "B",
    at: 5,
    startedAt: 5,
  });

  assert.deepEqual(
    renderOrder(started),
    ["user:A", "assistant:A の応答", "user:B"],
    "実行に移った送信は直前のターンの応答の後ろに現れる",
  );
  assert.deepEqual(
    started.bubbles.map((bubble) => `${bubble.role}:${bubble.text}`),
    ["user:A", "assistant:A の応答", "user:B"],
    "他のバブルの相対順は変えない",
  );
});

/** 描画の並び (`chatRenderItems`)。待機中の送信はここに現れない */
function renderOrder(state: ChatState): string[] {
  return chatRenderItems({ bubbles: state.bubbles, markers: [], compactions: [], activeContextStartId: null }).map(
    (item) => (item.kind === "message" ? `${item.bubble.role}:${item.bubble.text}` : item.kind),
  );
}

test("payload の pendingSends が待機と順位を配り、一覧から消えた run は待機を解除する", () => {
  const resynced = chatReducer(historyWithOld(), {
    type: "resync",
    payload: pendingPayload([
      { sendId: "run-a", runId: "run-a", text: "A", at: 1, state: "queued", position: 2 },
      { sendId: "run-b", runId: "run-b", text: "B", at: 2, state: "queued", position: 1 },
      { sendId: "run-c", runId: "run-c", text: "C", at: 3, state: "running" },
      { sendId: "run-d", runId: "run-d", text: "D", at: 4, state: "unsent" },
    ]),
  });
  assert.deepEqual(
    resynced.bubbles
      .filter((bubble) => bubble.runId !== undefined)
      .map((bubble) => [bubble.runId, bubble.queued === true, bubble.queuePosition, bubble.unsent === true]),
    [
      ["run-old", false, undefined, false],
      ["run-a", true, 2, false],
      ["run-b", true, 1, false],
      ["run-c", false, undefined, false],
      ["run-d", false, undefined, true],
    ],
    "待機だけが順位を持ち、実行中 / 未送信は持たない",
  );

  // 先頭が実行に移り entry が保存された (payload から消える)。古い順位を残さない
  const advanced = chatReducer(resynced, {
    type: "resync",
    payload: pendingPayload([{ sendId: "run-b", runId: "run-b", text: "B", at: 2, state: "queued", position: 1 }]),
  });
  assert.deepEqual(
    advanced.bubbles
      .filter((bubble) => bubble.runId === "run-a" || bubble.runId === "run-b")
      .map((bubble) => [bubble.runId, bubble.queued === true, bubble.queuePosition]),
    [
      ["run-a", false, undefined],
      ["run-b", true, 1],
    ],
  );
});

test("旧サーバー (pendingSends 無し) の resync は待機の表示を変えない", () => {
  const queued = queuedEcho(historyWithOld(), "待機する本文", "run-b", 2);
  const resynced = chatReducer(queued, { type: "resync", payload: runningPayload() });

  assert.deepEqual(
    resynced.bubbles
      .filter((bubble) => bubble.runId === "run-b")
      .map((bubble) => [bubble.queued === true, bubble.queuePosition]),
    [[true, 2]],
  );
});

test("run_start はその run の待機を解除し、開始の合図は状態イベントでは落とさない", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });

  assert.equal(started.startingRunId, "run-b");
  assert.equal(started.bubbles.find((bubble) => bubble.runId === "run-b")?.queued, undefined);

  // run_start の直後に届く状態イベントと同じ描画にまとまっても合図は残す。ここで落とすと
  // 演出が 1 フレームも出ない / 広がりが途中で切れる (tester の再現)
  assert.deepEqual(
    [
      chatReducer(started, { type: "status", state: "thinking", text: "考え中…" }),
      chatReducer(started, { type: "usage" }),
      chatReducer(started, { type: "toolStart", id: "t1", name: "read", args: "", at: 12 }),
      chatReducer(started, { type: "text", delta: "あ", at: 12 }),
    ].map((state) => state.startingRunId),
    ["run-b", "run-b", "run-b", "run-b"],
  );

  // リングの広がりの終端は DOM 側で受ける。演出が無いときに落としても状態は変えない
  assert.equal(chatReducer(started, { type: "startFlashEnd" }).startingRunId, undefined);
  assert.equal(chatReducer(initialChatState, { type: "startFlashEnd" }), initialChatState);
});

test("待機していない run_start では開始の合図を立てない", () => {
  const sent = chatReducer(initialChatState, { type: "localUser", text: "すぐ実行", at: 10 });
  const started = chatReducer(sent, { type: "runStart", runId: "run-1", prompt: "すぐ実行", at: 11, startedAt: 11 });

  assert.equal(started.startingRunId, undefined, "待機列の先頭が動いたときだけ光らせる");
});

test("run_end は残りの件数を数えず、開始の合図とその run の待機を落とす", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const ended = chatReducer(started, {
    type: "runEnd",
    runId: "run-b",
    status: "completed",
    queueDepth: 2,
    durationMs: 1000,
  });

  assert.equal(ended.startingRunId, undefined);
  assert.equal(ended.runStatus, "queued");
  assert.equal(ended.activity, "完了", "件数は直上ブロックが正。状態行は活動の語だけ");

  // 実行されなかった待機は run_end では消さない (次の実行の開始送信になる)。停止は queue_cleared が担う
  const interrupted = chatReducer(queued, { type: "runEnd", runId: "run-b", status: "stopped", queueDepth: 0 });
  assert.equal(interrupted.bubbles.find((bubble) => bubble.sendId === "run-b")?.queued, true);
  const cleared = chatReducer(interrupted, { type: "queueCleared", sendIds: ["run-b"] });
  assert.equal(cleared.bubbles.find((bubble) => bubble.sendId === "run-b")?.queued, undefined);
});

test("queue_cleared は待機の表示を消し、runIds が無くても解除する", () => {
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const cleared = chatReducer(queued, { type: "queueCleared", sendIds: ["run-b"] });
  assert.deepEqual(
    cleared.bubbles
      .filter((bubble) => bubble.runId === "run-b")
      .map((bubble) => [bubble.queued, bubble.queuePosition, bubble.unsent === true]),
    [[undefined, undefined, true]],
  );
  assert.equal(cleared.startingRunId, undefined);

  // 旧サーバー (runIds 無し) は未送信へは切り替えないが、キューは空なので待機の表示は戻す
  const legacy = chatReducer(queued, { type: "queueCleared" });
  assert.deepEqual(
    legacy.bubbles
      .filter((bubble) => bubble.runId === "run-b")
      .map((bubble) => [bubble.queued, bubble.unsent === true]),
    [[undefined, false]],
  );
});

test("queueCanceled は対象の待機だけを未送信へ戻し、他の待機を変えない", () => {
  const queued = queuedEcho(queuedEcho(historyWithOld(), "先に積む本文", "run-a", 1), "取り消す本文", "run-b", 2);
  const waiting = chatReducer(queued, { type: "queued", position: 2, queueDepth: 2 });
  const keptEchoId = waiting.bubbles.find((bubble) => bubble.runId === "run-a")?.id;
  const target = waiting.bubbles.find((bubble) => bubble.runId === "run-b");
  assert.ok(keptEchoId !== undefined && target !== undefined);
  assert.deepEqual(waiting.pendingEchoIds, [keptEchoId, target.id], "待機中のエコーは履歴への吸収を待つ");

  const canceled = chatReducer(waiting, { type: "queueCanceled", sendId: "run-b" });
  assert.deepEqual(
    canceled.bubbles.map((bubble) => [
      bubble.runId,
      bubble.queued === true,
      bubble.queuePosition,
      bubble.unsent === true,
      bubble.accepted === true,
      bubble.confirmed === true,
    ]),
    [
      ["run-old", false, undefined, false, false, false],
      ["run-a", true, 1, false, false, false],
      ["run-b", false, undefined, true, false, false],
    ],
    "取り消した送信だけが未送信になり、他の待機と順位はそのまま",
  );
  assert.deepEqual(canceled.pendingEchoIds, [keptEchoId], "未送信は吸収待ちに残さない (再送で同じ id を二重にしない)");
  assert.equal(canceled.queueDepth, 2, "件数はサーバーの payload が正で、ローカルでは減らさない");
  assert.equal(canceled.activity, waiting.activity, "成功時の文言は足さない (バブルが変わるのが結果の提示)");

  // resync が成功応答より先に届く経路がある。既に未送信なら状態を作り直さない
  assert.equal(chatReducer(canceled, { type: "queueCanceled", sendId: "run-b" }), canceled);
  assert.equal(
    chatReducer(canceled, { type: "queueCanceled", sendId: "ghost" }),
    canceled,
    "未知の run id では何もしない",
  );
});

test("resync の status === queued は件数も理由も状態行に出さず、run の実行中では開始の合図を残す", () => {
  // What: run が無くキューだけの過渡で語れる事実は直上ブロックの件数だけなので、活動の文言は空にする
  const waiting = chatReducer(historyWithOld(), { type: "resync", payload: pendingPayload([], "queued", 2) });
  assert.equal(waiting.runStatus, "queued");
  assert.equal(waiting.activity, "");

  // 開始直後の復帰。payload が同じ run の実行中を示す間は演出を残す (初回描画で消さない)
  const queued = queuedEcho(initialChatState, "待機する本文", "run-b", 1);
  const started = chatReducer(queued, {
    type: "runStart",
    runId: "run-b",
    initialSendId: "run-b",
    prompt: "待機する本文",
    at: 11,
    startedAt: 11,
  });
  const sameRun = chatReducer(started, {
    type: "resync",
    payload: {
      ...pendingPayload([], "running", 0),
      // payload が同じ run を実行中として載せる (resync 経路の開始の合図)
      run: { id: "run-b", status: "running", startedAt: 11, prompt: "待機する本文", toolCalls: [], totalRetryCount: 0 },
    },
  });
  assert.equal(sameRun.startingRunId, "run-b");

  // 別の run へ移った / run が終わった復帰では残さない
  const ended = chatReducer(sameRun, { type: "resync", payload: pendingPayload([], "idle", 0) });
  assert.equal(ended.startingRunId, undefined);
});

test("pendingSends の steering は待機のまま反映中として持ち、running は待機一覧から外す", () => {
  // What: SDK が取り出した入力 (steering) は取消できず、注入済み (running) は待機に出さない
  const payload = runningPayload();
  payload.pendingSends = [
    { sendId: "send-q", text: "待機", at: 1, state: "queued", position: 1 },
    { sendId: "send-s", text: "反映中", at: 2, state: "steering", position: 2 },
    { sendId: "send-r", text: "実行中", at: 3, runId: "run-1", state: "running" },
  ];
  const state = chatReducer(initialChatState, { type: "resync", payload });
  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuedState, bubble.queuePosition]),
    [
      ["send-q", true, "queued", 1],
      ["send-s", true, "steering", 2],
      ["send-r", false, undefined, undefined],
    ],
  );
});

test("要求後に新しい状態が届いた待機スナップショットは queued へ戻さない", () => {
  // What: 後着の 202 が、終端 resync で注入・保存済みになった送信を再び待機中に見せる退行を防ぐ
  // (履歴対応済みの会話では resync 後もライブのエコーを残すため、sendId の対応付けだけが残る)
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "追加入力", at: 1 });
  const requestSeq = sent.stateSeq;
  const payload = runningPayload();
  payload.status = "completed";
  payload.queueDepth = 0;
  payload.pendingSends = [];
  const ended = chatReducer(sent, { type: "resync", payload });
  assert.ok(ended.stateSeq !== requestSeq, "resync で世代が進む");

  const late = chatReducer(ended, {
    type: "echoSendId",
    sendId: "send-late",
    stateSeq: requestSeq,
    queuePosition: 1,
  });
  assert.deepEqual(
    late.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuePosition]),
    [["send-late", false, undefined]],
    "ID は対応付けるが、古い待機スナップショットは適用しない",
  );

  // 世代が一致していれば (要求後に新しい状態が届いていなければ) 待機として適用する
  const current = chatReducer(ended, {
    type: "echoSendId",
    sendId: "send-current",
    stateSeq: ended.stateSeq,
    queuePosition: 1,
  });
  assert.deepEqual(
    current.bubbles
      .filter((bubble) => bubble.sendId !== undefined)
      .map((bubble) => [bubble.sendId, bubble.queued === true, bubble.queuePosition]),
    [["send-current", true, 1]],
  );
});

test("queued が 202 応答より先に届いても、同じ送信IDの待機位置をエコーへ引き継ぐ", () => {
  // What: 送信IDの結び付く前の queued で世代が進んでも、応答が待機スナップショットを捨てない
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const requestSeq = sent.stateSeq;
  const queued = chatReducer(sent, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });
  const echoed = chatReducer(queued, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: requestSeq,
    queuePosition: 1,
  });

  assert.deepEqual(
    queuedSendsOf(echoed.bubbles).map((send) => [send.sendId, send.text, send.state, send.index]),
    [["send-1", "待機する本文", "queued", undefined]],
    "待機 1 件・順位 1 として取消の対象になる",
  );
  assert.equal(echoed.queueDepth, 1);
  assert.equal(
    chatRenderItems({ bubbles: echoed.bubbles, markers: [], compactions: [], activeContextStartId: null }).some(
      (item) => item.kind === "message" && item.bubble.text === "待機する本文",
    ),
    false,
    "待機中は transcript に出さない",
  );
  assert.equal(echoed.queuedSnapshots["send-1"], undefined, "引き継いだスナップショットは残さない");
});

test("echo が queued より先でも最終状態は同じで、同じ送信IDの queued を重複させない", () => {
  // What: 応答→queued の順と、queued が 2 回届く経路でも待機表示が 1 件に収まる
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const echoed = chatReducer(sent, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: sent.stateSeq,
    queuePosition: 1,
  });
  const queued = chatReducer(echoed, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });
  const duplicated = chatReducer(queued, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });

  assert.deepEqual(
    queuedSendsOf(duplicated.bubbles).map((send) => [send.sendId, send.state, send.index]),
    [["send-1", "queued", undefined]],
  );
  assert.equal(duplicated.bubbles.filter((bubble) => bubble.sendId === "send-1").length, 1);
  assert.equal(duplicated.queueDepth, 1, "件数は累積しない");
  assert.equal(duplicated.queuedSnapshots["send-1"], undefined, "結び付いた後はスナップショットを持たない");
});

test("送信IDが結び付く前の queued も、注入・保存を示す新しい resync で捨てる", () => {
  // What: 先行した待機イベントが、その後の注入・保存を巻き戻さない (前回の後着 202 と同方向)
  const sent = chatReducer(historyWithOld(), { type: "localUser", text: "待機する本文", at: 1 });
  const requestSeq = sent.stateSeq;
  const queued = chatReducer(sent, { type: "queued", sendId: "send-1", position: 1, queueDepth: 1 });

  const payload = runningPayload();
  payload.status = "running";
  payload.queueDepth = 0;
  payload.pendingSends = [];
  const injected = chatReducer(queued, { type: "resync", payload });
  assert.equal(injected.queuedSnapshots["send-1"], undefined, "resync が待機を否定したら捨てる");

  const late = chatReducer(injected, {
    type: "echoSendId",
    sendId: "send-1",
    stateSeq: requestSeq,
    queuePosition: 1,
  });
  assert.deepEqual(queuedSendsOf(late.bubbles), [], "古い待機スナップショットで queued に戻さない");
  assert.equal(late.bubbles.find((bubble) => bubble.sendId === "send-1")?.queued, undefined);
});

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
      ["work-a", undefined],
      ["work-b", undefined],
    ],
    "live は本文 item が無いので 1 枚の host に溜める",
  );
  assert.equal(
    new Set(live.bubbles.filter((bubble) => bubble.tools.length > 0).map((bubble) => bubble.id)).size,
    1,
    "ツールごとに assistant バブルを作らない",
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

test("操作の結果 (notice) は応答や同じ会話の resync では消えず、操作の開始と会話の切替で消える", () => {
  // What: 取り消しの失敗理由などを活動文言とは別に持ち、後続の status / resync の活動文言に
  // 上書きされないこと、保持を解く契機を固定する。解除は「利用者の操作の開始 (clearNotice)」と
  // 「会話の切替」だけで、送信のエコー (localUser) や応答 (setRun / queueCanceled) では消さない
  // (先に始めた要求の後着応答が、後から出た別の結果を消す経路を閉じる)
  const resynced = chatReducer(initialChatState, { type: "resync", payload: runningPayload() });
  const noticed = chatReducer(resynced, { type: "notice", text: "待機中のメッセージが見つかりません" });

  const statused = chatReducer(noticed, { type: "status", state: "thinking", text: "考え中…" });
  assert.equal(statused.activity, "考え中…", "活動文言は活動行のまま更新する");
  assert.equal(statused.notice, "待機中のメッセージが見つかりません");

  const resyncedAgain = chatReducer(statused, { type: "resync", payload: runningPayload() });
  assert.equal(resyncedAgain.notice, "待機中のメッセージが見つかりません", "同じ会話の取り直しでは残す");

  const ended = chatReducer(resyncedAgain, { type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(ended.activity, "完了");
  assert.equal(ended.notice, "待機中のメッセージが見つかりません", "終端の活動文言でも消さない");

  // 応答・エコー (取消より前に始めた要求の後着) では消さない
  const echoed = chatReducer(ended, { type: "localUser", text: "先に押していた送信", at: 1700000000003 });
  assert.equal(echoed.notice, "待機中のメッセージが見つかりません", "先行要求のエコーで消さない");
  const responded = chatReducer(echoed, { type: "setRun", runStatus: "running", activity: "実行中…" });
  assert.equal(responded.notice, "待機中のメッセージが見つかりません", "先行要求の応答で消さない");

  const cleared = chatReducer(responded, { type: "clearNotice" });
  assert.equal(cleared.notice, undefined, "操作の開始で用済みにする");
  assert.equal(cleared.activity, "実行中…", "解除しても活動文言は触らない");

  const switched = chatReducer(chatReducer(cleared, { type: "notice", text: "待機中のメッセージが見つかりません" }), {
    type: "resync",
    payload: { ...runningPayload(), sessionId: "session-b", piSessionId: "pi-session-b" },
  });
  assert.equal(switched.sessionId, "session-b");
  assert.equal(switched.notice, undefined, "会話を切り替えたら残さない");
});
