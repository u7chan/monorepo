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
/** `thinking_start` / `text_end` など、delta を持たない assistant イベント */
const assistantEvent = (type: string, value?: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type, ...(value === undefined ? {} : { delta: value }) },
  }) as const;

test("本文の最初の delta だけで書き出しを知らせ、同じメッセージの後続では繰り返さない", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  // 思考は本文ではない (「考え中…」のまま)。末尾は同じ status の `thinking` にだけ載る
  bridge.listener(delta("thinking_delta", "考える"));
  bridge.listener(delta("text_delta", "応答"));
  bridge.listener(delta("text_delta", " の続き"));

  assert.deepEqual(statuses(), [
    { state: "thinking", text: "考え中…" },
    { state: "thinking", text: "考え中…", thinking: "考える" },
    { state: "writing", text: "応答を書いています…" },
  ]);
});

// What: 実行中の thinking の末尾は、phase と一緒に `status.thinking` として届き、phase が移ると消える。
test("thinking_delta は status の thinking になり、text / tool / message_end で消える", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  bridge.listener(delta("thinking_delta", "まず前提を確かめる。"));
  assert.equal(statuses().at(-1)?.thinking, "まず前提を確かめる。");

  bridge.listener(delta("text_delta", "応答"));
  assert.equal(statuses().at(-1)?.state, "writing");
  assert.ok(!("thinking" in (statuses().at(-1) ?? {})), "phase が移ったら tail を載せない");

  bridge.listener({ type: "turn_start" });
  bridge.listener(delta("thinking_delta", "次の思考。"));
  assert.equal(statuses().at(-1)?.thinking, "次の思考。");

  bridge.listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  assert.ok(!("thinking" in (statuses().at(-1) ?? {})), "ツール実行中に tail を載せない");

  bridge.listener({ type: "turn_start" });
  bridge.listener(delta("thinking_delta", "さらに思考。"));
  bridge.listener({ type: "message_end", message: { role: "assistant" } });
  bridge.listener({ type: "turn_start" });
  assert.deepEqual(statuses().at(-1), { state: "thinking", text: "考え中…" }, "message_end の後に古い tail を載せない");
});

// What: commentary → reasoning のように、同じ assistant 応答の中で本文の後に thinking が再開しても
// phase が thinking へ戻り、tail が出る。本文へ戻ったら writing をもう一度知らせる。
test("本文 → thinking → 本文の再開で phase と tail が追従する", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  bridge.listener(assistantEvent("text_start"));
  bridge.listener(delta("text_delta", "本文"));
  bridge.listener(assistantEvent("text_end"));
  bridge.listener(assistantEvent("thinking_start"));
  bridge.listener(delta("thinking_delta", "考え直す。"));
  bridge.listener(assistantEvent("thinking_end"));
  bridge.listener(assistantEvent("text_start"));
  bridge.listener(delta("text_delta", "本文の続き"));

  const tails = statuses().filter((status) => typeof status.thinking === "string");
  assert.equal(tails.length, 1, "thinking の末尾が配られる");
  assert.equal(tails[0].thinking, "考え直す。");
  assert.equal(tails[0].state, "thinking");
  assert.deepEqual(
    statuses().map((status) => status.state),
    ["thinking", "writing", "thinking", "thinking", "writing"],
    "phase が thinking へ戻り、本文の再開で writing を再通知する",
  );
});

// What: `thinking_start` を配らないプロバイダでも、最初の delta で phase と tail が付く。
test("thinking_start が無い最初の delta でも thinking の末尾を配る", () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  bridge.listener(delta("text_delta", "本文"));
  bridge.listener(delta("thinking_delta", "思考だけが後から来る。"));
  assert.equal(statuses().at(-1)?.thinking, "思考だけが後から来る。");
  bridge.listener(delta("text_delta", "本文の続き"));
  assert.equal(statuses().at(-1)?.state, "writing", "本文へ戻ったら書き出しへ戻す");
  assert.ok(!("thinking" in (statuses().at(-1) ?? {})), "本文へ戻ったら tail を載せない");
});

// What: 確定 (finalize) より後に thinking の status を配らない。保留中の配信も run_end の前に捨てる。
test("finalize の後に保留中の thinking を配らない", async () => {
  const { bridge, statuses } = createActivityBridge();
  bridge.listener({ type: "agent_start" });
  bridge.listener(assistantStart);
  bridge.listener(delta("thinking_delta", "最初の思考。"));
  assert.equal(statuses().length, 2);
  // 500ms の間引きで保留になる (次の delta はタイマー待ち)
  bridge.listener(delta("thinking_delta", "続きの思考。"));
  bridge.finalize();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(statuses().length, 2, "finalize の後に thinking の status を出さない");
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
