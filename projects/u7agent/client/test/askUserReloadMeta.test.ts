// 本文なし・未回答の ask_user カードのメタ行 (時刻 / 応答時間) が、再読み込み・SSE 再接続でも
// 元の応答の値で残ることを固定する。DOM 基盤が無いため react-dom/server の静的描画で確認する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import { chatReducer, initialChatState, type Bubble, type ChatState, type ToolCard } from "../src/hooks/chatReducer";
import { isPendingAskUserCard, pendingAskUserQuestionCount } from "../src/lib/askUser";
import { chatRenderItems } from "../src/lib/chatItems";
import type { TurnEnd } from "../src/lib/turnEnd";
import type {
  AskUserQuestion,
  AssistantMeta,
  HistoryPage,
  RunPayload,
  SessionPayload,
  ToolCall,
  Usage,
} from "../src/types";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

const QUESTIONS: AskUserQuestion[] = [
  { question: "どちらで進めますか", header: "方式", options: [{ label: "A 案" }, { label: "B 案" }] },
  { question: "補足はありますか", type: "text" },
];
const OWNER = "run-1:1";
const OTHER = "run-1:2";
const ASKED_AT = 1_700_000_000_000;
const USAGE: Usage = {
  input: 1200,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1240,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const METRICS = { durationMs: 850 };

function askCall(id: string, assistantId?: string): ToolCall {
  return {
    id,
    ...(assistantId === undefined ? {} : { assistantId }),
    name: "ask_user",
    args: "{}",
    isError: false,
    done: false,
    output: "",
    questions: QUESTIONS,
    startedAt: 1,
  };
}

function runPayload(toolCalls: ToolCall[], startedAt = 1): RunPayload {
  return { id: "run-1", status: "running", startedAt, prompt: "質問して", toolCalls, totalRetryCount: 0 };
}

function payload(
  messages: SessionPayload["messages"],
  payloadRun: RunPayload | null,
  options: { assistantMeta?: AssistantMeta[]; serverNow?: number } = {},
): SessionPayload {
  return {
    sessionId: "s-1",
    piSessionId: "pi-s-1",
    cwd: "",
    eventGeneration: "gen-1",
    status: "running",
    title: "",
    createdAt: 1,
    lastUsedAt: 1,
    serverNow: options.serverNow ?? 1,
    queueDepth: 0,
    pinned: false,
    lastSeq: 3,
    run: payloadRun,
    messages,
    ...(options.assistantMeta === undefined ? {} : { assistantMeta: options.assistantMeta }),
    compactions: [],
  };
}

/** 回答待ちのカードを持つ合成バブルの描画 item (ライブ / 復元のどちらも同じ経路で引く) */
function askItem(state: ChatState): { bubble: Bubble; turnEnd?: TurnEnd } {
  const item = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).find(
    (candidate) =>
      candidate.kind === "message" && candidate.bubble.tools.some((card) => (card.questions?.length ?? 0) > 0),
  );
  assert.ok(item?.kind === "message", "回答待ちカードのバブルがある");
  return { bubble: item.bubble, ...(item.turnEnd === undefined ? {} : { turnEnd: item.turnEnd }) };
}

function askCards(state: ChatState): ToolCard[] {
  return state.bubbles.flatMap((bubble) => bubble.tools.filter((card) => (card.questions?.length ?? 0) > 0));
}

function renderMessage(bubble: Bubble, options: { singleColumn?: boolean; turnEnd?: TurnEnd } = {}): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(MessageView, {
        bubble,
        skillBadges: [],
        copied: false,
        singleColumn: options.singleColumn ?? false,
        rootCwd: "/workspace",
        onCopy: () => {},
        copiedId: "",
        copyFailure: () => undefined,
        onCopyTool: () => {},
        copiedAll: false,
        onCopyAll: () => {},
        answerable: true,
        onAnswerQuestion: async () => ({ ok: true as const }),
        ...(options.turnEnd === undefined ? {} : { turnEnd: options.turnEnd }),
      }),
    ),
  );
}

function historyPage(messageCount: number): HistoryPage {
  return {
    sessionId: "s-1",
    items: [{ kind: "message", id: "m1", context: "active", role: "user", text: "質問して" }],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "m1",
    messageCount,
    summarizedMessageCount: 0,
  };
}

/** live の質問カード (本文なし応答 → usage → ツール開始 → 回答待ち) */
function liveState(): ChatState {
  let state = chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    prompt: "質問して",
    at: 1,
    startedAt: 1,
  });
  state = chatReducer(state, { type: "usage", assistantId: OWNER, usage: USAGE, metrics: METRICS });
  state = chatReducer(state, { type: "assistantEnd", assistantId: OWNER });
  return chatReducer(state, {
    type: "toolStart",
    id: "call-1",
    assistantId: OWNER,
    name: "ask_user",
    args: "{}",
    questions: QUESTIONS,
    startedAt: 1,
    at: 2,
  });
}

test("本文なし・未回答の ask_user は再読み込み後も元の応答の時刻と応答時間を出す", () => {
  const liveHtml = renderMessage(askItem(liveState()).bubble);
  assert.match(liveHtml, /850ms/);

  const reload = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
    }),
  });
  const restored = askItem(reload);
  assert.equal(restored.bubble.at, ASKED_AT, "再読み込み時刻ではなく元の応答の時刻を使う");
  const reloadHtml = renderMessage(restored.bubble);
  assert.ok(
    reloadHtml.includes(`dateTime="${new Date(ASKED_AT).toISOString()}"`),
    "live が持っていた時刻を復元側でも出す",
  );
  assert.match(reloadHtml, /850ms/, "live が持っていた応答時間を復元側でも出す");

  // SSE 再接続の resync でも、作り直したバブルが同じ値を持つ
  const reconnected = chatReducer(reload, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
      serverNow: 90_000,
    }),
  });
  const reconnectedItem = askItem(reconnected);
  assert.equal(reconnectedItem.bubble.at, ASKED_AT);
  assert.match(renderMessage(reconnectedItem.bubble), /850ms/);
});

