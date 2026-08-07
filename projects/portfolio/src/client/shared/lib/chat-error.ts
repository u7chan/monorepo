import { ChatErrorSchema, type ChatError } from '#/types'

export const unknownChatError = (): ChatError => ({
  code: 'UNKNOWN_UPSTREAM_ERROR',
  message: 'LLM の応答取得中にエラーが発生しました。しばらく待ってから再試行してください。',
  retryable: true,
})

export const unavailableChatError = (): ChatError => ({
  code: 'UPSTREAM_UNAVAILABLE',
  message: 'LLM プロバイダーに接続できませんでした。しばらく待ってから再試行してください。',
  retryable: true,
})

export async function readChatError(response: Pick<Response, 'json'>): Promise<ChatError> {
  try {
    const parsed = ChatErrorSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : unknownChatError()
  } catch {
    return unknownChatError()
  }
}
