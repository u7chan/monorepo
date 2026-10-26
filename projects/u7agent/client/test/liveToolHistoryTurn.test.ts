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
import { pendingAskUserQuestionCount } from "../src/lib/askUser";
import { chatRenderItems, isLiveTurnBubble } from "../src/lib/chatItems";
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
  // What: 本文 item が現れたターン (ツールだけの応答 3 通 → 本文) では、run_end はライブの印を落とす
  // だけで、ヘッダーのバブル・位置・件数・プレビューを変えない
  let live = startRun();
  for (const seq of [1, 2, 3]) live = bodylessTool(live, seq);
  live = chatReducer(live, { type: "text", delta: "調べました", at: 40, assistantId: "run-1:4" });
  live = chatReducer(live, { type: "assistantEnd", assistantId: "run-1:4" });
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

test("本文が来ないまま run_end したターンは、確定履歴の item 境界 (本文なし応答ごと) に揃える", () => {
  // What: r1:1 → tool-1 → r1:2 → tool-2 → r1:3 → tool-3 → runEnd (本文なし) で、ライブの 1 枚の host を
  // 確定履歴の投影と同じ 3 item に分ける (1 枚にまとめたままだと resync / F5 でヘッダーが変わる)
  let live = startRun();
  for (const seq of [1, 2, 3]) live = bodylessTool(live, seq);
  assert.equal(toolBubbles(live).length, 1, "実行中は 1 枚の host に溜める");

  const settled = chatReducer(live, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  assert.deepEqual(
    toolBubbles(settled).map((bubble) => [bubble.assistantId, bubble.tools.map((card) => card.id)]),
    [
      ["run-1:1", ["tool-1"]],
      ["run-1:2", ["tool-2"]],
      ["run-1:3", ["tool-3"]],
    ],
    "本文なし応答ごとに 1 item (投影と同じ境界) になる",
  );
  assert.deepEqual(
    toolBubbles(settled).map((bubble) => bubble.text),
    ["", "", ""],
    "本文は催造しない",
  );
  assert.ok(
    toolBubbles(settled).every((bubble) => bubble.settled === true),
    "すべて確定済みにする",
  );
  assert.equal(settledHeader(settled).count, 3, "件数は 3 (合計は各 item の 1 件ずつ)");
  assert.equal(settledHeader(settled).bubbles, 3, "ヘッダーは 3 つ");

  // 確定履歴 (本文なし応答がそれぞれ item になる) を重ねても、card は 1 枚ずつ同じ item に残る
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
      ...completedRun(["tool-1", "tool-2", "tool-3"]).toolCalls.map((call, index) => ({
        kind: "message" as const,
        id: `a-a${index + 1}`,
        context: "active" as const,
        role: "assistant" as const,
        text: "",
        ...(call.assistantId === undefined ? {} : { assistantId: call.assistantId }),
        tools: [call],
      })),
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 4,
    summarizedMessageCount: 0,
  };
  const merged = chatReducer(settled, { type: "resyncHistory", page });
  assert.deepEqual(
    cardsOf(merged).map(({ card, entryId }) => [card.id, entryId]),
    [
      ["tool-1", "a-a1"],
      ["tool-2", "a-a2"],
      ["tool-3", "a-a3"],
    ],
    "履歴取得後も同じ item に 1 枚ずつ残る",
  );
  assert.deepEqual(
    chatRenderItems({
      bubbles: merged.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).flatMap((item) => (item.kind === "message" ? item.bubble.tools.map((card) => card.id) : [])),
    ["tool-1", "tool-2", "tool-3"],
    "表示は F5 後も 3 ヘッダー・3 カードのまま",
  );
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

test("ライブ中と確定後でヘッダーの件数・合計・プレビュー・占有幅が一致する (DOM)", () => {
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
  // コピーの枠は live 中も確保する: 出現で summary の高さ (size-6 の分だけ行が高くなる) とプレビューの
  // 幅が変わり、run_end で本文の位置がずれるのを防ぐ
  const summaryOf = (html: string): string => html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
  assert.ok(summaryOf(liveHtml).includes('data-tool-history-copy-slot="reserved"'), "ライブ中もコピーの枠を確保する");
  assert.equal((summaryOf(liveHtml).match(/size-6 shrink-0/g) ?? []).length, 1, "枠は copy ボタンと同じ footprint");
  assert.equal((summaryOf(settledHtml).match(/size-6 shrink-0/g) ?? []).length, 1, "確定後のボタンも同じ footprint");
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
  assert.deepEqual(
    toolBubbles(stopped).map((bubble) => bubble.tools.map((card) => [card.id, card.phase])),
    [[["tool-1", "done"]], [["tool-2", "running"]]],
    "止まったツールも本文なし応答ごとの item に残す",
  );
  assert.equal(settledHeader(stopped).count, 2, "ターンが終われば結果の無いカードも並べる");
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

test("本文を持たない host は、初回の履歴照合で前ターンの空本文 item に吸収されない", () => {
  // What: 履歴取得前に「r1 の本文なし tool a 完了 → runEnd → r2 開始 → 本文なし tool b 実行中」と進み、
  // [user(r1), assistant(r1:1, text="", tools=[a]), user(r2)] のページを適用しても、b が r1:1 の
  // item へ混ざらない (空文字の一致だけで別ターンへ対応付けない)
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  state = chatReducer(state, {
    type: "runStart",
    runId: "run-2",
    initialSendId: "send-2",
    prompt: "もう一度",
    at: 40,
    startedAt: 40,
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-b",
    name: "bash",
    args: "$ ls",
    at: 41,
    assistantId: "run-2:1",
  });

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
        tools: completedRun(["work-a"]).toolCalls,
      },
      {
        kind: "message",
        id: "a-u2",
        context: "active",
        role: "user",
        text: "もう一度",
        sendId: "send-2",
        runId: "run-2",
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 3,
    summarizedMessageCount: 0,
  };

  const merged = chatReducer(state, { type: "resyncHistory", page });
  assert.deepEqual(
    cardsOf(merged)
      .filter(({ card, entryId }) => card.id === "work-b" || entryId !== undefined)
      .map(({ card, entryId }) => [card.id, entryId]),
    [
      ["work-a", "a-a1"],
      ["work-b", undefined],
    ],
    "work-b を前ターンの item へ吸収しない (a は履歴 item のまま)",
  );
  const host = merged.bubbles.find((bubble) => bubble.tools.some((card) => card.id === "work-b"));
  assert.equal(host?.runId, "run-2", "host は run の同一性を保つ");
  assert.notEqual(host?.entryId, "a-a1");
});

test("待機エコーが host の後ろに積まれても、次の本文は host を引き取ってツールを残す", () => {
  // What: tool a 完了 → 追加入力 (待機) → 本文 C の順でも、C がツールを抱えたまま 1 バブルになり、
  // ツールだけの host が取り残されない (配列の末尾ではなく host の印で引く)
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { type: "localUser", text: "次の確認", at: 50 });
  state = chatReducer(state, {
    type: "echoSendId",
    sendId: "send-2",
    runId: "run-1",
    queuePosition: 1,
    stateSeq: state.stateSeq,
  });
  state = chatReducer(state, { type: "text", delta: "C", at: 60, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  const settled = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });

  assert.deepEqual(
    settled.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id), isToolHostBubble(bubble)]),
    [["C", ["work-a"], false]],
    "本文 C がツールを抱え、host は残らない",
  );
  assert.deepEqual(
    chatRenderItems({
      bubbles: settled.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
    }).flatMap((item) => (item.kind === "message" ? item.bubble.tools.map((card) => card.id) : [])),
    ["work-a"],
    "表示は C のヘッダー 1 つ",
  );
});

