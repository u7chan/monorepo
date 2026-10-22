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
import { createAgentCatalog } from "../src/agents";
import { createSessionSettings, SESSION_STEERING_MODE } from "../src/agent";
import type { PiRuntimeLike } from "../src/pi-runtime";
import { createSecretMasker, REDACTED, type SecretMasker } from "../src/redact";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import type { EventEntry } from "../src/schema";
import { SessionStore } from "../src/sessions";
import { waitFor } from "./stub-pi";

type Scenario = "generation" | "tools" | "secret-tail";
const ORIGINAL = "original";
const CORRECTION = "correction";
const TAIL_SECRET = "sk-test-tail-secret";
const TAIL_DELTA = `回答は ${TAIL_SECRET.slice(0, 8)}`;
const TAIL_FINAL = `回答は ${TAIL_SECRET} です`;
const TAIL_MASKED = `回答は ${REDACTED} です`;

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

interface ProbeOptions {
  execution?: "sequential" | "parallel";
  /** 秘密値の途中の delta を流した後、テストから中断させるまで最終本文を返さない */
  holdAfterDelta?: boolean;
  /**
   * 2 ターン目の準備 (prepareNextTurn) で 1 回だけ止める。SDK が実キューから steering を
   * ドレインした後・注入する前の窓を再現する
   */
  holdPrepareNextTurn?: boolean;
}

async function createProbe(t: TestContext, scenario: Scenario, options: ProbeOptions = {}) {
  const execution = options.execution ?? "sequential";
  const holdAfterDelta = options.holdAfterDelta ?? false;
  const root = await mkdtemp(join(tmpdir(), "u7agent-steering-"));
  const trace: string[] = [];
  const requests: string[][] = [];
  const executedTools: number[] = [];
  const release = [gate(), gate()];
  const started = [gate(), gate()];
  const ended = [gate(), gate()];
  const thinking = gate();
  const deltaStreamed = gate();
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
            if (scenario === "secret-tail") {
              // 差分は秘密値の途中で止め、残りは最終本文にだけ載せる
              block.text = TAIL_DELTA;
              stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
              deltaStreamed.open();
              if (holdAfterDelta) await pause(release[0].promise, options?.signal);
              block.text = TAIL_FINAL;
            } else {
              block.text = users.includes(CORRECTION) ? "corrected-done" : "original-done";
              stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
            }
            stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
            message.stopReason = "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          if (scenario === "secret-tail") {
            // 上流から受け取った本文は差分より先に進んでいる (中断しても最終本文は全文)
            for (const part of message.content) if (part.type === "text") part.text = TAIL_FINAL;
          }
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
    // BFF と同じ in-memory 設定を使う (probe では retry と cache warming だけ止める)
    settingsManager: SettingsManager.inMemory({
      ...createSessionSettings({ enabled: false }),
      retry: { enabled: false },
      cacheWarming: "off",
    }),
    sessionManager: SessionManager.inMemory(root),
    tools: scenario === "tools" ? ["work"] : [],
    customTools: [work],
  }));
  session.agent.toolExecution = execution;
  const preparing = gate();
  const resumePreparation = gate();
  if (options.holdPrepareNextTurn) {
    const refresh = session.agent.prepareNextTurnWithContext;
    let held = false;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (!held) {
        held = true;
        preparing.open();
        await pause(resumePreparation.promise, signal);
      }
      return await refresh?.(turn, signal);
    };
  }
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
    preparing,
    resumePreparation,
    paused:
      scenario === "generation"
        ? thinking.promise
        : scenario === "secret-tail"
          ? deltaStreamed.promise
          : started[0].promise,
  };
}

