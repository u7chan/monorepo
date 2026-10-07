// ツール実行時間 (BFF 計測の startedAt / endedAt) の導出。SDK は実行時刻を持たず、値は
// イベントの到着時刻にしか無いため、run の観測 (run-events) と履歴の投影で同じ値が載ることを固定する。
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createSecretMasker } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import type { PiSessionLike } from "../src/pi-runtime";
import type { MessageMetrics, SSEEventType, ToolCall, ToolTiming } from "../src/schema";
import { projectMessages } from "../src/session-projection";

const CWD = "/tmp/project";
const masker = createSecretMasker([]);

type TestMessage = PiSessionLike["messages"][number];

function sessionOf(messages: TestMessage[]): PiSessionLike {
  return { messages } as unknown as PiSessionLike;
}

/** ツール時間を観測するだけの bridge。run のライフサイクルは使わない */
function createTimingBridge(messages: TestMessage[]) {
  const events: { type: SSEEventType; data: unknown }[] = [];
  const tools = new Map<string, ToolCall>();
  const toolTimings = new Map<string, ToolTiming>();
  const bridge = createRunEventBridge({
    session: sessionOf(messages),
    masker,
    cwd: CWD,
    tools,
    toolTimings,
    messageMetrics: new WeakMap<object, MessageMetrics>(),
    compactionMeta: new Map(),
    emit: (type, data) => {
      events.push({ type, data });
    },
    emitResync: () => {},
    onRetryScheduled: () => {},
    onRetryAttemptStart: () => {},
    onRetryEnd: () => {},
    onSettled: () => {},
  });
  return { bridge, events, tools, toolTimings };
}

function eventOf(events: { type: SSEEventType; data: unknown }[], type: SSEEventType): Record<string, unknown> {
  const entry = events.find((item) => item.type === type);
  assert.ok(entry, `${type} が配られていない`);
  return entry.data as Record<string, unknown>;
}

test("ツール実行の開始 / 終了は到着時刻で測り、ToolCall と SSE へ同じ値を載せる", async () => {
  const { bridge, events, tools, toolTimings } = createTimingBridge([]);

  bridge.listener({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls" },
  });
  await sleep(15);
  bridge.listener({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
  });

  const timing = toolTimings.get("call-1");
  assert.ok(timing, "セッションへ実行時間を控えていない");
  assert.ok(timing.endedAt - timing.startedAt >= 10, `実行時間が短すぎる: ${timing.endedAt - timing.startedAt}ms`);

  const call = tools.get("call-1");
  assert.equal(call?.startedAt, timing.startedAt, "payload.run.toolCalls の開始");
  assert.equal(call?.endedAt, timing.endedAt, "payload.run.toolCalls の終了");
  assert.equal(eventOf(events, "tool_start").startedAt, timing.startedAt, "SSE tool_start の開始");
  assert.equal(eventOf(events, "tool_end").endedAt, timing.endedAt, "SSE tool_end の終了");
});

test("開始を観測しなかった実行には時間を載せない (片方だけの区間を作らない)", () => {
  const { bridge, events, tools, toolTimings } = createTimingBridge([]);

  bridge.listener({
    type: "tool_execution_end",
    toolCallId: "call-2",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
  });

  assert.equal(toolTimings.size, 0, "開始の無い実行を控えている");
  assert.equal(eventOf(events, "tool_end").endedAt, undefined, "SSE tool_end に終了だけを載せている");
  assert.equal(tools.size, 0, "開始の無い実行でカードを作っている");
});

test("履歴の投影は同じ toolCallId の実行時間を載せ、控えが無ければ載せない", () => {
  const assistant: TestMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      { type: "text", text: "実行しました" },
    ],
    stopReason: "stop",
    timestamp: 2,
  };
  const result: TestMessage = {
    role: "toolResult",
    content: [{ type: "text", text: "ok" }],
    toolCallId: "call-1",
    isError: false,
    timestamp: 3,
  };
  const messages = [assistant, result];
  const timings = new Map<string, ToolTiming>([["call-1", { startedAt: 1_000, endedAt: 1_250 }]]);

  const withTiming = projectMessages(sessionOf(messages), new WeakMap<object, MessageMetrics>(), masker, CWD, timings);
  assert.deepEqual(
    withTiming.flatMap((message) => message.tools ?? []).map((call) => [call.startedAt, call.endedAt]),
    [[1_000, 1_250]],
  );

  // 再起動 / sweep 後は控えが無い。実行時間だけが欠け、カード自体は出る
  const withoutTiming = projectMessages(sessionOf(messages), new WeakMap<object, MessageMetrics>(), masker, CWD);
  const [card] = withoutTiming.flatMap((message) => message.tools ?? []);
  assert.equal(card?.id, "call-1");
  assert.equal(card?.startedAt, undefined);
  assert.equal(card?.endedAt, undefined);
});
