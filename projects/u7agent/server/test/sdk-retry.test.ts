// 依存 SDK (@earendil-works/pi-coding-agent / pi-ai) の実体を使った再試行の回帰テスト。
//
// 実キー・実クォータには依存せず、ローカルの OpenAI 互換モックへ 429 の TPM エラーを返して、
// 再試行対象の判定・イベント順・失敗試行の投影からの除外・backoff の値を固定する。
// (BFF の変換は sessions-retry.test.ts。ここは SDK 側の契約だけを見る)
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";

const TPM_429 = {
  error: {
    message:
      "Rate limit reached for gpt-6-luna in organization org-abc123XYZ on tokens per min (TPM): Limit 200000, Used 91293, Requested 113079. Please try again in 1.311s.",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
};
const INSUFFICIENT_QUOTA = {
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
};

/** SDK の AssistantMessage のうち isRetryableAssistantError が読む分だけの形 */
const assistantFailure = (errorMessage: string): Parameters<typeof isRetryableAssistantError>[0] =>
  ({ stopReason: "error", errorMessage }) as Parameters<typeof isRetryableAssistantError>[0];

test("the screenshot TPM 429 is retryable and the exponential backoff is 2s then 4s", () => {
  assert.equal(isRetryableAssistantError(assistantFailure(JSON.stringify(TPM_429))), true);
  assert.equal(
    isRetryableAssistantError(assistantFailure('429: {"message":"Request too large ... Requested 205950"}')),
    true,
  );
  // 恒久的な利用枠エラーは再試行しない (BFF 側の分類と役割が違う)
  assert.equal(isRetryableAssistantError(assistantFailure(JSON.stringify(INSUFFICIENT_QUOTA))), false);
  assert.equal(isRetryableAssistantError(assistantFailure("401: Incorrect API key provided")), false);
  // BFF の既定 (baseDelayMs 2000) の実値。待機させずに式だけ固定する
  const policy = { baseDelayMs: 2000, maxAgentDelayMs: 60_000 };
  assert.equal(retryDelayMs(policy, 1), 2000);
  assert.equal(retryDelayMs(policy, 2), 4000);
});

/** 1 回目のリクエストだけ 429 を返し、以降は成功ストリームを返すモック */
async function startMockProvider(options: { failFirst: number }): Promise<{ server: Server; baseUrl: string }> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    requests += 1;
    if (requests <= options.failFirst) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify(TPM_429));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    chunk({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-6-luna",
      choices: [{ index: 0, delta: { role: "assistant", content: "復帰しました" }, finish_reason: null }],
    });
    chunk({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-6-luna",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

interface ObservedEvent {
  kind: string;
}

/** 実際の createAgentSession でセッションを作り、retry 設定だけテスト用に縮める */
async function createRealSession(baseUrl: string, baseDelayMs: number) {
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-sdk-retry-"));
  const cwd = mkdtempSync(join(tmpdir(), "u7agent-sdk-retry-cwd-"));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2, baseDelayMs } });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    authPath: join(agentDir, "auth.json"),
  });
  modelRuntime.registerProvider("mock-openai", {
    name: "Mock OpenAI",
    baseUrl,
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "gpt-6-luna",
        name: "Mock Luna",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });
  const model = modelRuntime.getModels().find((candidate) => candidate.provider === "mock-openai");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  const events: ObservedEvent[] = [];
  let observedFailedInProjection: boolean | undefined;
  let failedInProjectionAfterMicrotask: boolean | undefined;
  session.subscribe((event) => {
    const typed = event as {
      type: string;
      message?: { role?: string; stopReason?: string; usage?: { totalTokens?: number } };
      willRetry?: boolean;
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      success?: boolean;
      finalError?: string;
      entry?: { type?: string };
    };
    switch (typed.type) {
      case "message_end":
        events.push({
          kind: `message_end(${typed.message?.role},${typed.message?.stopReason ?? "-"},total=${typed.message?.usage?.totalTokens ?? "-"})`,
        });
        break;
      case "agent_end":
        events.push({ kind: `agent_end(willRetry=${typed.willRetry === true})` });
        break;
      case "auto_retry_start":
        events.push({
          kind: `auto_retry_start(attempt=${typed.attempt},max=${typed.maxAttempts},delay=${typed.delayMs})`,
        });
        break;
      case "auto_retry_end":
        events.push({ kind: `auto_retry_end(success=${typed.success},attempt=${typed.attempt})` });
        break;
      case "entry_appended": {
        // auto_retry_start 直後はまだ投影が古い (失敗試行が残る) ことを microtask と比べて固定する
        const hasFailed = session.messages.some(
          (message) => message.role === "assistant" && message.stopReason === "error",
        );
        if (typed.entry?.type === "context_edit" && observedFailedInProjection === undefined) {
          observedFailedInProjection = hasFailed;
          queueMicrotask(() => {
            failedInProjectionAfterMicrotask = session.messages.some(
              (message) => message.role === "assistant" && message.stopReason === "error",
            );
          });
        }
        events.push({ kind: `entry_appended(${typed.entry?.type})` });
        break;
      }
      default:
        if (typed.type === "agent_settled") events.push({ kind: "agent_settled" });
        else if (typed.type === "message_start") events.push({ kind: `message_start(${typed.message?.role})` });
        else if (typed.type === "agent_start") events.push({ kind: "agent_start" });
        break;
    }
  });
  return {
    session,
    events,
    projection() {
      return { observedFailedInProjection, failedInProjectionAfterMicrotask };
    },
  };
}