test("回答待ちが延びても応答時間は増えず、別の応答の値を流用しない", () => {
  const assistantMeta: AssistantMeta[] = [
    { assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS },
    { assistantId: OTHER, at: ASKED_AT + 5000, usage: { ...USAGE, input: 7 }, metrics: { durationMs: 9999 } },
  ];
  const waiting = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)], 1), {
      assistantMeta,
      serverNow: 2,
    }),
  });
  assert.equal(askItem(waiting).bubble.metrics?.durationMs, 850);
  assert.equal(askItem(waiting).bubble.usage?.input, 1200, "同じ応答の usage を写す");

  // 同じペイロードで時間だけが進んだ再接続 (回答待ちが延びた状態)
  const later = chatReducer(waiting, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)], 1), {
      assistantMeta,
      serverNow: 10_000_000,
    }),
  });
  assert.equal(askItem(later).bubble.metrics?.durationMs, 850, "回答待ちの時間を応答時間へ足さない");
  const html = renderMessage(askItem(later).bubble);
  assert.match(html, /850ms/);
  assert.doesNotMatch(html, /10\.0s|9\.9s/, "別の応答の値は出さない");
});

test("値の無い項目は出さず、メタ情報を持たない旧 payload でも壊れない", () => {
  // 旧サーバーの payload (assistantMeta が無い)。カードは復帰するが時刻・応答時間は作らない
  const legacy = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)])),
  });
  const legacyItem = askItem(legacy);
  assert.equal(legacyItem.bubble.at, undefined);
  assert.equal(legacyItem.bubble.metrics, undefined);
  const legacyHtml = renderMessage(legacyItem.bubble);
  assert.doesNotMatch(legacyHtml, /<time /, "値の無い時刻を再読み込み時刻で埋めない");
  assert.doesNotMatch(legacyHtml, /ms</, "値の無い応答時間を 0 で埋めない");

  // 時刻を持たない履歴でも、値のある応答時間だけは出す
  const metricsOnly = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, metrics: METRICS }],
    }),
  });
  const metricsItem = askItem(metricsOnly);
  const metricsHtml = renderMessage(metricsItem.bubble);
  assert.doesNotMatch(metricsHtml, /<time /, "値の無い時刻は出さない");
  assert.match(metricsHtml, /850ms/, "値のある応答時間は出す");

  // desktop はトークン数も並べ、singleColumn は応答時間だけを出す (既存の出し分け)
  const wide = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
    }),
  });
  const wideHtml = renderMessage(askItem(wide).bubble);
  const narrowHtml = renderMessage(askItem(wide).bubble, { singleColumn: true });
  assert.match(wideHtml, /↑1\.2k ↓40/);
  assert.match(narrowHtml, /850ms/);
  assert.doesNotMatch(narrowHtml, /↑|↓/, "singleColumn はトークン数を出さない");
});

test("復元したカードは 1 枚・所有者は同じ・回答可能のまま", () => {
  const state = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
    }),
  });
  assert.equal(askCards(state).length, 1);
  assert.equal(askCards(state)[0]?.id, "call-1");
  assert.equal(isPendingAskUserCard(askCards(state)[0] as ToolCard), true, "質問は回答できる");
  assert.equal(pendingAskUserQuestionCount(state.runTools, state.runStatus), QUESTIONS.length);
  assert.equal(askItem(state).bubble.assistantId, OWNER, "所有者は元の応答のまま");

  const again = chatReducer(state, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
    }),
  });
  assert.equal(askCards(again).length, 1, "再接続でカードを増やさない");
  assert.equal(askItem(again).bubble.tools.length, 1);
  assert.equal(askItem(again).bubble.assistantId, OWNER);
});

test("復元したカードは履歴の件数・ページ境界を変えず、Done / Stopped を付けない", () => {
  const reload = chatReducer(initialChatState, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
    }),
  });
  const merged = chatReducer(reload, { type: "resyncHistory", page: historyPage(1) });
  assert.equal(merged.history.messageCount, 1, "履歴の件数はページの値のまま");
  assert.deepEqual(
    merged.bubbles.map((bubble) => bubble.entryId),
    ["m1", undefined],
    "本文なしの応答を履歴 item として増やさない",
  );
  const item = askItem(merged);
  assert.equal(item.turnEnd, undefined, "本文なしカードにターンの結末を付けない");
  const html = renderMessage(item.bubble, item.turnEnd === undefined ? {} : { turnEnd: item.turnEnd });
  assert.doesNotMatch(html, /Done ·|Stopped ·/);

  // 最新ページの適用後に SSE 再接続の resync が来ても、同じカード 1 枚とメタ行を保つ
  const reconnected = chatReducer(merged, {
    type: "resync",
    payload: payload([{ role: "user", text: "質問して" }], runPayload([askCall("call-1", OWNER)]), {
      assistantMeta: [{ assistantId: OWNER, at: ASKED_AT, usage: USAGE, metrics: METRICS }],
      serverNow: 90_000,
    }),
  });
  assert.equal(reconnected.history.messageCount, 1);
  assert.equal(askCards(reconnected).length, 1);
  const reconnectedItem = askItem(reconnected);
  assert.equal(reconnectedItem.bubble.at, ASKED_AT);
  assert.match(renderMessage(reconnectedItem.bubble), /850ms/);
});
