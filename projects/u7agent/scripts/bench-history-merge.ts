// 長い履歴の初期表示・ページ遡り・merge の再現用ベンチマーク。CI では実行しない。
// 使い方: pnpm bench:history-merge
//         SIZES=1000,10000 TEXT_CHARS=40 pnpm bench:history-merge
// 絶対値はマシン負荷に依存するため、同じ環境で変更前後を比較する。
import { performance } from "node:perf_hooks";
import { chatReducer, historyToBubbles, initialChatState } from "../client/src/hooks/chatReducer.ts";
import { mergeHistoryPage } from "../client/src/lib/chatHistory.ts";
import type { ChatMessage, HistoryPage, SessionPayload } from "../client/src/types.ts";

const sizes = (process.env.SIZES ?? "1000,10000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const textChars = Number(process.env.TEXT_CHARS ?? 40);
const restoreSizes = (process.env.RESTORE_SIZES ?? "1000,2000,4000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

function messagesOf(count: number): ChatMessage[] {
  const text = "あ".repeat(textChars);
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `m${index} ${text}`,
    ...(index % 2 === 1 ? { assistantId: `run-${index}:0` } : { sendId: `send-${index}`, runId: `run-${index}` }),
  }));
}

function payloadOf(messages: ChatMessage[]): SessionPayload {
  return {
    sessionId: "bench",
    piSessionId: "bench",
    cwd: "",
    eventGeneration: "bench",
    status: "idle",
    title: "bench",
    createdAt: 0,
    lastUsedAt: 0,
    serverNow: 0,
    queueDepth: 0,
    pinned: false,
    lastSeq: 0,
    run: null,
    messages,
    compactions: [],
  } as unknown as SessionPayload;
}

function pageOf(messages: ChatMessage[], start: number, withTurnEnds = false): HistoryPage {
  const items = messages.slice(start, start + 50).map((message, index) => ({
    kind: "message" as const,
    id: `entry-${start + index}`,
    context: "active" as const,
    role: message.role,
    text: message.text,
    ...(message.sendId === undefined ? {} : { sendId: message.sendId }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.assistantId === undefined ? {} : { assistantId: message.assistantId }),
    ...(withTurnEnds && message.role === "user"
      ? { runDurationMs: 1000 + (start + index), runOutcome: "completed" as const }
      : {}),
  }));
  return {
    sessionId: "bench",
    items,
    prevCursor: start > 0 ? `entry-${start - 1}` : null,
    nextCursor: start > 0 ? `entry-${start}` : null,
    hasMore: start > 0,
    activeContextStartId: null,
    messageCount: messages.length,
    summarizedMessageCount: 0,
  };
}

function median(label: string, fn: () => void, iterations = 3): number {
  fn();
  const times: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    fn();
    times.push(performance.now() - startedAt);
  }
  times.sort((a, b) => a - b);
  const value = times[Math.floor(times.length / 2)];
  console.log(`${label}: ${value.toFixed(1)}ms`);
  return value;
}

for (const count of sizes) {
  const messages = messagesOf(count);
  const payload = payloadOf(messages);
  console.log(`\n## messages=${count} textChars=${textChars} payloadBytes=${JSON.stringify(payload).length}`);

  const initial = chatReducer(initialChatState, { type: "resync", payload });
  console.log(`initial resync: bubbles=${initial.bubbles.length}`);

  const latest = pageOf(messages, messages.length - 50);
  let withHistory = initial;
  median("first history page", () => {
    withHistory = chatReducer(initial, { type: "resyncHistory", page: latest });
  });
  console.log(`after first page: bubbles=${withHistory.bubbles.length}`);

  median(
    "20 older pages",
    () => {
      let state = withHistory;
      let cursor = state.history.nextCursor;
      for (let page = 0; page < 20 && cursor; page += 1) {
        const start = Math.max(0, messages.length - 50 * (page + 2));
        state = chatReducer(state, { type: "prependHistory", cursor, page: pageOf(messages, start) });
        cursor = state.history.nextCursor;
      }
    },
    1,
  );

  // 初期表示の上限を外したときの worst case。全量を live として最新ページと merge する。
  const all = historyToBubbles(1, messages);
  median(
    `full legacy merge (${all.bubbles.length} live)`,
    () => {
      mergeHistoryPage({ bubbles: all.bubbles, markers: [], nextId: all.nextId, toolBubbleIds: {} }, latest, {
        live: all.bubbles,
      });
    },
    1,
  );
}

// 結末 (runDurationMs) 付きの履歴を保持したまま最新 50 件を再適用する。run_end 後の live user と
// 取り込んだ履歴 user の両方が結末を持つため、restoreUserTurnEnds が全 user 分走る。
console.log("\n## 結末付き履歴を保持した最新 50 件の再同期");
for (const count of restoreSizes) {
  const messages = messagesOf(count);
  const latest = pageOf(messages, messages.length - 50, true);
  let state = chatReducer(initialChatState, { type: "resync", payload: payloadOf(messages) });
  state = chatReducer(state, { type: "resyncHistory", page: latest });
  let cursor = state.history.nextCursor;
  for (let page = 0; cursor; page += 1) {
    const start = Math.max(0, messages.length - 50 * (page + 2));
    state = chatReducer(state, { type: "prependHistory", cursor, page: pageOf(messages, start, true) });
    cursor = state.history.nextCursor;
  }
  const held = state.bubbles.length;
  const users = state.bubbles.filter((bubble) => bubble.role === "user" && bubble.runDurationMs !== undefined);
  console.log(`held bubbles=${held} users with turn end=${users.length}`);
  median(`resync latest 50 (${held} bubbles held)`, () => {
    state = chatReducer(state, { type: "resyncHistory", page: latest });
  });
}
