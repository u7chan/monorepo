import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { runTurn, type TurnResult } from "./agent.js"
import type { Config } from "./config.js"
import { startStubResponsesServer } from "./stub-responses.js"

export const STUB_PROVIDER = "siwc-poc-stub"
export const STUB_MODEL = "stub-model"

export interface StubSessionResult {
  result: TurnResult
  /** スタブが要求した bash コマンドの出力 */
  toolOutput: string
}

/**
 * ローカルのスタブ provider に対してエージェントセッションを 1 ターン実行し、
 * 実際に bash ツールを起動させる。ネットワークと実アカウントを使わずに
 * セッション → ツール子プロセスの経路だけを検証するためのもの。
 */
export async function runStubSession(
  config: Config,
  options: {
    prompt: string
    toolCommand: string
    followUpPrompt?: string
    /**
     * 指定すると models.json の apiKey を使わず、ModelRuntime.setRuntimeApiKey で
     * 外部から渡したトークンだけでリクエストさせる（トークン注入経路の確認用）。
     */
    runtimeApiKey?: string
  },
): Promise<StubSessionResult> {
  const stub = startStubResponsesServer({ toolCommand: options.toolCommand })
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-stub-"))
  const modelsPath = join(dir, "models.json")
  const provider = {
    baseUrl: stub.baseUrl,
    api: "openai-responses",
    models: [
      {
        id: STUB_MODEL,
        reasoning: false,
        input: ["text"],
        contextWindow: 16000,
        maxTokens: 1024,
      },
    ],
    ...(options.runtimeApiKey ? {} : { apiKey: "stub-key" }),
  }
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { [STUB_PROVIDER]: provider } }, null, 2),
  )

  try {
    const runtime = await ModelRuntime.create({
      authPath: config.authPath,
      modelsPath,
    })
    if (options.runtimeApiKey) {
      await runtime.setRuntimeApiKey(STUB_PROVIDER, options.runtimeApiKey)
    }
    const result = await runTurn(runtime, config, {
      prompt: options.prompt,
      ...(options.followUpPrompt
        ? { followUpPrompt: options.followUpPrompt }
        : {}),
      provider: STUB_PROVIDER,
      modelId: STUB_MODEL,
      tools: ["bash"],
    })
    return { result, toolOutput: stub.toolOutputs.join("\n") }
  } finally {
    stub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}
