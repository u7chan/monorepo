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

export const signInRequiredChatError = (): ChatError => ({
  code: 'AUTHENTICATION_FAILED',
  message: 'ログインしてください。サインインの有効期限が切れた場合は Home からサインインし直してください。',
  retryable: false,
})

export async function readChatError(response: Pick<Response, 'status' | 'json'>): Promise<ChatError> {
  // 403 は上流 API キーの権限不足なので、アプリ側の未ログインと混同しないよう 401 だけを扱う
  if (response.status === 401) return signInRequiredChatError()

  try {
    const parsed = ChatErrorSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : unknownChatError()
  } catch {
    return unknownChatError()
  }
}
