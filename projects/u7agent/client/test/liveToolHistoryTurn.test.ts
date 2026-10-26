// ライブのツール履歴をターン単位にまとめる回帰テスト。
//
// 確定履歴の投影は本文を持たない応答のツールを「同ターンの次の表示可能な本文 item」へ繰り上げる。
// ライブも同じ境界でまとめないと、ストリーム中はツールごとに assistant バブルとヘッダーが並び、
// 終了後に 1 ヘッダーへ入れ替わる (位置・件数・プレビューが動く)。ここでは reducer の turn host と、
// ライブ中 / 確定後でヘッダーが 1 つ・同件数・同内容になることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolHistoryView } from "../src/components/chat/ToolHistory";
import { chatReducer, initialChatState, type Bubble, type ChatState, type ToolCard } from "../src/hooks/chatReducer";
import { chatRenderItems } from "../src/lib/chatItems";
import { isToolHostBubble } from "../src/lib/chatTypes";
import { completedToolCards, historyPreview } from "../src/lib/toolSummary";
import type { HistoryPage, MessageMetrics, RunPayload, SessionPayload, Usage } from "../src/types";

const USAGE: Usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const METRICS: MessageMetrics = { durationMs: 900 };

function startRun(): ChatState {
  return chatReducer(initialChatState, {
    type: "runStart",
    runId: "run-1",
    initialSendId: "send-1",
    prompt: "調べて",
    at: 10,
    startedAt: 10,
  });
}

/** 本文を持たない応答 1 通ぶんのイベント (usage → assistant_end → toolStart → toolEnd) */
function bodylessTool(state: ChatState, seq: number, options: { id?: string; end?: boolean } = {}): ChatState {
  const id = options.id ?? `tool-${seq}`;
  const assistantId = `run-1:${seq}`;
  let next = chatReducer(state, { type: "usage", assistantId, usage: USAGE, metrics: METRICS });
  next = chatReducer(next, { type: "assistantEnd", assistantId });
  next = chatReducer(next, {
    type: "toolStart",
    id,
    name: "bash",
    args: `$ step ${seq}`,
    at: 20 + seq,
    startedAt: 20 + seq,
    assistantId,
  });
  if (options.end === false) return next;
  return chatReducer(next, { type: "toolEnd", id, isError: false, output: `out ${seq}`, endedAt: 30 + seq });
}

type CardOwner = { bubbleId: number; assistantId: string | undefined; entryId: string | undefined; card: ToolCard };

function cardsOf(state: ChatState): CardOwner[] {
  return state.bubbles.flatMap((bubble) =>
    bubble.tools.map((card) => ({
      bubbleId: bubble.id,
      assistantId: bubble.assistantId,
      entryId: bubble.entryId,
      card,
    })),
  );
}

function toolBubbles(state: ChatState): Bubble[] {
  return state.bubbles.filter((bubble) => bubble.role === "assistant" && bubble.tools.length > 0);
}

/** 進行中のターンで見えるヘッダー (実行中の行は状態行が受け持つので数えない) */
function liveHeader(state: ChatState): { count: number; preview: string; bubbles: number } {
  const items = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
    liveTurn: true,
  }).filter((item) => item.kind === "message");
  const cards = items.flatMap((item) =>
    item.kind === "message" && item.bubble.role === "assistant" ? completedToolCards(item.bubble.tools) : [],
  );
  const shownBubbles = items.filter(
    (item) =>
      item.kind === "message" && item.bubble.role === "assistant" && completedToolCards(item.bubble.tools).length > 0,
  );
  return { count: cards.length, preview: historyPreview(cards), bubbles: shownBubbles.length };
}

/** 確定後のヘッダー (live を落としただけ。完了していないカードも並べる) */
function settledHeader(state: ChatState): { count: number; preview: string; bubbles: number } {
  const items = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
  }).filter((item) => item.kind === "message");
  const cards = items.flatMap((item) =>
    item.kind === "message" && item.bubble.role === "assistant" ? item.bubble.tools : [],
  );
  const shownBubbles = items.filter(
    (item) => item.kind === "message" && item.bubble.role === "assistant" && item.bubble.tools.length > 0,
  );
  return { count: cards.length, preview: historyPreview(cards), bubbles: shownBubbles.length };
}

function renderHistory(cards: ToolCard[], live: boolean): string {
  return renderToStaticMarkup(
    createElement(ToolHistoryView, {
      cards,
      hasResponse: false,
      live,
      copiedId: "",
      copyFailure: () => undefined,
      copiedAll: false,
      onCopyAll: () => {},
      singleColumn: false,
      onCopyTool: () => {},
    }),
  );
}

