// 実 SDK (@earendil-works/pi-coding-agent) とローカル OpenAI 互換モックで、要約生成リクエストの出力枠を固定する。
//
// 固定するのは (a) 出力枠がモデルの maxTokens になること、(b) reserveTokens を変えても出力枠は変わらないこと、
// (c) 窓の残量が少なければ maxTokens より小さくなること、(d) 出力枠が上限に達する規模の会話でも要約が完了すること。
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

async function createRealSession(
  baseUrl: string,
  options: { env: NodeJS.ProcessEnv; maxTokens: number; contextWindow?: number },
) {
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
        contextWindow: options.contextWindow ?? 1_000_000,
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

test("要約リクエストの出力枠はモデルの maxTokens になる", async () => {
  const provider = await startMockProvider({ truncateBelow: 0 });
  try {
    const { session } = await createRealSession(provider.baseUrl, { env: CUT_FRIENDLY_ENV, maxTokens: 100_000 });

    await session.compact();

    assert.equal(provider.requests.length, 1);
    assert.equal(requestedBudget(provider.requests[0]), 100_000);
  } finally {
    provider.server.close();
  }
});

test("reserveTokens を変えても要約リクエストの出力枠は変わらない", async () => {
  // 出力枠は reserveTokens から切り離され、u7agent の既定 65,536 は自動圧縮の閾値だけを決める
  const provider = await startMockProvider({ truncateBelow: 0 });
  try {
    const { session } = await createRealSession(provider.baseUrl, {
      env: { ...CUT_FRIENDLY_ENV, PI_COMPACTION_RESERVE_TOKENS: "30000" },
      maxTokens: 100_000,
    });

    await session.compact();

    assert.equal(provider.requests.length, 1);
    assert.equal(requestedBudget(provider.requests[0]), 100_000);
  } finally {
    provider.server.close();
  }
});

test("context の残量が少なければ出力枠は model.maxTokens より小さくなる", async () => {
  // 出力枠はカタログ値ではなく、推定入力と安全余白 (4,096) を引いた窓の残量でも切り詰められる
  const provider = await startMockProvider({ truncateBelow: 0 });
  try {
    const { session } = await createRealSession(provider.baseUrl, {
      env: CUT_FRIENDLY_ENV,
      maxTokens: 8_192,
      contextWindow: 8_192,
    });

    await session.compact();

    const budget = requestedBudget(provider.requests[0]);
    assert.ok(budget < 8_192, `出力枠 ${budget} は窓の残量で切り詰められるはず`);
    assert.ok(budget > 0, `出力枠 ${budget} は正の値のはず`);
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

test("出力枠に達する規模の要約でも完了して compaction entry が積まれる", async () => {
  // 出力枠がこの境界を下回ると、SDK は stopReason=length の要約を捨てて compact() を失敗させる
  const provider = await startMockProvider({ truncateBelow: 13_284 });
  try {
    const { session, sessionManager } = await createRealSession(provider.baseUrl, {
      env: CUT_FRIENDLY_ENV,
      maxTokens: 100_000,
    });

    const result = await session.compact();

    const budget = requestedBudget(provider.requests[0]);
    assert.equal(budget, 100_000);
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
