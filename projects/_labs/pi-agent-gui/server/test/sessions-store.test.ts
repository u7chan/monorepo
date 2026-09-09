import assert from "node:assert/strict";
import test from "node:test";
import { createAgentCatalog } from "../src/agents";
import { SessionStore } from "../src/sessions";
import type { PiSessionLike } from "../src/sessions";
import type { EventEntry } from "../src/schema";

/**
 * Minimal stub of the pi runtime/session used by the store. It mimics the
 * event flow of createAgentSession(): subscribe/prompt/abort + agent events.
 * Abort interrupts the in-flight chunk delay; the prompt loop then unwinds and
 * emits agent_settled itself, mirroring the real SDK.
 */
function createStubSession({ reply = "スタブの返答です", chunkDelayMs = 0 } = {}): PiSessionLike {
  const listeners = new Set<(event: unknown) => void>();
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>((resolveSleep) => {
    if (ms <= 0) {
      resolveSleep();
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      sleepers.delete(wake);
      resolveSleep();
    };
    const timer = setTimeout(wake, ms);
    timer.unref?.();
    sleepers.add(wake);
  });
  const session = {
    sessionId: `pi-${Math.random().toString(36).slice(2, 10)}`,
    model: { provider: "stub", id: "stub-model" },
    thinkingLevel: "low",
    messages: [] as Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }>,
    isStreaming: false,
    disposed: false,
    abortRequested: false,
    sessionManager: { getCwd: () => "/tmp/project" },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event);
    },
    async abort() {
      if (!session.isStreaming) return;
      session.abortRequested = true;
      for (const wake of [...sleepers]) wake();
    },
    dispose() {
      session.disposed = true;
    },
    async prompt(text: string) {
      session.abortRequested = false;
      session.isStreaming = true;
      try {
        session.messages.push({ role: "user", content: text });
        session.emit({ type: "agent_start" });
        session.emit({ type: "message_start", message: { role: "assistant" } });
        const assistant = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
        session.messages.push(assistant);
        const chunks = [reply.slice(0, 3), reply.slice(3)].filter(Boolean);
        for (const chunk of chunks) {
          await sleep(chunkDelayMs);
          if (session.abortRequested) break;
          assistant.content[0].text += chunk;
          session.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
        if (session.abortRequested) assistant.stopReason = "aborted";
      } finally {
        session.emit({ type: "agent_settled" });
        session.isStreaming = false;
      }
    },
  };
  return session as unknown as PiSessionLike;
}

function createStubPi(options = {}) {
  const sessions: PiSessionLike[] = [];
  return {
    cwd: "/tmp/project",
    selectedModel: { provider: "stub", id: "stub-model" },
    availableModels: [{ provider: "stub", id: "stub-model" }],
    tools: ["read"],
    sessions,
    createSession: async () => {
      const session = createStubSession(options);
      sessions.push(session);
      return { session };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

test("runs a message in the background and records the conversation history", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 5 }), catalog });
  const record = await store.create({ agentId: "agent-cat" });

  const result = store.postMessage(record, "こんにちは");
  assert.equal(result.queued, false);
  assert.equal(store.statusOf(record), "running", "the run must keep going without any subscriber");

  await waitFor(() => store.statusOf(record) === "completed", 3000, "run completion");

  const payload = store.payload(record);
  assert.equal(payload.status, "completed");
  assert.deepEqual(
    payload.messages.map((message) => [message.role, message.text]),
    [["user", "こんにちは"], ["assistant", "スタブの返答です"]],
  );
  assert.equal(payload.title, "こんにちは");
  assert.ok(payload.lastSeq > 0);

  const allEvents: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => allEvents.push(entry));
  const types = allEvents.map((entry) => entry.type);
  assert.ok(types.includes("run_start"));
  assert.ok(types.includes("text"));
  assert.ok(types.includes("run_end"));
  const runEnd = allEvents.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.data.status, "completed");

  // A client at the latest cursor receives no replay.
  const fresh: typeof allEvents = [];
  store.subscribe(record, payload.lastSeq, (entry) => fresh.push(entry));
  assert.equal(fresh.length, 0);

  await store.close();
});

test("messages posted during a run are queued and executed sequentially", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 20 }), catalog });
  const record = await store.create({ agentId: "agent-builder" });

  const first = store.postMessage(record, "1つ目");
  assert.equal(first.queued, false);
  const second = store.postMessage(record, "2つ目");
  assert.equal(second.queued, true);
  assert.equal(second.queueDepth, 1);
  const third = store.postMessage(record, "3つ目");
  assert.equal(third.queueDepth, 2);
  assert.equal(store.statusOf(record), "running");

  await waitFor(
    () => record.session.messages.filter((message) => message.role === "user").length === 3,
    5000,
    "all queued messages to run",
  );
  await waitFor(() => store.statusOf(record) === "completed", 5000, "final completion");

  const userTexts = record.session.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  assert.deepEqual(userTexts, ["1つ目", "2つ目", "3つ目"]);
  const queuedEvents: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => queuedEvents.push(entry));
  assert.equal(queuedEvents.filter((entry) => entry.type === "queued").length, 2);

  await store.close();
});

test("stop aborts the active run and clears the queue", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 50 }), catalog });
  const record = await store.create({ agentId: "agent-builder" });

  store.postMessage(record, "止まるメッセージ");
  store.postMessage(record, "キャンセルされるメッセージ");
  assert.equal(record.queue.length, 1);

  const stopResult = await store.stop(record);
  assert.equal(stopResult.ok, true);

  await waitFor(() => store.statusOf(record) === "stopped", 3000, "stopped status");
  assert.equal(record.queue.length, 0, "queued messages are dropped on stop");

  const events: EventEntry[] = [];
  store.subscribe(record, 0, (entry) => events.push(entry));
  const runEnd = events.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.data.status, "stopped");

  // The session can still accept new work afterwards.
  store.postMessage(record, "次のメッセージ");
  await waitFor(() => store.statusOf(record) === "completed", 5000, "recovery run");
  assert.equal(store.payload(record).messages.at(-1)?.text, "スタブの返答です");

  await store.close();
});

test("destroy aborts, disposes and notifies subscribers", async () => {
  const catalog = createAgentCatalog();
  const store = new SessionStore({ pi: createStubPi({ chunkDelayMs: 30 }), catalog });
  const record = await store.create({ agentId: "agent-cat" });
  store.postMessage(record, "削除される会話");

  const seen: EventEntry[] = [];
  let closed = false;
  const unsubscribe = store.subscribe(
    record,
    undefined,
    (entry) => seen.push(entry),
    () => {
      closed = true;
    },
  );

  await store.destroy(record);
  assert.equal(store.get(record.id), undefined);
  assert.ok(record.session.disposed);
  assert.equal(closed, true);
  assert.equal(seen.at(-1)?.type, "session_deleted");
  unsubscribe();

  await store.close();
});
