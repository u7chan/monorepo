// investigate の進捗 (SSE の tool_progress) の契約。SDK の tool_execution_update を変換するのは
// 調査の子を持つ investigate だけで、値は live 専用 (payload の run.toolCalls には載せない)。
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createInvestigateRunner } from "../src/investigate-runner";
import { createInvestigateToolDefinitions } from "../src/investigate-tool";
import type { PiSessionLike } from "../src/pi-runtime";
import { REDACTED, createSecretMasker } from "../src/redact";
import { createRunEventBridge } from "../src/run-events";
import type { MessageMetrics, SSEEventType, ToolCall, ToolTiming } from "../src/schema";
import { createStubSession } from "./stub-pi";

const CWD = "/tmp/project";
const SECRET = "sk-live-progress-secret";
const masker = createSecretMasker([SECRET]);

/** 進捗の変換だけを見る bridge。run のライフサイクルは使わない */
function createProgressBridge(messages: PiSessionLike["messages"] = [], bridgeMasker = masker) {
  const events: { type: SSEEventType; data: Record<string, unknown> }[] = [];
  const tools = new Map<string, ToolCall>();
  const bridge = createRunEventBridge({
    session: { messages } as unknown as PiSessionLike,
    masker: bridgeMasker,
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

test("生成途中の秘密値の断片は本文上限で切る前に保留し、tool_progress へ出さない", async () => {
  // 512 文字の合成秘密値。子はその先頭 350 文字を少しずつ生成し、間引き (既定 400ms) が
  // 発火した時点でも累積原文が秘密値の先頭部分のままになる状況を作る
  const secret = `sk${"A".repeat(150)}${"B".repeat(180)}${"C".repeat(180)}`;
  const partial = secret.slice(0, 350);
  const secretMasker = createSecretMasker([secret]);
  const runner = createInvestigateRunner({
    masker: secretMasker,
    createChildSession: async () => {
      const session = createStubSession({ reply: "" });
      session.prompt = async () => {
        session.emit({ type: "message_start", message: { role: "assistant" } });
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        session.appendMessage(assistant);
        for (let at = 0; at < partial.length; at += 70) {
          await sleep(60);
          const chunk = partial.slice(at, at + 70);
          (assistant.content[0] as { text: string }).text += chunk;
          session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
        }
        // 間引きの timer が発火してから終わる (発火前の保留だけでなく、切った後の断片も見る)
        await sleep(400);
        session.emit({ type: "message_end", message: assistant });
        session.emit({ type: "agent_settled" });
      };
      return session;
    },
  });
  const { bridge, events } = createProgressBridge([], secretMasker);
  const definition = createInvestigateToolDefinitions({
    enabled: true,
    sessionId: "s-1",
    host: {
      investigate: (request) =>
        runner.investigate({
          sessionId: request.sessionId,
          cwd: "",
          prompt: request.prompt,
          signal: request.signal,
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        }),
    },
    masker: secretMasker,
  })[0];

  // onUpdate は SDK と同じ形で bridge へ流す (wrapper を通った後の値を見る)
  const result = (await definition.execute(
    "call-1",
    { prompt: "調べて" },
    undefined,
    (partialResult: unknown) => {
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
        partialResult,
      });
    },
    {} as never,
  )) as { content: { text: string }[]; isError?: boolean };

  assert.equal(result.isError, undefined, "子は最後まで走る");
  const progress = events.filter((event) => event.type === "tool_progress").map((event) => String(event.data.text));
  assert.equal(
    progress.some((text) => text.includes(partial.slice(150))),
    false,
    `切り詰め後の中間断片が配られている: ${JSON.stringify(progress)}`,
  );
  // 4 文字以上の連続した断片をひとつも出さない (完全一致の検出は 4 文字未満を対象外にしている)
  for (const text of progress) {
    for (let at = 0; at + 4 <= secret.length; at += 1) {
      assert.ok(
        !text.includes(secret.slice(at, at + 4)),
        `秘密値の ${at}〜${at + 4} 文字目が progress に出ている: ${text}`,
      );
    }
  }
});
