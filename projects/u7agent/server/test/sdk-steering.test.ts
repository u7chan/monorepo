import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sendCorrection, type DeliveryMode } from "../../scripts/steering-send";

type Scenario = "generation" | "tools";
const ORIGINAL = "original";
const CORRECTION = "correction";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function pause(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const aborted = gate();
  const listener = signal && addAbortListener(signal, aborted.open);
  try {
    await Promise.race([promise, aborted.promise]);
    signal?.throwIfAborted();
  } finally {
    listener?.[Symbol.dispose]();
  }
}

function contentText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function createProbe(t: TestContext, scenario: Scenario, execution: "sequential" | "parallel" = "sequential") {
  const root = await mkdtemp(join(tmpdir(), "u7agent-steering-"));
  const trace: string[] = [];
  const requests: string[][] = [];
  const executedTools: number[] = [];
  const release = [gate(), gate()];
  const started = [gate(), gate()];
  const ended = [gate(), gate()];
  const thinking = gate();
  let session: AgentSession | undefined;
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("The steering probe must not make network requests");
  });
  t.after(async () => {
    try {
      await session?.abort();
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
      t.diagnostic(trace.join(" → "));
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("steering-probe", {
    api: "steering-probe",
    apiKey: "mock-only",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: true,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const users = context.messages.filter((message) => message.role === "user").map(contentText);
      requests.push(users);
      trace.push(`request:${requests.length}[${users.join(",")}]`);
      const first = requests.length === 1;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "pending",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        try {
          options?.signal?.throwIfAborted();
          stream.push({ type: "start", partial: message });
          if (first && scenario === "generation") {
            const block = { type: "thinking" as const, thinking: "" };
            message.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
            block.thinking = "original thinking";
            stream.push({ type: "thinking_delta", contentIndex: 0, delta: block.thinking, partial: message });
            await pause(release[0].promise, options?.signal);
            stream.push({ type: "thinking_end", contentIndex: 0, content: block.thinking, partial: message });
          }
          if (first && scenario === "tools") {
            for (const number of [1, 2]) {
              const index = message.content.length;
              const call = { type: "toolCall" as const, id: `work-${number}`, name: "work", arguments: { number } };
              message.content.push(call);
              stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
            }
            message.stopReason = "toolUse";
          } else {
            const index = message.content.length;
            const block = { type: "text" as const, text: "" };
            message.content.push(block);
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            block.text = users.includes(CORRECTION) ? "corrected-done" : "original-done";
            stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
            message.stopReason = "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  });

  const parameters = Type.Object({ number: Type.Integer({ minimum: 1, maximum: 2 }) });
  const work: ToolDefinition<typeof parameters> = {
    name: "work",
    label: "Work",
    description: "Gated mock work",
    parameters,
    async execute(_id, { number }, signal) {
      executedTools.push(number);
      started[number - 1].open();
      try {
        await pause(release[number - 1].promise, signal);
      } catch (error) {
        trace.push(`work:${number}:aborted`);
        throw error;
      }
      return { content: [{ type: "text", text: `work ${number} done` }], details: undefined };
    },
  };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Steering probe",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model: runtime.getModel("steering-probe", "mock"),
    thinkingLevel: "off",
    resourceLoader,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
    sessionManager: SessionManager.inMemory(root),
    tools: scenario === "tools" ? ["work"] : [],
    customTools: [work],
  }));
  session.agent.toolExecution = execution;
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") trace.push(`user:${contentText(event.message)}`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      trace.push(`assistant:${event.message.stopReason}:${contentText(event.message)}`);
      if (event.message.stopReason === "error") t.diagnostic(event.message.errorMessage ?? "Unknown SDK error");
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      trace.push("thinking:delta");
      thinking.open();
    }
    if (event.type === "tool_execution_start") trace.push(`tool:start:${event.toolCallId}`);
    if (event.type === "tool_execution_end") {
      trace.push(`tool:end:${event.toolCallId}`);
      ended[event.toolCallId === "work-1" ? 0 : 1].open();
    }
    if (event.type === "agent_settled") trace.push("settled");
  });
  return {
    session,
    trace,
    requests,
    executedTools,
    release,
    started,
    ended,
    paused: scenario === "generation" ? thinking.promise : started[0].promise,
  };
}