test("同じ応答の並列 ask_user は host に入らず、回答カードが非表示にならない", () => {
  // What: 本文なし応答の bash (実行中) と並列の ask_user が届いても、質問カードは自分のバブルに載り、
  // 実行中の host を隠す条件に巻き込まれない (回答手段が消えない)
  const questions = [{ question: "進めますか" }];
  let state = startRun();
  state = chatReducer(state, {
    type: "toolStart",
    id: "shell",
    name: "bash",
    args: "$ sleep 30",
    at: 20,
    assistantId: "run-1:1",
  });
  state = chatReducer(state, {
    type: "toolStart",
    id: "ask",
    name: "ask_user",
    args: "{}",
    questions,
    at: 21,
    assistantId: "run-1:1",
  });

  const questionBubble = state.bubbles.find((bubble) => bubble.tools.some((card) => card.id === "ask"));
  assert.ok(questionBubble !== undefined, "質問カードを抱えるバブルがある");
  assert.equal(isToolHostBubble(questionBubble), false, "host へ入れない");
  const rendered = chatRenderItems({
    bubbles: state.bubbles,
    markers: [],
    compactions: [],
    activeContextStartId: null,
    liveTurn: true,
  }).flatMap((item) => (item.kind === "message" ? item.bubble.tools.map((card) => card.id) : []));
  assert.ok(rendered.includes("ask"), "実行中のターンでも回答カードは描画される");
  assert.equal(rendered.includes("shell"), false, "実行中の bash は状態行が受け持つ");
});

