// 実 SDK (@earendil-works/pi-coding-agent) とローカル OpenAI 互換モックで、要約生成リクエストの出力枠を固定する。
//
// 固定するのは (a) 既定 reserve の出力枠が floor(0.8 × 65,536) = 52,428 であること、(b) モデルの maxTokens が
// 小さければそこでクランプされること、(c) 出力枠が上限に達する規模の会話でも既定設定なら要約が完了すること。
// 実 API は呼ばない。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import { compactionSettingsFromEnv } from "../src/agent";

/** 要約リクエストの出力枠。openai-completions の compat 次第でフィールド名が変わる */
type SummaryRequest = { max_tokens?: number; max_completion_tokens?: number };

/** 実際に送られた出力枠を読む (compat が max_tokens / max_completion_tokens のどちらでも同じ値になる) */
function requestedBudget(body: SummaryRequest | undefined): number {
  return body?.max_tokens ?? body?.max_completion_tokens ?? 0;
}

/**
 * 要約リクエストの body を記録するモック。`max_tokens < truncateBelow` のときだけ finish_reason=length を返し、
 * 出力枠に達した要約を SDK が不完全として捨てる挙動を再現する。
 */
async function startMockProvider(options: { truncateBelow: number }): Promise<{
  server: Server;
  baseUrl: string;
  requests: SummaryRequest[];
}> {
  const requests: SummaryRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SummaryRequest;
      requests.push(body);
      const truncated = requestedBudget(body) < options.truncateBelow;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({
        id: "chatcmpl-compaction",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-summary-mock",
        choices: [{ index: 0, delta: { role: "assistant", content: "ここまでの要約" }, finish_reason: null }],
      });
      chunk({
        id: "chatcmpl-compaction",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-summary-mock",
        choices: [{ index: 0, delta: {}, finish_reason: truncated ? "length" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

/** reserve の既定は変えず、要約対象を作るために keepRecentTokens だけ小さくする検証用 env */
const CUT_FRIENDLY_ENV = { PI_COMPACTION_KEEP_RECENT_TOKENS: "500" } as NodeJS.ProcessEnv;

async function createRealSession(baseUrl: string, options: { env: NodeJS.ProcessEnv; maxTokens: number }) {
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-compaction-budget-"));
  const cwd = mkdtempSync(join(tmpdir(), "u7agent-compaction-budget-cwd-"));
  const settingsManager = SettingsManager.inMemory({ compaction: compactionSettingsFromEnv(options.env) });
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
        id: "gpt-summary-mock",
        name: "Mock Summary",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: options.maxTokens,
      },
    ],
  });
  const model = modelRuntime.getModels().find((candidate) => candidate.provider === "mock-openai");
  // 4 件の user メッセージ (各約 300 推定 tokens)。keepRecentTokens=500 なら先頭 2 件が要約対象になり、
  // カットが user メッセージへ落ちるので split-turn の追加リクエストは出ない
  const sessionManager = SessionManager.inMemory(cwd);
  for (let index = 0; index < 4; index += 1) {
    sessionManager.appendMessage({ role: "user", content: `質問${index}: ${"x".repeat(1180)}`, timestamp: index });
  }
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
    sessionManager,
    noTools: "all",
  });
  return { session, sessionManager };
}

test("既定 reserve の要約リクエストは floor(0.8 × 65536) = 52428 の出力枠で送られる", async () => {
  const provider = await startMockProvider({ truncateBelow: 0 });
  try {
    const { session } = await createRealSession(provider.baseUrl, { env: CUT_FRIENDLY_ENV, maxTokens: 100_000 });

    await session.compact();

    assert.equal(provider.requests.length, 1);
    assert.equal(requestedBudget(provider.requests[0]), 52_428);
  } finally {
    provider.server.close();
  }
});

test("モデルの maxTokens が出力枠より小さければそこでクランプされる", async () => {
  const provider = await startMockProvider({ truncateBelow: 0 });
  try {
    const { session } = await createRealSession(provider.baseUrl, { env: CUT_FRIENDLY_ENV, maxTokens: 8_192 });

    await session.compact();

    assert.equal(provider.requests.length, 1);
    assert.equal(requestedBudget(provider.requests[0]), 8_192);
  } finally {
    provider.server.close();
  }
});

test("出力枠に達する規模の要約でも既定設定なら完了して compaction entry が積まれる", async () => {
  // 旧既定 (reserve 16,384 → 出力枠 13,107) はこのモックの打ち切り境界を下回り、stopReason=length の要約が
  // 捨てられて compact() が失敗していた
  const provider = await startMockProvider({ truncateBelow: 13_284 });
  try {
    const { session, sessionManager } = await createRealSession(provider.baseUrl, {
      env: CUT_FRIENDLY_ENV,
      maxTokens: 100_000,
    });

    const result = await session.compact();

    const budget = requestedBudget(provider.requests[0]);
    assert.equal(budget, 52_428);
    assert.ok(budget >= 32_768, `出力枠 ${budget} は打ち切り境界より十分大きいはず`);
    assert.equal(result.summary, "ここまでの要約");
    assert.equal(
      sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
      1,
      "compaction entry が積まれる",
    );
  } finally {
    provider.server.close();
  }
});