for (const scenario of ["generation", "tools"] as const) {
  for (const mode of ["queue", "steer", "interrupt"] satisfies DeliveryMode[]) {
    test(`${scenario}: ${mode}`, { timeout: 10_000 }, async (t) => {
      const f = await createProbe(t, scenario);
      const run = f.session.prompt(ORIGINAL);
      await f.paused;
      f.trace.push(`input:${mode}`);
      const correction = sendCorrection(f.session, run, CORRECTION, mode);

      if (mode !== "interrupt") {
        if (mode === "steer") {
          await correction;
          assert.deepEqual(f.session.getSteeringMessages(), [CORRECTION]);
        }
        assert.equal(f.requests.length, 1);
        assert.ok(!f.trace.includes(`user:${CORRECTION}`));
        f.release[0].open();
        if (scenario === "tools") {
          await f.started[1].promise;
          assert.equal(f.requests.length, 1, "同じ応答の 2 本目のツールも待つ");
          assert.ok(!f.trace.includes(`user:${CORRECTION}`));
          f.release[1].open();
        }
      }
      await Promise.all([run, correction]);

      const injection = f.trace.indexOf(`user:${CORRECTION}`);
      assert.ok(injection > f.trace.indexOf(`input:${mode}`));
      assert.equal(f.trace.slice(0, injection).includes("settled"), mode !== "steer");
      assert.equal(f.trace.filter((event) => event === `user:${CORRECTION}`).length, 1);
      assert.deepEqual(f.requests.at(-1), [ORIGINAL, CORRECTION]);
      assert.equal(f.session.getLastAssistantText(), "corrected-done");
      assert.equal(f.session.pendingMessageCount, 0);
      const errors = f.session.messages.flatMap((message) =>
        message.role === "assistant" && message.stopReason === "error" ? [message.errorMessage ?? ""] : [],
      );
      if (mode === "interrupt" && scenario === "tools") {
        // SDK が生成前の AbortError を error として残すため、stopReason だけでは停止を判定しない。
        for (const error of errors) assert.match(error, /aborted/i);
      } else {
        assert.equal(errors.length, 0);
      }
      const originalDone = f.trace.includes("assistant:stop:original-done");
      assert.equal(originalDone, mode === "queue" || (mode === "steer" && scenario === "generation"));
      if (scenario === "tools") {
        assert.deepEqual(f.executedTools, mode === "interrupt" ? [1] : [1, 2]);
        if (mode !== "interrupt") assert.ok(f.trace.indexOf("tool:end:work-2") < injection);
        else assert.ok(f.trace.includes("work:1:aborted"));
      } else if (mode === "interrupt") {
        assert.ok(f.trace.includes("assistant:aborted:"));
      }
    });
  }
}

test("parallel tools: steer waits for the entire batch", { timeout: 10_000 }, async (t) => {
  const f = await createProbe(t, "tools", "parallel");
  const run = f.session.prompt(ORIGINAL);
  await Promise.all(f.started.map((item) => item.promise));
  f.trace.push("input:steer");
  await sendCorrection(f.session, run, CORRECTION, "steer");
  f.release[0].open();
  await f.ended[0].promise;
  assert.equal(f.requests.length, 1);
  assert.ok(!f.trace.includes(`user:${CORRECTION}`));
  f.release[1].open();
  await run;
  assert.ok(f.trace.indexOf("tool:end:work-2") < f.trace.indexOf(`user:${CORRECTION}`));
  assert.equal(f.session.getLastAssistantText(), "corrected-done");
});

test("interrupt discards an undelivered steer rather than replaying it", { timeout: 10_000 }, async (t) => {
  const f = await createProbe(t, "generation");
  const run = f.session.prompt(ORIGINAL);
  await f.paused;
  await f.session.steer("stale-instruction");
  assert.equal(f.session.pendingMessageCount, 1);
  f.trace.push("input:interrupt");
  await sendCorrection(f.session, run, CORRECTION, "interrupt");
  await run;
  assert.equal(f.session.pendingMessageCount, 0);
  assert.ok(f.requests.every((users) => !users.includes("stale-instruction")));
  assert.ok(!f.trace.includes("user:stale-instruction"));
  assert.equal(f.session.getLastAssistantText(), "corrected-done");
});
