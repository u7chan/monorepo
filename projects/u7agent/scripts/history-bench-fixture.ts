import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { PiSessionLike } from "../server/src/pi-runtime";
import { createSecretMasker } from "../server/src/redact";
import type { SessionRecord } from "../server/src/session-record";
import { contentText } from "../server/src/session-projection";

export type HistoryProfile = "plain" | "mixed";
export type HistoryMutation = "append" | "context_edit" | "compaction" | "run_metadata";

const CWD = "/bench/u7agent";
const TIMESTAMP = 1_700_000_000_000;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const TOOL_RESULT_CHARS = 2048;
const SUMMARY_CHARS = 8192;
const COMPACTION_EVERY_TURNS = 25;
const SECRETS = Array.from({ length: 8 }, (_, index) => `bench-dummy-secret-${index}-not-a-real-key`);
const usage: AssistantMessage["usage"] = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function body(index: number, chars: number): string {
  return `${index}: ${"あ".repeat(chars)}`.slice(0, chars);
}

function summary(index: number): string {
  const prefix = `summary-${index} ${SECRETS.join(" ")} `;
  return prefix + "要".repeat(SUMMARY_CHARS - prefix.length);
}

function assistant(index: number, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "bench",
    model: "synthetic",
    usage,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: TIMESTAMP + index,
  };
}

function unused(): never {
  throw new Error("The projection benchmark must not run an agent or access persistence");
}

function managerOf(entries: SessionEntry[]): SessionManager {
  return SessionManager.inMemory(CWD, { id: SESSION_ID }, [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: SESSION_ID,
      cwd: CWD,
      timestamp: new Date(TIMESTAMP).toISOString(),
    },
    ...entries,
  ]);
}

