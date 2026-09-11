import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker, REDACTED } from "../src/redact";
import { SessionStore } from "../src/sessions";
import type { PiRuntimeLike, PiSessionEvent, PiSessionEventListener, PiSessionLike } from "../src/sessions";
import type { EventEntry } from "../src/schema";
import { createAgentCatalog } from "../src/agents";
import { waitFor } from "./stub-pi";

const KEY = "sk-store-dummy-0123456789";
const masker = createSecretMasker([KEY]);

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

interface ScriptedSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
  abortRequested: boolean;
  isStreaming: boolean;
}

type RunScript = (session: ScriptedSession) => Promise<void>;

/** イベントとメッセージをテストごとに台本化できる最小セッション。 */
function createScriptedSession(run: RunScript): ScriptedSession {
  const listeners = new Set<PiSessionEventListener>();
  const session = {
    sessionId: "pi-scripted",
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>,
    isStreaming: false,
    abortRequested: false,
    disposed: false,
    get isIdle() {
      return !session.isStreaming;
    },
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ["low"],
    setThinkingLevel() {},
    async setModel() {},
    subscribe(listener: PiSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiSessionEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    async abort() {
      session.abortRequested = true;
    },
    dispose() {
      session.disposed = true;
    },
    async prompt(text: string) {
      session.isStreaming = true;
      session.abortRequested = false;
      try {
        session.messages.push({ role: "user", content: text });
        await run(session);
      } finally {
        session.isStreaming = false;
      }
    },
  };
  return session as unknown as ScriptedSession;
}

interface ScriptedAssistant {
  role: string;
  content: Array<{ type: string; text: string }>;
  stopReason: string;
  errorMessage?: string;
}

function startAssistant(session: ScriptedSession): ScriptedAssistant {
  session.emit({ type: "agent_start" });
  session.emit({ type: "message_start", message: { role: "assistant" } });
  const assistant: ScriptedAssistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
  session.messages.push(assistant);
  return assistant;
}

/** 差分をチャンクに分けてストリームする (SDK の text_delta を模倣)。 */
async function streamChunks(session: ScriptedSession, assistant: ScriptedAssistant, chunks: string[], chunkDelayMs = 0): Promise<void> {
  for (const chunk of chunks) {
    if (session.abortRequested) break;
    if (chunkDelayMs) await sleep(chunkDelayMs);
    if (session.abortRequested) break;
    assistant.content[0].text += chunk;
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
  }
  if (session.abortRequested) assistant.stopReason = "aborted";
  session.emit({ type: "message_end", message: { role: "assistant" } });
}

function emitToolEnd(
  session: ScriptedSession,
  { id, name, args, output, isError = false }: { id: string; name: string; args: unknown; output: string; isError?: boolean },
): void {
  session.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  session.emit({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    isError,
    result: { content: [{ type: "text", text: output }] },
  });
}

function settle(session: ScriptedSession): void {
  session.emit({ type: "agent_settled" });
}

function createStore(session: PiSessionLike): { store: SessionStore; events: EventEntry[] } {
  const pi = { createSession: async () => ({ session }) } as unknown as PiRuntimeLike;
  const store = new SessionStore({ pi, catalog: createAgentCatalog(), masker });
  const events: EventEntry[] = [];
  return { store, events };
}

/** すべての記録済みイベントと payload に生のキーが残っていないことを確認する。 */
function assertNoRawKey(events: EventEntry[], payload: unknown, label: string): void {
  for (const entry of events) {
    assert.ok(!JSON.stringify(entry).includes(KEY), `${label}: raw key in event seq=${entry.seq} (${entry.type})`);
  }
  assert.ok(!JSON.stringify(payload).includes(KEY), `${label}: raw key in payload`);
}

test("assistant text split across chunk boundaries is masked in SSE events", async () => {
  const text = `回答は ${KEY} です`;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 2) chunks.push(text.slice(index, index + 2));
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, chunks);
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "教えて");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const deltas = events
    .filter((entry) => entry.type === "text")
    .map((entry) => (entry.data as { delta: string }).delta)
    .join("");
  assert.equal(deltas, `回答は ${REDACTED} です`);
  const payload = store.payload(record);
  assertNoRawKey(events, payload, "chunked text");
  assert.equal(
    payload.messages.find((message) => message.role === "assistant")?.text,
    `回答は ${REDACTED} です`,
  );
  await store.close();
});

test("tool args and output (shell and non-shell) are masked in events and payloads", async () => {
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, ["調べます"]);
    emitToolEnd(s, {
      id: "call-1",
      name: "bash",
      args: { command: `echo ${KEY}` },
      output: `token=${KEY}`,
    });
    emitToolEnd(s, {
      id: "call-2",
      name: "read",
      args: { path: `/tmp/${KEY}.txt` },
      output: `file body ${KEY}`,
    });
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "実行して");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const toolStarts = events.filter((entry) => entry.type === "tool_start");
  const toolEnds = events.filter((entry) => entry.type === "tool_end");
  assert.equal(toolStarts.length, 2);
  assert.equal(toolEnds.length, 2);
  const payload = store.payload(record);
  assertNoRawKey(events, payload, "tool surfaces");
  // マスク後の形も確認する
  assert.equal(
    toolEnds.some((entry) => (entry.data as { output: string }).output.includes(`token=${REDACTED}`)),
    true,
  );
  assert.ok(payload.run?.toolCalls.every((call) => !call.output.includes(KEY)));
});

