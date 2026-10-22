// アシスタント本文の配信境界。差分の届き方がプロバイダごとに違っても、live の本文が確定した
// 最終本文と一致し、同じ本文を二重に配らないことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import type { PiSessionLike } from "../src/pi-runtime";
import { createSecretMasker, REDACTED, type SecretMasker } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import type { MessageMetrics, SSEEventType, ToolCall, ToolTiming } from "../src/schema";

interface Harness {
  bridge: ReturnType<typeof createRunEventBridge>;
  session: { messages: object[] };
  deltas: () => string[];
  live: () => string;
}

function createHarness(masker: SecretMasker = createSecretMasker([])): Harness {
  const session = { messages: [] as object[] };
  const events: { type: SSEEventType; data: Record<string, unknown> }[] = [];
  const bridge = createRunEventBridge({
    session: session as unknown as PiSessionLike,
    runId: "run-text",
    masker,
    cwd: "/tmp/project",
    tools: new Map<string, ToolCall>(),
    toolTimings: new Map<string, ToolTiming>(),
    messageMetrics: new WeakMap<object, MessageMetrics>(),
    compactionMeta: new Map(),
    emit: (type, data) => {
      events.push({ type, data: data as Record<string, unknown> });
    },
    emitResync: () => {},
    onRetryScheduled: () => {},
    onRetryAttemptStart: () => {},
    onRetryEnd: () => {},
    onSettled: () => {},
  });
  const deltas = (): string[] => events.flatMap((event) => (event.type === "text" ? [event.data.delta as string] : []));
  return {
    bridge,
    session,
    deltas,
    live: () => deltas().join(""),
  };
}

/** 差分を流し、その後に最終本文を持つ assistant の message_end を届ける */
function stream(h: Harness, chunks: string[], final: string, stopReason = "stop"): void {
  h.bridge.listener({ type: "agent_start" });
  h.bridge.listener({ type: "message_start", message: { role: "assistant" } });
  for (const chunk of chunks) {
    h.bridge.listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
  }
  const message = {
    role: "assistant",
    content: [{ type: "text", text: final }],
    stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  };
  h.session.messages.push(message);
  h.bridge.listener({ type: "message_end", message });
}

test("全文の delta を流すプロバイダは最終本文を二重に配らない", () => {
  const h = createHarness();
  stream(h, ["こんにちは", "、世界"], "こんにちは、世界");
  h.bridge.finalize();

  // What: 差分はそのまま届き、message_end / finalize で同じ本文を追加しない
  assert.deepEqual(h.deltas(), ["こんにちは", "、世界"]);
  assert.equal(h.live(), "こんにちは、世界");
  assert.equal(h.bridge.settledAssistantText(), "こんにちは、世界");
});

test("delta を流さないプロバイダは message_end の最終本文を配る", () => {
  const h = createHarness();
  stream(h, [], "最終本文だけを返す");
  h.bridge.finalize();

  // What: 差分が無いときは最終本文をそのまま配る
  assert.deepEqual(h.deltas(), ["最終本文だけを返す"]);
  assert.equal(h.live(), "最終本文だけを返す");
});

test("delta が途中で止まったプロバイダは最終本文との差分だけを配る", () => {
  const h = createHarness();
  stream(h, ["最終本文"], "最終本文の残り");
  h.bridge.finalize();

  // What: 配信済みの先頭は重複させず、残りだけを配る
  assert.deepEqual(h.deltas(), ["最終本文", "の残り"]);
  assert.equal(h.live(), "最終本文の残り");
});

test("停止したランは保留中の差分を捨てずに確定させる", () => {
  const secret = "sk-stop-partial-secret";
  const h = createHarness(createSecretMasker([secret]));
  const partial = `回答は ${secret.slice(0, 8)}`;
  // 中断: 最終本文も差分と同じところで止まっている (完全体は届いていない)
  stream(h, [partial], partial, "aborted");
  h.bridge.finalize();

  // What: 保留していた途中までの本文は、中断の確定で失わない
  assert.equal(h.live(), partial);
  assert.ok(!h.live().includes(secret), "完全な秘密値は出さない");
});

test("秘密値の途中で差分が止まっても、最終本文との突き合わせで末尾を落とさない", () => {
  const secret = "sk-boundary-secret";
  const h = createHarness(createSecretMasker([secret]));
  const partial = `回答は ${secret.slice(0, 6)}`;
  stream(h, [partial], `回答は ${secret} です`);
  h.bridge.finalize();

  // What: 保留分は最終本文が上書きし、マスク済みの全文が live に載る
  assert.equal(h.live(), `回答は ${REDACTED} です`);
  assert.equal(h.bridge.settledAssistantText(), `回答は ${REDACTED} です`);
});