for (const scenario of ["generation", "tools"] as const) {
  for (const mode of ["queue", "steer", "interrupt"] satisfies DeliveryMode[]) {
    const description = mode === "queue" ? `${scenario}: queue after normal completion` : `${scenario}: ${mode}`;
    test(description, { timeout: 10_000 }, async (t) => {
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
  const f = await createProbe(t, "tools", { execution: "parallel" });
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

test("follow-up waits for the original final response without closing the run", { timeout: 10_000 }, async (t) => {
  const f = await createProbe(t, "tools");
  const run = f.session.prompt(ORIGINAL);
  await f.paused;
  f.trace.push("input:follow-up");
  await f.session.followUp(CORRECTION);
  assert.deepEqual(f.session.getFollowUpMessages(), [CORRECTION]);
  assert.ok(!f.trace.includes(`user:${CORRECTION}`));

  f.release[0].open();
  await f.started[1].promise;
  assert.equal(f.requests.length, 1);
  assert.ok(!f.trace.includes(`user:${CORRECTION}`));
  f.release[1].open();
  await run;

  const injection = f.trace.indexOf(`user:${CORRECTION}`);
  const originalDone = f.trace.indexOf("assistant:stop:original-done");
  assert.ok(originalDone > f.trace.indexOf("tool:end:work-2"));
  assert.ok(injection > originalDone);
  assert.ok(!f.trace.slice(0, injection).includes("settled"));
  assert.deepEqual(f.requests, [[ORIGINAL], [ORIGINAL], [ORIGINAL, CORRECTION]]);
  assert.equal(f.session.pendingMessageCount, 0);
  assert.equal(f.session.getLastAssistantText(), "corrected-done");
});

test("abort alone leaves undelivered steer and follow-up available for recovery", { timeout: 10_000 }, async (t) => {
  const f = await createProbe(t, "generation");
  const run = f.session.prompt(ORIGINAL);
  await f.paused;
  await f.session.steer("stale-steer");
  await f.session.followUp("stale-follow-up");
  f.trace.push("input:abort");
  await f.session.abort();
  await run;

  assert.equal(f.session.isIdle, true);
  assert.deepEqual(f.session.getSteeringMessages(), ["stale-steer"]);
  assert.deepEqual(f.session.getFollowUpMessages(), ["stale-follow-up"]);
  assert.equal(f.session.pendingMessageCount, 2);
  assert.deepEqual(f.requests, [[ORIGINAL]]);
  assert.deepEqual(f.session.clearQueue(), { steering: ["stale-steer"], followUp: ["stale-follow-up"] });
  assert.equal(f.session.pendingMessageCount, 0);

  f.trace.push("input:reprompt");
  await f.session.prompt(CORRECTION);
  assert.deepEqual(f.requests, [[ORIGINAL], [ORIGINAL, CORRECTION]]);
  assert.equal(f.session.getLastAssistantText(), "corrected-done");
});

test("parallel tools: interrupt cancels both tools before reprompting", { timeout: 10_000 }, async (t) => {
  const f = await createProbe(t, "tools", { execution: "parallel" });
  const run = f.session.prompt(ORIGINAL);
  await Promise.all(f.started.map((item) => item.promise));
  f.trace.push("input:interrupt");
  await sendCorrection(f.session, run, CORRECTION, "interrupt");
  await run;

  const injection = f.trace.indexOf(`user:${CORRECTION}`);
  assert.deepEqual(f.executedTools.toSorted(), [1, 2]);
  for (const number of [1, 2]) {
    assert.ok(f.trace.includes(`work:${number}:aborted`));
    const end = f.trace.indexOf(`tool:end:work-${number}`);
    assert.ok(end > f.trace.indexOf("input:interrupt"));
    assert.ok(injection > end);
  }
  assert.ok(f.trace.slice(0, injection).includes("settled"));
  assert.ok(!f.trace.includes("assistant:stop:original-done"));
  assert.deepEqual(f.requests.at(-1), [ORIGINAL, CORRECTION]);
  assert.equal(f.session.pendingMessageCount, 0);
  assert.equal(f.session.getLastAssistantText(), "corrected-done");
});

test("セッションの in-memory 設定は共有定数の steering モードを SDK へ渡す", () => {
  const settings = SettingsManager.inMemory(createSessionSettings({ enabled: false }));
  assert.equal(settings.getSteeringMode(), SESSION_STEERING_MODE);
  assert.equal(SESSION_STEERING_MODE, "all", "受付済みの steering を 1 回のモデル判断へまとめる");
});

// ---------------------------------------------------------------------------
// BFF (SessionStore) と実 SDK をつないだ受入。スタブの steer() 呼び出しではなく、
// 元の agent_settled を待たずに次のモデル要求へ修正指示が入ることを固定する。
// ---------------------------------------------------------------------------

async function storeOverRealSession(
  t: TestContext,
  scenario: Scenario,
  options: ProbeOptions & { masker?: SecretMasker; storeDir?: string } = {},
) {
  const probe = await createProbe(t, scenario, options);
  const runtime = {
    // 実 SDK の AgentSession をそのまま BFF のセッションとして渡す
    createSession: async () => ({ session: probe.session }),
  } as unknown as PiRuntimeLike;
  const store = new SessionStore({
    pi: runtime,
    catalog: createAgentCatalog(),
    // 未送信の記録 (pendingSends) を見るテストだけ永続化を有効にする
    storeDir: options.storeDir ?? null,
    rootCwd: "/tmp",
    // 永続化を有効にすると作業フォルダの作成が要る (サンドボックスは使わない)
    workspace: {
      createDir: async (path: string) => ({ path }),
      listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    } as unknown as SandboxWorkspaceClient,
    ...(options.masker ? { masker: options.masker } : {}),
  });
  const record = await store.create();
  const events: EventEntry[] = [];
  store.subscribe(record, `${record.generation}:${record.seq}`, (entry) => events.push(entry));
  return { ...probe, store, record, events };
}

test("BFF: 生成中の追加入力は元の応答の後・終端より前に次のモデル要求へ入る", { timeout: 15_000 }, async (t) => {
  const f = await storeOverRealSession(t, "generation");

  const first = f.store.postMessage(f.record, ORIGINAL);
  await f.paused;
  const second = f.store.postMessage(f.record, CORRECTION);
  assert.equal(second.queued, true, "追加入力は BFF の待機に入る");
  f.release[0].open();

  // 元の応答が終わったあと、確定 (settled) より前に修正指示つきの要求が出る
  await waitFor(() => f.requests.length >= 2, 10_000, "second model request");
  const corrected = f.requests.findIndex((users) => users.includes(CORRECTION));
  assert.ok(corrected >= 1, "修正指示を含むモデル要求が出る");
  assert.deepEqual(f.requests[corrected], [ORIGINAL, CORRECTION]);
  const injection = f.trace.indexOf(`user:${CORRECTION}`);
  assert.ok(injection > 0);
  assert.ok(f.trace.indexOf("assistant:stop:original-done") < injection, "元の応答を中断しない");
  assert.ok(!f.trace.slice(0, injection).includes("settled"), "agent_settled を待たずに注入する");

  await waitFor(() => f.store.statusOf(f.record) === "completed", 10_000, "run completion");
  const runStarts = f.events.filter((entry) => entry.type === "run_start");
  const runEnds = f.events.filter((entry) => entry.type === "run_end");
  assert.equal(runStarts.length, 1, "追加入力は新しい run を始めない");
  assert.equal(runEnds.length, 1, "実行の終端は 1 回");
  assert.equal(runStarts[0]?.type === "run_start" ? runStarts[0].data.initialSendId : undefined, first.sendId);

  const result = f.store.history(f.record, {});
  assert.ok(result.ok);
  const users = result.page.items.filter(
    (item): item is Extract<(typeof result.page.items)[number], { kind: "message" }> =>
      item.kind === "message" && item.role === "user",
  );
  assert.deepEqual(
    users.map((item) => [item.text, item.sendId]),
    [
      [ORIGINAL, first.sendId],
      [CORRECTION, second.sendId],
    ],
  );
  assert.equal(users[0]?.runId, users[1]?.runId, "1 つの実行に異なる送信IDが対応する");
  assert.equal(users[0]?.runDurationMs !== undefined, true);
  assert.equal(users[1]?.runDurationMs, undefined, "所要時間は開始送信だけ");
  assert.equal(f.session.pendingMessageCount, 0);
});

test("BFF: 逐次ツールの全完了後・並列バッチの完了後に追加入力を渡す", { timeout: 15_000 }, async (t) => {
  for (const execution of ["sequential", "parallel"] as const) {
    await t.test(execution, { timeout: 15_000 }, async (t2) => {
      const f = await storeOverRealSession(t2, "tools", { execution });
      f.store.postMessage(f.record, ORIGINAL);
      if (execution === "sequential") {
        await f.paused;
      } else {
        await Promise.all(f.started.map((item) => item.promise));
      }
      f.store.postMessage(f.record, CORRECTION);
      // 1 本目のツールを終えても、同じ応答の残りが終わるまで注入しない
      f.release[0].open();
      await f.ended[0].promise;
      assert.equal(f.requests.length, 1, "ツールの途中で次のモデル要求を始めない");
      assert.ok(!f.trace.includes(`user:${CORRECTION}`));
      f.release[1].open();

      await waitFor(() => f.requests.length >= 2, 10_000, "second model request");
      const injection = f.trace.indexOf(`user:${CORRECTION}`);
      assert.ok(f.trace.indexOf("tool:end:work-2") < injection, "バッチ全体の完了後に入力する");
      assert.ok(!f.trace.slice(0, injection).includes("settled"));
      assert.deepEqual(f.requests.at(-1), [ORIGINAL, CORRECTION]);
      await waitFor(() => f.store.statusOf(f.record) === "completed", 10_000, "run completion");
    });
  }
});

test("BFF: 複数の追加入力を 1 回のモデル要求へまとめ、受付順で欠落・重複なく渡す", { timeout: 15_000 }, async (t) => {
  const f = await storeOverRealSession(t, "generation");
  assert.equal(f.session.steeringMode, SESSION_STEERING_MODE, "BFF と同じ設定で probe セッションを作る");
  const first = f.store.postMessage(f.record, ORIGINAL);
  await f.paused;
  const a = f.store.postMessage(f.record, CORRECTION);
  const b = f.store.postMessage(f.record, CORRECTION);
  assert.notEqual(a.sendId, b.sendId, "同じ本文でも送信IDは別");
  assert.equal(f.store.payload(f.record).queueDepth, 2);
  f.release[0].open();

  await waitFor(() => f.requests.length >= 2, 10_000, "second model request");
  assert.deepEqual(f.requests, [[ORIGINAL], [ORIGINAL, CORRECTION, CORRECTION]], "2 件は 1 回のモデル要求にまとまる");
  assert.equal(f.trace.filter((line) => line === `user:${CORRECTION}`).length, 2, "2 件とも 1 回ずつ注入する");
  await waitFor(() => f.store.statusOf(f.record) === "completed", 10_000, "run completion");
  const history = f.store.history(f.record, {});
  assert.ok(history.ok);
  const userItems = history.page.items.filter(
    (item): item is Extract<(typeof history.page.items)[number], { kind: "message" }> =>
      item.kind === "message" && item.role === "user",
  );
  assert.deepEqual(
    userItems.map((item) => item.sendId),
    [first.sendId, a.sendId, b.sendId],
    "受付順に 1 回ずつ残る",
  );
});

test("BFF: ドレイン済みの追加入力は、後続の取消で渡し直さない", { timeout: 15_000 }, async (t) => {
  // pendingSends (未送信の記録) を見るためだけに一時ストアを有効にする
  const storeDir = await mkdtemp(join(tmpdir(), "u7agent-steering-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const f = await storeOverRealSession(t, "generation", { holdPrepareNextTurn: true, storeDir });
  const first = f.store.postMessage(f.record, ORIGINAL);
  await f.paused;
  const a = f.store.postMessage(f.record, CORRECTION);
  await waitFor(
    () => f.record.queue.some((item) => item.sendId === a.sendId && item.steered === true),
    5000,
    "A accepted",
  );
  // 1 回目の応答を終わらせ、2 ターン目の準備で止める。この時点で A は SDK にドレイン済み
  f.release[0].open();
  await f.preparing.promise;

  const b = f.store.postMessage(f.record, "B");
  await waitFor(
    () => f.record.queue.some((item) => item.sendId === b.sendId && item.steered === true),
    5000,
    "B accepted",
  );
  assert.deepEqual(
    (f.store.payload(f.record).pendingSends ?? [])
      .filter((item) => item.sendId === a.sendId || item.sendId === b.sendId)
      .map((item) => [item.text, item.state]),
    [
      [CORRECTION, "steering"],
      ["B", "queued"],
    ],
    "ドレイン済みの A は反映中、実キューに残る B だけが取り消せる",
  );

  assert.equal(await f.store.cancelQueued(f.record, b.sendId), "ok");
  f.resumePreparation.open();
  await waitFor(() => f.store.statusOf(f.record) === "completed", 10_000, "run completion");
  await f.store.flush(f.record);

  // What: B の取消で実キューを捨てても、ドレイン済みの A を渡し直さない (A が 2 回入らない)
  assert.deepEqual(f.requests, [[ORIGINAL], [ORIGINAL, CORRECTION]]);
  const history = f.store.history(f.record, {});
  assert.ok(history.ok);
  const users = history.page.items.filter(
    (item): item is Extract<(typeof history.page.items)[number], { kind: "message" }> =>
      item.kind === "message" && item.role === "user",
  );
  assert.deepEqual(
    users.map((item) => [item.text, item.sendId]),
    [
      [ORIGINAL, first.sendId],
      [CORRECTION, a.sendId],
    ],
    "A は 1 回だけ注入し、取り消した B は履歴に残さない",
  );
});

/** openai-completions adapter が解釈できる最小の完了ストリーム */
function chatCompletionSse(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

interface ChatRequestBody {
  messages: Array<{ role: string; content: unknown }>;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

test("BFF: 組み込み provider adapter の次のモデル要求に修正指示と先行会話が入る", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "u7agent-adapter-"));
  const requests: ChatRequestBody[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.match(url, /\/chat\/completions$/, "組み込み adapter の経路だけを使う");
    requests.push(JSON.parse(String(init?.body ?? "{}")) as ChatRequestBody);
    if (requests.length === 1) await firstGate;
    return new Response(chatCompletionSse(requests.length === 1 ? "original-done" : "corrected-done"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  let session: AgentSession | undefined;
  let store: SessionStore | undefined;
  t.after(async () => {
    await store?.close().catch(() => {});
    session?.dispose();
    assert.equal(fetchMock.mock.callCount() >= 1, true);
    assert.ok(requests.every((body) => body.messages.some((message) => message.role === "user")));
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("adapter-probe", {
    api: "openai-completions",
    apiKey: "mock-only",
    baseUrl: "https://example.invalid/v1",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model: runtime.getModel("adapter-probe", "mock"),
    thinkingLevel: "off",
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
    sessionManager: SessionManager.inMemory(root),
    tools: [],
    customTools: [],
  }));

  store = new SessionStore({
    pi: { createSession: async () => ({ session }) } as unknown as PiRuntimeLike,
    catalog: createAgentCatalog(),
    storeDir: null,
    rootCwd: root,
  });
  const record = await store.create();
  const first = store.postMessage(record, ORIGINAL);
  await waitFor(() => requests.length === 1, 5000, "first provider request");
  const second = store.postMessage(record, CORRECTION);
  assert.equal(second.queued, true);
  releaseFirst();

  await waitFor(() => requests.length >= 2, 10_000, "second provider request");
  const users = requests[1].messages
    .filter((message) => message.role === "user")
    .map((message) => textOfContent(message.content));
  assert.deepEqual(users, [ORIGINAL, CORRECTION], "修正指示が先行する会話の後ろに入る");
  await waitFor(() => store.statusOf(record) === "completed", 10_000, "run completion");
  const history = store.history(record, {});
  assert.ok(history.ok);
  const userItems = history.page.items.filter(
    (item): item is Extract<(typeof history.page.items)[number], { kind: "message" }> =>
      item.kind === "message" && item.role === "user",
  );
  assert.deepEqual(
    userItems.map((item) => item.sendId),
    [first.sendId, second.sendId],
  );
});

// ---------------------------------------------------------------------------
// 秘密値のマスクとストリーミング境界。差分が登録済み秘密値の途中で止まり、残りが最終本文
// (message_end) にだけ載ると、保留 delta のフラッシュが秘密値の先頭までを確定してしまう。
// live / payload / 履歴 API の本文がマスク済みの全文で揃うことを固定する。
// ---------------------------------------------------------------------------

const tailMasker = createSecretMasker([TAIL_SECRET]);

const streamedText = (events: EventEntry[]): string =>
  events.flatMap((entry) => (entry.type === "text" ? [entry.data.delta] : [])).join("");

const assistantTextOf = (messages: { role: string; text: string }[]): string | undefined =>
  messages.find((message) => message.role === "assistant")?.text;

test("BFF: 秘密値の途中で delta が止まっても最終本文の末尾を配る", { timeout: 15_000 }, async (t) => {
  const f = await storeOverRealSession(t, "secret-tail", { masker: tailMasker });
  f.store.postMessage(f.record, ORIGINAL);
  await waitFor(() => f.store.statusOf(f.record) === "completed", 10_000, "run completion");

  // What: live の本文がマスク済み最終本文と一致する (秘密値より後ろの末尾を落とさない)
  assert.equal(streamedText(f.events), TAIL_MASKED);
  // What: 本文 → usage → 応答終端 → 実行終端 の順序を保つ
  assert.deepEqual(
    f.events.flatMap((entry) =>
      entry.type === "text" || entry.type === "usage" || entry.type === "assistant_end" || entry.type === "run_end"
        ? [entry.type]
        : [],
    ),
    ["text", "text", "usage", "assistant_end", "run_end"],
  );
  // What: ストリーミング中は保留し、確定時にマスク済みの残りだけを配る
  assert.deepEqual(
    f.events.flatMap((entry) => (entry.type === "text" ? [entry.data.delta] : [])),
    ["回答は ", `${REDACTED} です`],
  );

  const payload = f.store.payload(f.record);
  assert.equal(assistantTextOf(payload.messages), TAIL_MASKED, "payload も同じ本文");
  const history = f.store.history(f.record, {});
  assert.ok(history.ok);
  const assistantItem = history.page.items.find((item) => item.kind === "message" && item.role === "assistant");
  assert.equal(assistantItem?.kind === "message" ? assistantItem.text : undefined, TAIL_MASKED, "履歴 API も同じ本文");

  // What: 登録済み秘密値の完全な値は SSE・payload・履歴 API のどこにも出ない
  for (const [label, surface] of [
    ["events", f.events],
    ["payload", payload],
    ["history", history],
  ] as const) {
    assert.ok(!JSON.stringify(surface).includes(TAIL_SECRET), `${label} must not carry the raw secret`);
  }
});

test("BFF: 停止で終わっても秘密値の途中の境界で末尾本文を落とさない", { timeout: 15_000 }, async (t) => {
  const f = await storeOverRealSession(t, "secret-tail", { masker: tailMasker, holdAfterDelta: true });
  f.store.postMessage(f.record, ORIGINAL);
  await f.paused;
  // What: ストリーミング中は秘密値の先頭部分を保留し、確定前の断片を配らない
  await waitFor(() => streamedText(f.events) === "回答は ", 5000, "held back secret prefix");

  await f.store.stop(f.record);
  await waitFor(() => f.store.statusOf(f.record) === "stopped", 10_000, "run stopped");

  // What: 停止で finalize を通っても、保留分のフラッシュで本文が欠けたり秘密値の先頭が出たりしない
  assert.equal(streamedText(f.events), TAIL_MASKED);
  const runEnd = f.events.find((entry) => entry.type === "run_end");
  assert.equal(runEnd?.type === "run_end" ? runEnd.data.status : undefined, "stopped");
  assert.ok(!JSON.stringify(f.events).includes(TAIL_SECRET), "events must not carry the raw secret");
  assert.ok(!JSON.stringify(f.store.payload(f.record)).includes(TAIL_SECRET), "payload must not carry the raw secret");
  assert.equal(assistantTextOf(f.store.payload(f.record).messages), TAIL_MASKED);
});
