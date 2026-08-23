import {
  type CreateAgentSessionOptions,
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { logAgent, logAgentPrompt } from "./logger"

export interface Harness {
  prompt(text: string): Promise<string>
  dispose(): void
}

export interface HarnessOptions {
  // "provider/model" 形式 (例: opencode-go/deepseek-v4-flash)、":level" サフィックス可
  model?: string
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  // API キーは自前で扱わない: ModelRuntime が auth.json → 環境変数
  // (例: OPENCODE_API_KEY) の順で自動解決する
  const modelRuntime = await ModelRuntime.create()

  const sessionOptions: CreateAgentSessionOptions = {
    modelRuntime,
    sessionManager: SessionManager.inMemory(), // 永続化しない
    // TODO: ツール実行は後段で追加する (それまで会話のみ)
    noTools: "all",
  }

  if (options.model !== undefined) {
    const resolved = resolveCliModel({
      cliModel: options.model,
      modelRuntime,
    })
    if (resolved.error) {
      throw new Error(resolved.error)
    }
    sessionOptions.model = resolved.model
    if (resolved.thinkingLevel) {
      sessionOptions.thinkingLevel = resolved.thinkingLevel
    }
  }

  const { session } = await createAgentSession(sessionOptions)

  let current = ""
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      current += event.assistantMessageEvent.delta
      return
    }

    // テキスト生成以外の主要イベントをログへ (ツール実行は後段で有効化)
    switch (event.type) {
      case "agent_start":
        logAgent("start")
        break
      case "turn_end":
        if (
          event.message.role === "assistant" &&
          (event.message.stopReason === "error" ||
            event.message.stopReason === "aborted")
        ) {
          const reason = event.message.errorMessage ?? "(no error message)"
          logAgent(`failed: stopReason=${event.message.stopReason} ${reason}`)
        }
        break
      case "auto_retry_start":
        logAgent(
          `retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`,
        )
        break
      case "tool_execution_start":
        logAgent(`tool start: ${event.toolName}`)
        break
      case "tool_execution_end":
        logAgent(
          `tool end: ${event.toolName}${event.isError ? " (error)" : ""}`,
        )
        break
      case "agent_end":
        logAgent("end")
        break
    }
  })

  return {
    async prompt(text) {
      logAgentPrompt(text)
      current = ""
      await session.prompt(text)
      return current
    },
    dispose() {
      unsubscribe()
      session.dispose()
    },
  }
}