const kinds = (events: ObservedEvent[]): string[] => events.map((event) => event.kind);

test("a 429 during the first attempt retries after the SDK excludes the failure and then succeeds", async () => {
  const provider = await startMockProvider({ failFirst: 1 });
  try {
    const { session, events, projection } = await createRealSession(provider.baseUrl, 5);
    await session.prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const trace = kinds(events);
    // 失敗試行は usage(total=0) として届き、agent_end(willRetry) → auto_retry_start の順に来る
    assert.ok(trace.includes("message_end(assistant,error,total=0)"), trace.join("\n"));
    assert.ok(trace.indexOf("agent_end(willRetry=true)") < trace.indexOf("auto_retry_start(attempt=1,max=2,delay=5)"));
    assert.ok(
      trace.indexOf("auto_retry_start(attempt=1,max=2,delay=5)") < trace.indexOf("entry_appended(context_edit)"),
      "auto_retry_start は除外より前に届く",
    );
    assert.equal(projection().observedFailedInProjection, true, "entry_appended 時点の投影はまだ古い");
    assert.equal(projection().failedInProjectionAfterMicrotask, false, "microtask では除外が反映済み");
    // 成功時は次の assistant の message_start の後に auto_retry_end(success:true)
    assert.ok(
      trace.indexOf("message_start(assistant)") < trace.indexOf("auto_retry_end(success=true,attempt=1)"),
      trace.join("\n"),
    );
    assert.equal(trace.at(-1), "agent_settled");
    // 公開の投影には成功した assistant だけが残る (失敗試行の assistant は消える)
    const projected = session.messages as Array<{
      role?: string;
      stopReason?: string;
      content?: Array<{ text?: string }>;
    }>;
    assert.deepEqual(
      projected.map((message) => `${message.role}:${message.stopReason ?? "-"}`),
      ["system:-", "user:-", "assistant:stop"],
    );
    assert.equal(projected.at(-1)?.content?.[0]?.text, "復帰しました");
  } finally {
    provider.server.close();
  }
});

test("exhausting two retries emits the failed series end and keeps only the last failure", async () => {
  const provider = await startMockProvider({ failFirst: Number.MAX_SAFE_INTEGER });
  try {
    const { session, events } = await createRealSession(provider.baseUrl, 5);
    await session.prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const trace = kinds(events);
    // backoff は base × 2^(attempt-1): 1 回目 5ms、2 回目 10ms
    assert.ok(trace.includes("auto_retry_start(attempt=1,max=2,delay=5)"), trace.join("\n"));
    assert.ok(trace.includes("auto_retry_start(attempt=2,max=2,delay=10)"), trace.join("\n"));
    assert.equal(trace.filter((kind) => kind === "auto_retry_start(attempt=1,max=2,delay=5)").length, 1);
    assert.ok(trace.includes("auto_retry_end(success=false,attempt=2)"));
    assert.equal(trace.at(-1), "agent_settled");
    // 最終失敗の assistant は投影に残る (候補は除外されず、エラー本文は BFF が定型化して表示する)
    const projected = session.messages as Array<{ role?: string; stopReason?: string }>;
    assert.equal(projected.filter((message) => message.role === "assistant").length, 1);
    assert.equal(projected.at(-1)?.stopReason, "error");
  } finally {
    provider.server.close();
  }
});

test("a 429 again on the second attempt still recovers inside the same retry budget", async () => {
  const provider = await startMockProvider({ failFirst: 2 });
  try {
    const { session, events } = await createRealSession(provider.baseUrl, 5);
    await session.prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const trace = kinds(events);
    assert.ok(trace.includes("auto_retry_start(attempt=1,max=2,delay=5)"), trace.join("\n"));
    assert.ok(trace.includes("auto_retry_start(attempt=2,max=2,delay=10)"), trace.join("\n"));
    assert.ok(trace.includes("auto_retry_end(success=true,attempt=2)"), trace.join("\n"));
    assert.equal(trace.at(-1), "agent_settled");
    const projected = session.messages as Array<{
      role?: string;
      stopReason?: string;
      content?: Array<{ text?: string }>;
    }>;
    assert.deepEqual(
      projected.map((message) => `${message.role}:${message.stopReason ?? "-"}`),
      ["system:-", "user:-", "assistant:stop"],
    );
  } finally {
    provider.server.close();
  }
});

test("aborting during the retry backoff cancels the series and leaves no failed assistant", async () => {
  const provider = await startMockProvider({ failFirst: Number.MAX_SAFE_INTEGER });
  try {
    // 待機を長く取り、backoff 中に abort する
    const { session, events } = await createRealSession(provider.baseUrl, 5000);
    let started: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    session.subscribe((event) => {
      if ((event as { type?: string }).type === "auto_retry_start") started?.();
    });
    const prompt = session.prompt("hello");
    await retryStarted;
    await session.abort();
    await prompt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const trace = kinds(events);
    assert.ok(trace.includes("auto_retry_start(attempt=1,max=2,delay=5000)"), trace.join("\n"));
    assert.ok(trace.includes("auto_retry_end(success=false,attempt=1)"), trace.join("\n"));
    assert.equal(trace.at(-1), "agent_settled");
    // 待機中の中止では aborted の assistant も残らない (BFF は stop 要求で停止と判定する)
    assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
  } finally {
    provider.server.close();
  }
});