test("本文 item を引き取った host は run_end まで live のままで、実行中のカードとコピーを出さない", () => {
  // What: tool 完了 → 本文 C → assistant_end → C 自身のツール、の順でも、run が終わるまで C は live
  // (assistant_end で currentAssistantId が外れても、コピーと実行中の行を出さない)
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { type: "text", delta: "C", at: 60, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-c",
    name: "grep",
    args: "$ grep C",
    at: 61,
    assistantId: "run-1:2",
  });

  const adopted = state.bubbles.find((bubble) => bubble.text === "C");
  assert.equal(state.currentAssistantId, null, "assistant_end で開いている応答は外れる");
  assert.equal(
    isLiveTurnBubble(adopted as Bubble, { currentAssistantId: state.currentAssistantId, runInProgress: true }),
    true,
    "run が続く間は live として扱う",
  );
  assert.deepEqual(
    completedToolCards((adopted as Bubble).tools).map((card) => card.id),
    ["work-a"],
    "実行中のカードは件数に数えない",
  );

  const settled = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  const settledBubble = settled.bubbles.find((bubble) => bubble.text === "C");
  assert.equal(
    isLiveTurnBubble(settledBubble as Bubble, { currentAssistantId: settled.currentAssistantId, runInProgress: false }),
    false,
    "run_end で live を落とす",
  );
  assert.deepEqual(
    settledBubble?.tools.map((card) => card.id),
    ["work-a", "work-c"],
    "止まったカードも確定後は並べる",
  );
});

test("履歴照合の後も、本文 item を引き取った host は run_end まで live のまま", () => {
  // What: tool 完了 → text(C) → assistantEnd(C) → C 自身のツール (実行中) → resyncHistory の順でも、
  // C は run が終わるまで live (コピーも実行中の行も出さない)。履歴へ対応付けても host の印を落とさない
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { type: "text", delta: "C", at: 60, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-c",
    name: "grep",
    args: "$ grep C",
    at: 61,
    assistantId: "run-1:2",
  });

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
        id: "a-c",
        context: "active",
        role: "assistant",
        text: "C",
        assistantId: "run-1:2",
        // 保存済みの履歴には完了したカードだけが載る (実行中の work-c はまだ結果が無い)
        tools: completedRun(["work-a"]).toolCalls,
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };
  state = chatReducer(state, { type: "resyncHistory", page });

  const adopted = state.bubbles.find((bubble) => bubble.entryId === "a-c");
  assert.equal(state.runStatus, "running", "run はまだ実行中");
  assert.equal(state.currentAssistantId, null, "assistant_end 済みで開いている応答は無い");
  assert.equal(isToolHostBubble(adopted as Bubble), true, "履歴へ対応付いても host の印を落とさない");
  assert.deepEqual(
    adopted?.tools.map((card) => card.id),
    ["work-a", "work-c"],
    "履歴に無い実行中のカードも残す",
  );

  const live = isLiveTurnBubble(adopted as Bubble, {
    currentAssistantId: state.currentAssistantId,
    runInProgress: state.runStatus === "running",
  });
  assert.equal(live, true, "resync の後も run の終端までは live");
  const liveHtml = renderHistory((adopted as Bubble).tools, live);
  assert.equal(liveHtml.includes("ツール履歴をすべてコピー"), false, "run_end の前にコピーを出さない");
  assert.equal(liveHtml.includes("実行中"), false, "実行中のカードは状態行に任せる");
  assert.ok(liveHtml.includes("1件"), "完了したカードだけを数える");

  // live を落とすとコピーも実行中の行も出る (印が効いていることの確認)
  const settledHtml = renderHistory((adopted as Bubble).tools, false);
  assert.ok(settledHtml.includes("ツール履歴をすべてコピー"));
  assert.ok(settledHtml.includes("実行中"));

  const ended = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });
  const endedBubble = ended.bubbles.find((bubble) => bubble.entryId === "a-c");
  assert.equal(isToolHostBubble(endedBubble as Bubble), false, "run_end で印を落とす");
  assert.equal(
    isLiveTurnBubble(endedBubble as Bubble, { currentAssistantId: ended.currentAssistantId, runInProgress: false }),
    false,
  );
});

