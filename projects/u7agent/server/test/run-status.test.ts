// 状態行の活動ラベル (SSE `status`) のうち、本文の書き出しに入ったことの通知。数字 (経過時間) は
// 止めない (止めるのは ask_user の回答待ちの時だけ) ため、ラベルだけをフェーズへ合わせる。
import assert from "node:assert/strict";
import test from "node:test";
import type { PiSessionLike } from "../src/pi-runtime";
import { createSecretMasker } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import type { MessageMetrics, SSEEventType, ToolCall, ToolTiming } from "../src/schema";

const CWD = "/tmp/project";

/** 活動の通知だけを見る bridge。run のライフサイクルは使わない */
function createActivityBridge() {
  const events: { type: SSEEventType; data: Record<string, unknown> }[] = [];
  const bridge = createRunEventBridge({
    session: { messages: [] } as unknown as PiSessionLike,
    runId: "run-test",
    masker: createSecretMasker([]),
    cwd: CWD,
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
  const statuses = (): Record<string, unknown>[] =>
    events.filter((event) => event.type === "status").map((event) => event.data);
  return { bridge, statuses };
}

const assistantStart = { type: "message_start", message: { role: "assistant" } } as const;
const delta = (type: "text_delta" | "thinking_delta", value: string) =>
  ({ type: "message_update", assistantMessageEvent: { type, delta: value } }) as const;

test("本文の最初の delta だけで書き出しを知らせ、同じメッセージの後続では繰り返さない", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  // 思考は本文ではない (「考え中…」のまま)
  bridge.listener(delta("thinking_delta", "考える"));
  bridge.listener(delta("text_delta", "応答"));
  bridge.listener(delta("text_delta", " の続き"));

  assert.deepEqual(statuses(), [
    { state: "thinking", text: "考え中…" },
    { state: "writing", text: "応答を書いています…" },
  ]);
});

test("ツール実行を挟んだターンは、次の本文で書き出しを再び知らせる", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener(assistantStart);
  bridge.listener(delta("text_delta", "調べます"));
  bridge.listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
  bridge.listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {} });
  bridge.listener(delta("text_delta", "結果は…"));

  assert.deepEqual(
    statuses().map((status) => status.state),
    ["writing", "tool", "writing"],
  );
});

test("次の assistant メッセージ (ターン) でも書き出しを知らせる", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener(assistantStart);
  bridge.listener(delta("text_delta", "1 つ目"));
  bridge.listener({ type: "message_end", message: { role: "assistant" } });
  bridge.listener(assistantStart);
  bridge.listener(delta("text_delta", "2 つ目"));

  assert.deepEqual(
    statuses().map((status) => status.state),
    ["writing", "writing"],
  );
});

// What: ツールを終えた後、次のモデル判断に入る間も状態行は終わったツールを実行中のままにしない。
test("ツールを終えて次のターンへ入ると考え中へ戻す", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener(assistantStart);
  bridge.listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  bridge.listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {} });
  assert.deepEqual(statuses().at(-1), { state: "tool", text: "bash を実行中…" }, "ツール実行中はツール名を出す");

  bridge.listener({ type: "turn_start" });
  assert.deepEqual(statuses().at(-1), { state: "thinking", text: "考え中…" }, "モデル判断へ戻したら考え中にする");
});

// What: 最初のターンは agent_start と同じ文言なので、同じ status を二重に配らない。
test("最初のターンは agent_start の考え中を繰り返さない", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener({ type: "turn_start" });

  assert.deepEqual(statuses(), [{ state: "thinking", text: "考え中…" }]);
});
