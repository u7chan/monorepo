import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent"

/**
 * aiagent のハーネスが満たす最小インターフェース。
 * セッション管理・ストリーミング・ツールは将来の拡張点としてここに足していく。
 */
export interface Harness {
  /** プロンプトを送り、完了後のアシスタント応答テキストを返す */
  prompt(text: string): Promise<string>
  /** 内部リソース(Pi セッション)を解放する */
  dispose(): void
}

/**
 * Pi SDK 上に最小のハーネスを作る。
 *
 * - セッションは in-memory(ディスクに永続化しない)
 * - ツールは無効(現時点では会話のみ。ツールは後段で追加する)
 */
export async function createHarness(): Promise<Harness> {
  const modelRuntime = await ModelRuntime.create()

  const { session } = await createAgentSession({
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  })

  let current = ""
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      current += event.assistantMessageEvent.delta
    }
  })

  return {
    async prompt(text) {
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