function entryBase(entries: SessionEntry[]) {
  return {
    id: `entry-${entries.length}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date(TIMESTAMP + entries.length).toISOString(),
  };
}

function recordOf(sessionManager: NonNullable<PiSessionLike["sessionManager"]>): SessionRecord {
  const session: PiSessionLike = {
    sessionId: SESSION_ID,
    sessionManager,
    messages: [],
    isStreaming: false,
    isIdle: true,
    subscribe: unused,
    prompt: unused,
    abort: unused,
    setModel: unused,
    setThinkingLevel: unused,
    getAvailableThinkingLevels: unused,
    supportsThinking: unused,
  };
  const agent = { id: "bench", name: "bench", description: "synthetic" };
  const promptSnapshot = { agent: "" };
  return {
    id: "bench",
    session,
    agentId: agent.id,
    workdir: "",
    storeDir: "",
    promptSnapshot,
    meta: {
      version: 1,
      id: "bench",
      title: "bench",
      createdAt: TIMESTAMP,
      lastUsedAt: TIMESTAMP,
      messageCount: 0,
      agentId: agent.id,
      agent,
      promptSnapshot,
    },
    generation: "bench",
    persistTail: Promise.resolve(),
    agent,
    title: "bench",
    titleOrigin: "auto",
    createdAt: TIMESTAMP,
    lastUsedAt: TIMESTAMP,
    seq: 0,
    events: [],
    subscribers: new Set(),
    queue: [],
    run: null,
    tools: new Map(),
    toolTimings: new Map(),
    questions: new Map(),
    messageMetrics: new WeakMap(),
    savedMetrics: new Map(),
    userMessageSends: new WeakMap(),
    assistantMessageIds: new WeakMap(),
    entrySends: new Map(),
    runInitialSends: new Map(),
    injectedSends: new Set(),
    stopping: false,
    cancelling: 0,
    unsentSends: [],
    sendsDirty: false,
    compactionMeta: new Map(),
    runOutcomes: new Map(),
    changingSettings: false,
    compacting: false,
    notify: false,
    pinned: false,
  };
}

function registerMessages(record: SessionRecord, entries: SessionEntry[]): void {
  let runId = "";
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      runId = `run-${entry.id}`;
      const sendId = `send-${entry.id}`;
      record.userMessageSends.set(entry.message, { sendId, runId });
      record.runInitialSends.set(runId, sendId);
      record.runOutcomes.set(runId, { outcome: "completed", durationMs: 1000 });
    } else if (entry.message.role === "assistant") {
      record.assistantMessageIds.set(entry.message, `${runId}:${entry.id}`);
    }
  }
}

export function createHistoryFixture(count: number, profile: HistoryProfile, textChars: number) {
  assert.ok(Number.isSafeInteger(count) && count >= 4, "SIZES must contain integers >= 4");
  assert.ok(Number.isSafeInteger(textChars) && textChars > 0, "TEXT_CHARS must be a positive integer");
  const entries: SessionEntry[] = [];
  function base() {
    return entryBase(entries);
  }
  function addTurn(withTool: boolean): void {
    const user: SessionMessageEntry = {
      ...base(),
      type: "message",
      message: { role: "user", content: body(entries.length, textChars), timestamp: TIMESTAMP + entries.length },
    };
    entries.push(user);
    if (withTool) {
      const toolCallId = `tool-${entries.length}`;
      entries.push({
        ...base(),
        type: "message",
        message: assistant(entries.length, [
          { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `echo ${SECRETS[0]}` } },
        ]),
      });
      entries.push({
        ...base(),
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "bash",
          content: [
            { type: "text", text: `${SECRETS[0]} ${"結".repeat(TOOL_RESULT_CHARS)}`.slice(0, TOOL_RESULT_CHARS) },
          ],
          isError: false,
          timestamp: TIMESTAMP + entries.length,
        },
      });
    }
    entries.push({
      ...base(),
      type: "message",
      message: assistant(entries.length, [{ type: "text", text: body(entries.length, textChars) }]),
    });
  }
  let turns = 0;
  const turnSize = profile === "mixed" ? 4 : 2;
  while (entries.length + turnSize <= count - 2) {
    addTurn(profile === "mixed");
    turns += 1;
    if (profile === "mixed" && turns % COMPACTION_EVERY_TURNS === 0 && entries.length < count - 2) {
      const firstKept = entries.slice(-20).find((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(firstKept);
      entries.push({
        ...base(),
        type: "compaction",
        summary: summary(entries.length),
        firstKeptEntryId: firstKept.id,
        tokensBefore: 10_000,
      });
    }
  }
  while (entries.length + 2 <= count - 2) addTurn(false);
  if (entries.length < count - 2) {
    entries.push({ ...base(), type: "model_change", provider: "bench", modelId: "synthetic" });
  }
  addTurn(false);
  let manager = managerOf(entries);
  // SDK の append は ID / 時刻を固定できない。窓口の参照は変えず、合成 entry だけを差し替える。
  const record = recordOf({ getBranch: () => manager.getBranch() });
  record.session.messages = manager.buildSessionContext().messages as PiSessionLike["messages"];
  registerMessages(record, entries);
  assert.equal(manager.getEntryCount(), count);
  return {
    record,
    get manager() {
      return manager;
    },
    replaceBranch(entries: SessionEntry[]): void {
      manager = managerOf(entries);
      record.session.messages = manager.buildSessionContext().messages as PiSessionLike["messages"];
    },
    profile,
    textChars,
    masker: createSecretMasker(profile === "mixed" ? SECRETS : []),
    cwd: CWD,
  };
}

export type HistoryFixture = ReturnType<typeof createHistoryFixture>;

export function mutateHistoryFixture(fixture: HistoryFixture, mutation: HistoryMutation): void {
  const { record, manager, textChars } = fixture;
  const entries = manager.getBranch();
  const lastUser = entries.findLast((entry) => entry.type === "message" && entry.message.role === "user");
  const lastAnswer = entries.findLast(
    (entry) =>
      entry.type === "message" && entry.message.role === "assistant" && contentText(entry.message.content) !== "",
  );
  assert.ok(lastUser?.type === "message" && lastAnswer?.type === "message");
  if (mutation === "append") {
    entries.push({
      ...entryBase(entries),
      type: "message",
      message: { role: "user", content: body(entries.length, textChars), timestamp: TIMESTAMP + entries.length },
    });
    entries.push({
      ...entryBase(entries),
      type: "message",
      message: assistant(entries.length, [{ type: "text", text: body(entries.length, textChars) }]),
    });
    registerMessages(record, entries.slice(-2));
  } else if (mutation === "context_edit") {
    entries.push({ ...entryBase(entries), type: "context_edit", targetId: lastAnswer.id, replacement: null });
  } else if (mutation === "compaction") {
    const compaction = {
      ...entryBase(entries),
      type: "compaction" as const,
      summary: summary(entries.length),
      firstKeptEntryId: lastUser.id,
      tokensBefore: 20_000,
    };
    entries.push(compaction);
    record.compactionMeta.set(compaction.id, { reason: "manual", durationMs: 1234, estimatedTokensAfter: 500 });
  } else {
    const sendId = "updated-send";
    const runId = "updated-run";
    record.userMessageSends.set(lastUser.message, { sendId, runId });
    record.runInitialSends.set(runId, sendId);
    record.runOutcomes.set(runId, { outcome: "stopped", durationMs: 9876 });
    record.assistantMessageIds.set(lastAnswer.message, "updated-assistant");
    record.messageMetrics.set(lastAnswer.message, { durationMs: 321, source: "measured" });
  }
  if (mutation !== "run_metadata") {
    fixture.replaceBranch(entries);
  }
}

function lengths(values: number[]) {
  return values.reduce(
    (result, value) => ({
      min: Math.min(result.min, value),
      max: Math.max(result.max, value),
      total: result.total + value,
    }),
    { min: values[0] ?? 0, max: 0, total: 0 },
  );
}

export function historyFixtureStats(fixture: HistoryFixture) {
  const entries = fixture.manager.getBranch();
  const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const compactions = entries.filter((entry) => entry.type === "compaction");
  const tools = messages.filter((message) => message.role === "toolResult");
  return {
    entries: entries.length,
    messages: messages.length,
    compactions: compactions.length,
    metadataEntries: entries.length - messages.length - compactions.length,
    textChars: fixture.textChars,
    messageTextChars: lengths(
      messages
        .filter((message) => message.role !== "toolResult")
        .map((message) => contentText("content" in message ? message.content : undefined).length),
    ),
    toolResults: tools.length,
    toolResultChars: lengths(tools.map((message) => contentText(message.content).length)),
    summaryChars: lengths(compactions.map((entry) => entry.summary.length)),
    registeredSecrets: fixture.masker.secrets.length,
  };
}