test("error messages are masked before run_end and status events", async () => {
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, ["失敗します"]);
    assistant.stopReason = "error";
    assistant.errorMessage = `Provider rejected: ${KEY}`;
    session.emit({ type: "extension_error", error: `ext failure ${KEY}` });
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "エラーを出して");
  await waitFor(() => store.statusOf(record) === "error", 3000, "run error");

  const runEnd = events.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.data.status, "error");
  assert.equal((runEnd?.data as { error?: string }).error, `Provider rejected: ${REDACTED}`);
  const payload = store.payload(record);
  assertNoRawKey(events, payload, "error surfaces");
});

test("user prompt is masked in echo surfaces but the model input stays as typed", async () => {
  const prompt = `私のキーは ${KEY} です`;
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, ["了解しました"]);
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, prompt);
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const runStart = events.find((entry) => entry.type === "run_start");
  assert.equal((runStart?.data as { prompt: string }).prompt, `私のキーは ${REDACTED} です`);
  const payload = store.payload(record);
  assert.equal(payload.title, `私のキーは ${REDACTED} です`);
  assert.equal(payload.run?.prompt, `私のキーは ${REDACTED} です`);
  assertNoRawKey(events, payload, "prompt echo");
  // モデルへ渡る入力はユーザー入力そのまま (ユーザー自身が貼ったキーは対象外)
  assert.equal(session.messages[0].content, prompt);
  await store.close();
});

test("aborting mid-stream does not leak the key through held-back chunks", async () => {
  const text = `途中 ${KEY} まで`;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 3) chunks.push(text.slice(index, index + 3));
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, chunks, 20);
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "止めて");
  await waitFor(() => store.statusOf(record) === "running", 3000, "run started");
  await sleep(60);
  await store.stop(record);
  await waitFor(() => store.statusOf(record) === "stopped", 3000, "run stopped");

  const payload = store.payload(record);
  assertNoRawKey(events, payload, "abort");
  await store.close();
});

test("args and output truncated at their limits are masked before truncation", async () => {
  // ARGS_TEXT_MAX (260) / SUMMARY_TEXT_MAX (900) の境界にキーが跨るケース。
  // 先に切り詰めると末尾が欠けてキーの大部分がそのまま残るため、
  // マスクを先に掛ける必要がある。
  const command = "b".repeat(240) + KEY;
  const outputText = "x".repeat(885) + KEY;
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, ["確認します"]);
    emitToolEnd(s, {
      id: "call-4",
      name: "bash",
      args: { command },
      output: outputText,
    });
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "境界を確認して");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const toolStart = events.find((entry) => entry.type === "tool_start");
  const toolEnd = events.find((entry) => entry.type === "tool_end");
  const args = (toolStart?.data as { args: string }).args;
  const output = (toolEnd?.data as { output: string }).output;
  // 切り詰め後のテキストにも完全体はおろか大部分も残らない
  assert.ok(!args.includes(KEY.slice(0, 20)), `args leaked: ${args}`);
  assert.ok(args.includes(REDACTED), `masked args expected: ${args}`);
  assert.ok(!output.includes(KEY.slice(0, 20)), `output leaked: ${output}`);
  assert.ok(output.includes(REDACTED), `masked output expected: ${output}`);
  assertNoRawKey(events, store.payload(record), "truncation boundary");
  await store.close();
});

test("output without secrets passes through unchanged", async () => {
  const session = createScriptedSession(async (s) => {
    const assistant = startAssistant(s);
    await streamChunks(s, assistant, ["合計 48", "\ndrwxr-x--- 8 node node 4096 ."]);
    emitToolEnd(s, {
      id: "call-3",
      name: "bash",
      args: { command: "ls -la" },
      output: "total 48\ndrwxr-x--- 8 node node 4096 .",
    });
    settle(s);
  });
  const { store, events } = createStore(session);
  const record = await store.create({ agentId: "agent-general" });
  store.subscribe(record, undefined, (entry) => events.push(entry));

  store.postMessage(record, "一覧を見せて");
  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const deltas = events
    .filter((entry) => entry.type === "text")
    .map((entry) => (entry.data as { delta: string }).delta)
    .join("");
  assert.equal(deltas, "合計 48\ndrwxr-x--- 8 node node 4096 .");
  const toolEnd = events.find((entry) => entry.type === "tool_end");
  assert.equal((toolEnd?.data as { output: string }).output, "total 48\ndrwxr-x--- 8 node node 4096 .");
  const payload = store.payload(record);
  assert.equal(payload.messages.find((message) => message.role === "assistant")?.text, "合計 48\ndrwxr-x--- 8 node node 4096 .");
  await store.close();
});
