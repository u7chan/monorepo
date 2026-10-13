import {
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { SIWC_PROVIDER } from "./auth.js"
import type { Config } from "./config.js"
import {
  createRequestRecorder,
  type RequestSummary,
  type ResponseSummary,
} from "./recorder.js"

export interface TurnRequest {
  prompt: string
  /** 同じセッションで続けて送る 2 ターン目の入力（会話継続の確認用） */
  followUpPrompt?: string
  /** 既定は SIWC 経路（openai）。スタブ検証では別 provider を指定する */
  provider?: string
  modelId?: string
  /** 省略時はツールなし。最小のエージェントセッションとして動かす */
  tools?: string[]
  onTurnStart?: (index: number, prompt: string) => void
  onTextDelta?: (delta: string) => void
  onThinkingDelta?: (delta: string) => void
  onToolStart?: (toolName: string) => void
}

export interface TurnResult {
  text: string
  /** ターンごとの回答。`--follow` を使った場合に 2 件以上になる */
  answers: string[]
  /** 最後の assistant メッセージの stop reason（`error` なら失敗） */
  stopReason?: string
  /** 失敗時の provider エラーメッセージ */
  errorMessage?: string
  provider: string
  modelId: string
  api: string
  baseUrl: string
  thinkingLevel: string
  requestCount: number
  responseCount: number
  requests: RequestSummary[]
  responses: ResponseSummary[]
  messageCount: number
}

function readLastAssistantStatus(messages: readonly unknown[]): {
  stopReason?: string
  errorMessage?: string
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== "object" || message === null) {
      continue
    }
    const candidate = message as {
      role?: unknown
      stopReason?: unknown
      errorMessage?: unknown
    }
    if (candidate.role !== "assistant") {
      continue
    }
    return {
      stopReason:
        typeof candidate.stopReason === "string"
          ? candidate.stopReason
          : undefined,
      errorMessage:
        typeof candidate.errorMessage === "string"
          ? candidate.errorMessage
          : undefined,
    }
  }
  return {}
}

export async function runTurn(
  runtime: ModelRuntime,
  config: Config,
  request: TurnRequest,
): Promise<TurnResult> {
  const provider = request.provider ?? SIWC_PROVIDER
  const modelId = request.modelId ?? config.modelId
  const model = runtime.getModel(provider, modelId)
  if (!model) {
    throw new Error(`Pi のカタログにモデルがありません: ${provider}/${modelId}`)
  }

  const settingsManager = SettingsManager.inMemory()
  const recorder = createRequestRecorder()
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.workspace,
    agentDir: config.storageDir,
    settingsManager,
    // リポジトリやホームの設定・スキル・コンテキストを読ませず、PoC の入力だけで動かす
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [recorder.extension],
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd: config.workspace,
    agentDir: config.storageDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: config.thinkingLevel,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    ...(request.tools ? { tools: request.tools } : { noTools: "all" as const }),
  })

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update.type === "text_delta") {
        request.onTextDelta?.(update.delta)
      } else if (update.type === "thinking_delta") {
        request.onThinkingDelta?.(update.delta)
      }
      return
    }
    if (event.type === "tool_execution_start") {
      request.onToolStart?.(event.toolName)
    }
  })

  try {
    const prompts = request.followUpPrompt
      ? [request.prompt, request.followUpPrompt]
      : [request.prompt]
    const answers: string[] = []
    for (const [index, prompt] of prompts.entries()) {
      request.onTurnStart?.(index, prompt)
      await session.prompt(prompt)
      answers.push(session.getLastAssistantText() ?? "")
    }

    const active = session.model ?? model
    const status = readLastAssistantStatus(session.messages)
    return {
      text: answers.at(-1) ?? "",
      answers,
      ...status,
      provider: active.provider,
      modelId: active.id,
      api: active.api,
      baseUrl: active.baseUrl,
      thinkingLevel: session.thinkingLevel,
      requestCount: recorder.requests.length,
      responseCount: recorder.responses.length,
      requests: recorder.requests,
      responses: recorder.responses,
      messageCount: session.messages.length,
    }
  } finally {
    unsubscribe()
    session.dispose()
  }
}
