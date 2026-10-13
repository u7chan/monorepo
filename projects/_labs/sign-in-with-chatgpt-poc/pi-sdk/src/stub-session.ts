import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { runTurn, type TurnResult } from "./agent.js"
import type { Config } from "./config.js"
import {
  authorizationDigest,
  startStubResponsesServer,
} from "./stub-responses.js"

export const STUB_PROVIDER = "siwc-poc-stub"
export const STUB_MODEL = "stub-model"

export interface StubSessionResult {
  result: TurnResult
  /** スタブが要求した bash コマンドの出力 */
  toolOutput: string
  /** スタブが受けた `Authorization` ヘッダーの指紋（生の値は持たない） */
  authHeaderDigests: string[]
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
    /**
     * `openai` provider の baseUrl だけをスタブへ向け、保存済みの資格情報
     * （auth.json の OAuth トークン）を実際に使わせる。SIWC 経路の資格情報が
     * どこまで漏れるかを確認するためのもの。
     */
    useStoredOpenAiCredential?: boolean
  },
): Promise<StubSessionResult> {
  const stub = startStubResponsesServer({ toolCommand: options.toolCommand })
  const dir = mkdtempSync(join(tmpdir(), "siwc-pi-stub-"))
  const modelsPath = join(dir, "models.json")
  const useOpenAiProvider = options.useStoredOpenAiCredential === true
  const providerId = useOpenAiProvider ? "openai" : STUB_PROVIDER
  const modelId = useOpenAiProvider ? config.modelId : STUB_MODEL

  const modelsConfig = useOpenAiProvider
    ? { providers: { openai: { baseUrl: stub.baseUrl } } }
    : {
        providers: {
          [STUB_PROVIDER]: {
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
          },
        },
      }
  writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2))

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
      provider: providerId,
      modelId,
      tools: ["bash"],
    })
    return {
      result,
      toolOutput: stub.toolOutputs.join("\n"),
      authHeaderDigests: [...stub.authHeaderDigests],
    }
  } finally {
    stub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

export { authorizationDigest }