test("本文 item を引き取った host の ask_user は、その item に残して次へ繰り上げない", () => {
  // What: 本文なし A の tool → 本文 C → assistantEnd(C) → C の ask_user → 回答 → 本文 D で、
  // 質問・回答カードは C の item に残り、D へ繰り上がらない (確定履歴の投影と同じ境界)
  const questions = [{ question: "進めますか" }];
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { type: "text", delta: "C", at: 60, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "ask",
    name: "ask_user",
    args: "{}",
    questions,
    at: 61,
    assistantId: "run-1:2",
  });

  const asked = state.bubbles.filter((bubble) => bubble.tools.some((card) => card.id === "ask"));
  assert.equal(asked.length, 1, "質問カードのバブルを増やさない");
  assert.equal(asked[0]?.text, "C", "表示できる本文 item に付ける");
  assert.equal(asked[0]?.assistantId, "run-1:2");
  assert.equal(
    chatRenderItems({
      bubbles: state.bubbles,
      markers: [],
      compactions: [],
      activeContextStartId: null,
      liveTurn: true,
    }).some((item) => item.kind === "message" && item.bubble.tools.some((card) => card.id === "ask")),
    true,
    "回答待ちのカードは実行中のターンでも描画される",
  );
  assert.equal(pendingAskUserQuestionCount(state.runTools, state.runStatus), questions.length);

  state = chatReducer(state, { type: "toolEnd", id: "ask", isError: false, output: "", answers: [] });
  state = chatReducer(state, { type: "text", delta: "D", at: 62, assistantId: "run-1:3" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:3" });
  const settled = chatReducer(state, { runId: "run-1", type: "runEnd", status: "completed", queueDepth: 0 });

  assert.deepEqual(
    settled.bubbles
      .filter((bubble) => bubble.role === "assistant")
      .map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [
      ["C", ["work-a", "ask"]],
      ["D", []],
    ],
    "回答カードは C の item に残る (サーバー投影の C:[tool, ask_user] / D:[] と同じ)",
  );
});

test("2回目の resync でページを組み直しても、本文 item を引き取った host は run_end まで live のまま", () => {
  // What: tool 完了 → text(C) → assistantEnd(C) → C 自身のツール (実行中) → resyncHistory (C に entryId) →
  // 2回目の実行中スナップショット + 履歴適用 → C の tool 完了 → text(D) と進んでも、C は run_end まで
  // host (live) のまま。run_end の前に C のコピーも実行中の行も出さず、run_end で同じバブルのまま確定する
  let state = startRun();
  state = bodylessTool(state, 1, { id: "work-a" });
  state = chatReducer(state, { type: "text", delta: "C", at: 60, assistantId: "run-1:2" });
  state = chatReducer(state, { type: "assistantEnd", assistantId: "run-1:2" });
  state = chatReducer(state, {
    type: "toolStart",
    id: "work-c",
    name: "grep",
    args: "$ grep C",
    at: 61,
    startedAt: 61,
    assistantId: "run-1:2",
  });

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
        id: "a-c",
        context: "active",
        role: "assistant",
        text: "C",
        assistantId: "run-1:2",
        // 保存済みの履歴には完了したカードだけが載る (実行中の work-c はまだ結果が無い)
        tools: completedRun(["work-a"]).toolCalls,
      },
    ],
    prevCursor: null,
    hasMore: false,
    nextCursor: null,
    activeContextStartId: "a-u1",
    messageCount: 2,
    summarizedMessageCount: 0,
  };

  // 1回目の resync。C は entryId を得ても host のまま (live の突き合わせで印を引き継ぐ)
  state = chatReducer(state, { type: "resyncHistory", page });
  const entryHost = state.bubbles.find((bubble) => bubble.entryId === "a-c") as Bubble;
  assert.equal(isToolHostBubble(entryHost), true, "1回目の resync で entryId が付いても host のまま");

  // 2回目の実行中スナップショット。C は entryId 付きなので live の突き合わせ対象から外れる
  const workC = {
    id: "work-c",
    assistantId: "run-1:2",
    name: "grep",
    args: "$ grep C",
    isError: false,
    done: false,
    output: "",
    startedAt: 61,
  };
  const calls = [...completedRun(["work-a"]).toolCalls, workC];
  const snapshot: SessionPayload = {
    ...idlePayload(1),
    status: "running",
    run: {
      ...completedRun(["work-a"]),
      status: "running",
      toolCalls: calls,
    },
    messages: [
      { role: "user", text: "調べて", sendId: "send-1", runId: "run-1" },
      { role: "assistant", assistantId: "run-1:2", text: "C", at: 60, tools: calls },
    ],
  };
  state = chatReducer(state, { type: "resync", payload: snapshot });
  const afterSnapshot = state.bubbles.find((bubble) => bubble.entryId === "a-c") as Bubble;
  assert.equal(isToolHostBubble(afterSnapshot), true, "実行中スナップショットで host を落とさない");

  // 2回目の履歴適用。ページからバブルを組み直すため、印は live の突き合わせでは写らない
  state = chatReducer(state, { type: "resyncHistory", page });
  const rebooted = state.bubbles.find((bubble) => bubble.entryId === "a-c") as Bubble;
  assert.equal(isToolHostBubble(rebooted), true, "ページを組み直しても host として復元する");
  assert.equal(state.runStatus, "running", "run はまだ実行中");
  assert.equal(state.currentAssistantId, null, "host を開いている応答 (本文の補完先) へ戻さない");
  assert.deepEqual(
    rebooted.tools.map((card) => [card.id, card.phase]),
    [
      ["work-a", "done"],
      ["work-c", "running"],
    ],
    "履歴に無い実行中のカードも残す",
  );

  // 実行中はコピーも実行中の行も出さない。印が効いていることは live を落とした描画との差で確かめる
  const runningHtml = renderHistory(
    rebooted.tools,
    isLiveTurnBubble(rebooted, { currentAssistantId: state.currentAssistantId, runInProgress: true }),
  );
  assert.equal(runningHtml.includes("ツール履歴をすべてコピー"), false, "run_end の前にコピーを出さない");
  assert.equal(runningHtml.includes("実行中"), false, "実行中のカードは状態行に任せる");
  assert.ok(runningHtml.includes("1件"), "完了したカードだけを数える");
  const openedHtml = renderHistory(rebooted.tools, false);
  assert.ok(openedHtml.includes("ツール履歴をすべてコピー"), "live でなければコピーを出す");
  assert.ok(openedHtml.includes("実行中"), "live でなければ実行中の行を出す");

  // C 自身のツールが完了し、次の本文 D が届いても C は host のまま (コピーは出ない)
  state = chatReducer(state, { type: "toolEnd", id: "work-c", isError: false, output: "out c", endedAt: 62 });
  state = chatReducer(state, { type: "text", delta: "D", at: 63, assistantId: "run-1:3" });
  const withD = state.bubbles.find((bubble) => bubble.text === "C") as Bubble;
  assert.equal(isToolHostBubble(withD), true, "C 自身のツールが完了して D が来ても host のまま");
  assert.equal(
    isLiveTurnBubble(withD, {
      currentAssistantId: state.currentAssistantId,
      runInProgress: state.runStatus === "running",
    }),
    true,
    "run が続く間は live として扱う",
  );
  assert.deepEqual(
    toolBubbles(state).map((bubble) => [bubble.text, bubble.tools.map((card) => card.id)]),
    [["C", ["work-a", "work-c"]]],
    "C のツール履歴が別バブル (コピーになる複製) に増えない",
  );
  const before = liveHeader(state);
  assert.equal(before.count, 2, "完了した 2 件を数える");
  assert.equal(before.bubbles, 1, "ヘッダーは C の 1 つだけ");

  // run_end で同じバブルのまま確定し、コピーと実行時間の行がそろう
  const ended = chatReducer(state, {
    runId: "run-1",
    type: "runEnd",
    status: "completed",
    queueDepth: 0,
    durationMs: 3000,
  });
  const settledC = ended.bubbles.find((bubble) => bubble.text === "C") as Bubble;
  assert.equal(settledC.id, withD.id, "同じバブル (同じ DOM の位置) のまま確定する");
  assert.equal(isToolHostBubble(settledC), false, "run_end で host の印を外す");
  assert.equal(settledC.settled, true);
  assert.equal(
    isLiveTurnBubble(settledC, { currentAssistantId: ended.currentAssistantId, runInProgress: false }),
    false,
  );
  assert.deepEqual(
    settledC.tools.map((card) => [card.id, card.phase]),
    [
      ["work-a", "done"],
      ["work-c", "done"],
    ],
    "C の 2 件がそろって確定する",
  );
  assert.deepEqual(settledHeader(ended), before, "run_end で件数・プレビュー・ヘッダーの数が変わらない");
  const settledHtml = renderHistory(settledC.tools, false);
  assert.ok(settledHtml.includes("ツール履歴をすべてコピー"), "確定後にコピーを出す");
  assert.equal(settledHtml.includes("実行中"), false, "実行中の行は残らない");
  assert.ok(settledHtml.includes("2件"), "件数は 2 件");
});
