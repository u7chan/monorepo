import {
  type CreateAgentSessionOptions,
  createAgentSession,
  ModelRuntime,
  resolveCliModel,
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

export interface HarnessOptions {
  /**
   * モデル指定 (CLI 形式: "provider/model"、":level" サフィックス可)。
   * 未指定なら pi の設定(defaultModel)または最初の利用可能モデルに従う。
   */
  model?: string
}

/**
 * Pi SDK 上に最小のハーネスを作る。
 *
 * - セッションは in-memory(ディスクに永続化しない)
 * - ツールは無効(現時点では会話のみ。ツールは後段で追加する)
 * - API キーは明示しない: ModelRuntime が auth.json → 環境変数
 *   (例: OPENCODE_API_KEY)の順で自動解決する
 */
export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const modelRuntime = await ModelRuntime.create()

  const sessionOptions: CreateAgentSessionOptions = {
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
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
