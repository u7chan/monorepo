// investigate の進捗 (SSE の tool_progress) の契約。SDK の tool_execution_update を変換するのは
// 調査の子を持つ investigate だけで、値は live 専用 (payload の run.toolCalls には載せない)。
import assert from "node:assert/strict";
import test from "node:test";
import type { PiSessionLike } from "../src/pi-runtime";
import { REDACTED, createSecretMasker } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import type { MessageMetrics, SSEEventType, ToolCall, ToolTiming } from "../src/schema";

const CWD = "/tmp/project";
const SECRET = "sk-live-progress-secret";
const masker = createSecretMasker([SECRET]);

/** 進捗の変換だけを見る bridge。run のライフサイクルは使わない */
function createProgressBridge(messages: PiSessionLike["messages"] = []) {
  const events: { type: SSEEventType; data: Record<string, unknown> }[] = [];
  const tools = new Map<string, ToolCall>();
  const bridge = createRunEventBridge({
    session: { messages } as unknown as PiSessionLike,
    masker,
    cwd: CWD,
    tools,
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
  return { bridge, events, tools };
}

function progressOf(events: { type: SSEEventType; data: Record<string, unknown> }[], id: string): unknown[] {
  return events
    .filter((event) => event.type === "tool_progress" && event.data.id === id)
    .map((event) => event.data.text);
}

test("investigate の途中結果だけを tool_progress へ変換する", () => {
  const { bridge, events, tools } = createProgressBridge();
  bridge.listener({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "investigate",
    args: { prompt: "調べて" },
  });
  bridge.listener({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "investigate",
    args: { prompt: "調べて" },
    partialResult: { content: [{ type: "text", text: "bash rg -n foo" }] },
  });
  bridge.listener({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "investigate",
    partialResult: { content: [{ type: "text", text: "bash rg -n foo\n結論: docs にある" }] },
  });

  assert.deepEqual(progressOf(events, "call-1"), ["bash rg -n foo", "bash rg -n foo\n結論: docs にある"]);
  // live 専用。カード (payload の run.toolCalls の実体) へ書くと resync で復元されてしまう
  assert.equal(Object.hasOwn(tools.get("call-1") ?? {}, "progress"), false);
  assert.equal(events.filter((event) => event.type === "tool_progress").length, 2);
});

test("本文を持たない途中結果は配らない (空の進捗を live 行に流さない)", () => {
  const { bridge, events } = createProgressBridge();
  bridge.listener({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "investigate",
    partialResult: { content: [{ type: "text", text: "" }] },
  });
  bridge.listener({ type: "tool_execution_update", toolCallId: "call-1", toolName: "investigate" });

  assert.equal(
    events.some((event) => event.type === "tool_progress"),
    false,
  );
});

test("investigate 以外の途中結果は変換しない (既存ツールの live 挙動を変えない)", () => {
  const { bridge, events } = createProgressBridge();
  for (const toolName of ["bash", "grep", "read"]) {
    bridge.listener({
      type: "tool_execution_update",
      toolCallId: `call-${toolName}`,
      toolName,
      partialResult: { content: [{ type: "text", text: "途中出力" }] },
    });
  }

  assert.equal(
    events.some((event) => event.type === "tool_progress"),
    false,
  );
});

test("進捗の本文は配る前に mask する", () => {
  const { bridge, events } = createProgressBridge();
  bridge.listener({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "investigate",
    partialResult: { content: [{ type: "text", text: `KEY=${SECRET}\ncurl -H "Authorization: Bearer ${SECRET}"` }] },
  });

  assert.deepEqual(progressOf(events, "call-1"), [`KEY=${REDACTED}\ncurl -H "Authorization: Bearer ${REDACTED}"`]);
});

test("finalize の後は途中結果を配らない (run_end の後に live 値を足さない)", () => {
  const { bridge, events } = createProgressBridge();
  bridge.finalize();
  bridge.listener({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "investigate",
    partialResult: { content: [{ type: "text", text: "遅れて届いた進捗" }] },
  });

  assert.equal(
    events.some((event) => event.type === "tool_progress"),
    false,
  );
});