/** ヘッダー (summary) のテキストだけを読む。本文の有無で位置が動かないことを比べる */
function headerText(html: string): string {
  const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
  return summary
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function idlePayload(messageCount: number): SessionPayload {
  return {
    sessionId: "session-a",
    piSessionId: "pi-session-a",
    cwd: "",
    eventGeneration: "gen-1",
    model: "stub/stub-model",
    thinkingLevel: "high",
    supportsThinking: true,
    availableThinkingLevels: ["off", "low", "high"],
    status: "idle",
    title: "調べて",
    createdAt: 1,
    lastUsedAt: 2,
    serverNow: 2,
    queueDepth: 0,
    pinned: false,
    lastSeq: 7,
    run: null,
    messages: [{ role: "user", text: "調べて", sendId: "send-1", runId: "run-1" }],
    compactions: [],
    ...(messageCount > 1 ? {} : {}),
  };
}

function completedRun(toolIds: string[]): RunPayload {
  return {
    id: "run-1",
    initialSendId: "send-1",
    status: "completed",
    startedAt: 10,
    endedAt: 60,
    prompt: "調べて",
    toolCalls: toolIds.map((id, index) => ({
      id,
      assistantId: `run-1:${index + 1}`,
      name: "bash",
      args: `$ step ${index + 1}`,
      isError: false,
      done: true,
      output: `out ${index + 1}`,
      startedAt: 20 + index,
      endedAt: 30 + index,
    })),
    totalRetryCount: 0,
  };
}

test("3ツールの間に assistant_end が入っても、ライブは 1 枚の host に積み、assistant バブルを増やさない", () => {
  // What: 本文を持たない応答 A → B → C のツールが、完了するたびに同じ host の見出しへ 1件 → 2件 → 3件 と
  // 増え、ツールごとの assistant バブル (アバター) やメトリクスが現れない
  let state = startRun();
  const counts: number[] = [];
  for (const seq of [1, 2, 3]) {
    state = bodylessTool(state, seq);
    counts.push(liveHeader(state).count);
    assert.equal(toolBubbles(state).length, 1, `${seq}件目: ツールを抱えるカードは 1 枚だけ`);
    assert.equal(state.bubbles.filter((bubble) => bubble.role === "assistant").length, 1, "バブルも増やさない");
    assert.equal(liveHeader(state).bubbles, 1, "ヘッダーも 1 つ");
  }
  assert.deepEqual(counts, [1, 2, 3], "完了した分だけ見出しの件数が増える");

  const [host] = toolBubbles(state);
  assert.equal(isToolHostBubble(host), true, "本文 item が現れるまではツールだけの host");
  assert.deepEqual(
    host.tools.map((card) => card.id),
    ["tool-1", "tool-2", "tool-3"],
  );
  assert.equal(host.usage, undefined, "per-tool の usage を host に写さない");
  assert.equal(host.metrics, undefined, "per-tool のメトリクスを host に写さない");
  assert.equal(state.pendingUsage, undefined, "次の本文 item へ持ち越さない");

  // 実行中のカードは状態行が受け持ち、ヘッダーには数えない (完了するまで見出しも出さない)
  const running = bodylessTool(startRun(), 1, { id: "run-tool", end: false });
  assert.equal(liveHeader(running).count, 0, "実行中のカードは数えない");
  assert.equal(liveHeader(running).bubbles, 0, "完了分が無い間は空のアシスタントバブルを出さない");
});

test("run_end はライブの印を落とすだけで、ヘッダーの位置・件数・プレビューを変えない", () => {
  let live = startRun();
  for (const seq of [1, 2, 3]) live = bodylessTool(live, seq);
  const before = liveHeader(live);
  const [host] = toolBubbles(live);
  const position = live.bubbles.findIndex((bubble) => bubble.id === host.id);

  const settled = chatReducer(live, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  const after = settledHeader(settled);
  const [settledHost] = toolBubbles(settled);
  assert.equal(settledHost.id, host.id, "同じバブル (同じ DOM の位置) のまま確定する");
  assert.equal(settledHost.settled, true);
  assert.equal(isToolHostBubble(settledHost), false, "確定したら host の印を外す");
  assert.deepEqual(
    settledHost.tools.map((card) => card.id),
    ["tool-1", "tool-2", "tool-3"],
    "カードを移さない",
  );
  assert.equal(
    settled.bubbles.findIndex((bubble) => bubble.id === host.id),
    position,
    "並び順も変えない",
  );
  assert.deepEqual(after, before, "件数・プレビュー・ヘッダーの数が変わらない");
});

test("次の本文 item が届くと、host のカードは同じバブルのまま本文 item にまとまる", () => {
  // What: ツールだけの応答の後で本文が届いても、assistant バブルは増えず (ヘッダーが動かず)、
  // 確定履歴では本文 item が同じツールを持つ
  let live = startRun();
  for (const seq of [1, 2, 3]) live = bodylessTool(live, seq);
  const [host] = toolBubbles(live);
  const before = liveHeader(live);

  live = chatReducer(live, { type: "usage", assistantId: "run-1:4", usage: USAGE, metrics: METRICS });
  live = chatReducer(live, { type: "text", delta: "調べました", at: 40, assistantId: "run-1:4" });
  const adopted = live.bubbles.find((bubble) => bubble.id === host.id);
  assert.equal(adopted?.text, "調べました");
  assert.equal(adopted?.assistantId, "run-1:4", "host がそのまま本文 item になる");
  assert.deepEqual(
    adopted?.tools.map((card) => card.id),
    ["tool-1", "tool-2", "tool-3"],
  );
  assert.equal(live.bubbles.filter((bubble) => bubble.role === "assistant").length, 1, "バブルを増やさない");
  assert.deepEqual(liveHeader(live), before, "件数・プレビュー・ヘッダーの数が変わらない");

  const settled = chatReducer(live, {
    runId: "run-1",
    type: "runEnd",
    status: "completed",
    queueDepth: 0,
    durationMs: 3000,
  });
  const after = settledHeader(settled);
  assert.equal(after.count, before.count);
  assert.equal(after.preview, before.preview);

  // 確定履歴 (本文 item に繰り上げた投影) と重ねても、各 call は 1 枚だけ・同じ item に残る
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "調べて",
        sendId: "send-1",
        runId: "run-1",
      },
      {
        kind: "message",
        id: "a-a1",
        context: "active",
        role: "assistant",
        text: "調べました",
        assistantId: "run-1:4",
        tools: completedRun(["tool-1", "tool-2", "tool-3"]).toolCalls,
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const merged = chatReducer(settled, { type: "resyncHistory", page });
  assert.deepEqual(
    cardsOf(merged).map(({ card, entryId }) => [card.id, entryId]),
    [
      ["tool-1", "a-a1"],
      ["tool-2", "a-a1"],
      ["tool-3", "a-a1"],
    ],
    "履歴 item が同じ 3 枚を持つ (重複しない)",
  );

  // 再読み込みも同じ形になる
  const reloaded = chatReducer(chatReducer(initialChatState, { type: "resync", payload: idlePayload(1) }), {
    type: "resyncHistory",
    page,
  });
  assert.deepEqual(
    cardsOf(reloaded).map(({ card, entryId }) => [card.id, entryId]),
    cardsOf(merged).map(({ card, entryId }) => [card.id, entryId]),
    "live と再読み込みで持ち主が一致する",
  );
});

test("ライブ中と確定後でヘッダーの件数・合計・プレビューが一致する (DOM)", () => {
  let live = startRun();
  for (const seq of [1, 2, 3]) live = bodylessTool(live, seq);
  const [host] = toolBubbles(live);
  const liveHtml = renderHistory(host.tools, true);
  const settledHtml = renderHistory(host.tools, false);

  assert.ok(liveHtml.includes("ツール履歴"), "ライブ中も見出しを出す");
  assert.equal(headerText(liveHtml), headerText(settledHtml), "見出しの文言 (件数・合計・プレビュー) が同じ");
  assert.ok(liveHtml.includes("3件"));
  assert.ok(liveHtml.includes("計"), "実行時間の合計を出す");
  assert.equal((settledHtml.match(/ツール履歴<\/span>/g) ?? []).length, 1, "ヘッダーは 1 つ");
  // コピーは進行中のターンでは出さない (live の印を落としたときだけ出る)
  assert.equal(liveHtml.includes("ツール履歴をすべてコピー"), false);
  assert.ok(settledHtml.includes("ツール履歴をすべてコピー"));
});

test("本文が来ないまま run_end したターンは、ツールだけの host を item として確定する", () => {
  let live = startRun();
  live = bodylessTool(live, 1);
  const hostId = toolBubbles(live)[0].id;
  const settled = chatReducer(live, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  assert.equal(toolBubbles(settled)[0].id, hostId);
  assert.equal(settledHeader(settled).count, 1, "ツールだけのターンでもヘッダーは 1 つ");

  // 確定履歴の item (本文なし応答が item になる) が届いても、カードは 1 枚のまま同じ item に残る
  const page: HistoryPage = {
    sessionId: "session-a",
    items: [
      {
        kind: "message",
        id: "a-u1",
        context: "active",
        role: "user",
        text: "調べて",
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
        tools: completedRun(["tool-1"]).toolCalls,
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  const merged = chatReducer(settled, { type: "resyncHistory", page });
  assert.deepEqual(
    cardsOf(merged).map(({ card, entryId }) => [card.id, entryId]),
    [["tool-1", "a-a1"]],
    "ライブの host と履歴 item を 2 枚にしない",
  );
});

test("停止で tool_end が来なかったカードは、ターンが終わるまで見出しに出さず、終わってから並べる", () => {
  let live = startRun();
  live = bodylessTool(live, 1);
  live = bodylessTool(live, 2, { end: false });
  assert.equal(liveHeader(live).count, 1, "完了した分だけを数える");
  const [host] = toolBubbles(live);
  assert.deepEqual(
    host.tools.map((card) => [card.id, card.phase]),
    [
      ["tool-1", "done"],
      ["tool-2", "running"],
    ],
  );

  const stopped = chatReducer(live, { runId: "run-1", type: "runEnd", status: "stopped", queueDepth: 0 });
  const [settledHost] = toolBubbles(stopped);
  assert.deepEqual(
    settledHost.tools.map((card) => card.id),
    ["tool-1", "tool-2"],
    "止まったツールも残す",
  );
  assert.equal(settledHeader(stopped).count, 2, "ターンが終われば結果の無いカードも並べる");
  assert.equal(settledHeader(stopped).bubbles, 1, "ヘッダーは 1 つのまま");
});

test("assistant_end を取りこぼしても、本文の応答へ次のツールを混ぜず 1 枚の host に溜める", () => {
  let state = startRun();
  state = chatReducer(state, { type: "text", delta: "A", at: 11, assistantId: "run-1:1" });
  // assistant_end を落としたまま、本文を持たない次の応答のツールが届く
  state = bodylessTool(state, 2, { id: "work-2" });
  const textBubble = state.bubbles.find((bubble) => bubble.text === "A");
  assert.deepEqual(textBubble?.tools, [], "前の応答の本文へ混ぜない");
  assert.deepEqual(
    cardsOf(state)
      .filter(({ card }) => card.id === "work-2")
      .map(({ card, bubbleId }) => [card.id, bubbleId]),
    [["work-2", toolBubbles(state)[0].id]],
    "本文を持たない応答のツールは host に付く",
  );

  // 次の本文は host を引き取る (履歴の繰り上げ先と同じ item)
  state = chatReducer(state, { type: "text", delta: "B", at: 40, assistantId: "run-1:3" });
  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["A", []],
      ["B", ["work-2"]],
    ],
    "閉じた応答に混ぜず、次の本文 item にまとめる",
  );
});

test("ツールだけの応答がターン途中でも、確定履歴どおり本文 item ごとにヘッダーが分かれる", () => {
  // What: A(本文) → B(本文なし tool) → C(本文) → D(本文なし tool) のターンで、live のヘッダーは
  // C と D の item に分かれ (全ターン 1 ヘッダーへ広げない)、確定履歴と同じ数になる
  let state = startRun();
  state = chatReducer(state, { type: "text", delta: "A", at: 11, assistantId: "run-1:1" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:1" });
  state = bodylessTool(state, 2, { id: "work-b" });
  state = chatReducer(state, { type: "text", delta: "C", at: 41, assistantId: "run-1:3" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:3" });
  state = bodylessTool(state, 4, { id: "work-d" });

  assert.deepEqual(
    state.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["A", []],
      ["C", ["work-b"]],
      ["", ["work-d"]],
    ],
    "繰り上げ先が無い最後の応答はツールだけの item になる",
  );
  const header = liveHeader(state);
  assert.equal(header.count, 2);
  assert.equal(header.bubbles, 2, "本文 item ごとにヘッダーが分かれる (1 ヘッダーへまとめない)");

  const settled = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  assert.deepEqual(settledHeader(settled), header, "run_end でヘッダーが動かない");
});
