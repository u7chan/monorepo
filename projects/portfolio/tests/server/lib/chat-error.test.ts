import { APIError } from 'openai'
import { describe, expect, it } from 'vitest'
import { toChatError } from '#/server/lib/chat-error'

describe('toChatError', () => {
  describe('provider error classification', () => {
    it('クレジット不足を INSUFFICIENT_CREDIT に分類する', () => {
      const error = createApiError(400, {
        message: 'AnthropicException: Your credit balance is too low to access the Anthropic API.',
      })

      expect(toChatError(error)).toEqual({
        code: 'INSUFFICIENT_CREDIT',
        message: 'LLM プロバイダーのクレジットが不足しています。API キーの請求状況を確認してください。',
        retryable: false,
      })
    })

    it('LiteLLM の無効トークンを AUTHENTICATION_FAILED に分類する', () => {
      const error = createApiError(401, {
        message: 'Invalid proxy server token passed. Key Hash (Token) = secret-hash',
        type: 'token_not_found_in_db',
        param: 'key',
        code: '401',
      })

      expect(toChatError(error)).toEqual({
        code: 'AUTHENTICATION_FAILED',
        message: 'API キーが無効か、利用を許可されていません。設定を確認してください。',
        retryable: false,
      })
    })

    it('モデル権限エラーを MODEL_ACCESS_DENIED に分類する', () => {
      const error = createApiError(403, {
        message: 'You do not have access to this model.',
      })

      expect(toChatError(error)).toEqual({
        code: 'MODEL_ACCESS_DENIED',
        message: 'このモデルを利用する権限がありません。モデル名と API キーの権限を確認してください。',
        retryable: false,
      })
    })

    it('rate limit を RATE_LIMITED に分類する', () => {
      const error = createApiError(429, { message: 'Too many requests' })

      expect(toChatError(error)).toEqual({
        code: 'RATE_LIMITED',
        message: 'リクエスト数の上限に達しました。しばらく待ってから再試行してください。',
        retryable: true,
      })
    })
  })

  it('provider の詳細を公開エラーへ含めない', () => {
    const rawMessage = 'Invalid proxy server token passed. Key Hash (Token) = secret-hash'
    const error = createApiError(401, { message: rawMessage, type: 'token_not_found_in_db' })

    expect(JSON.stringify(toChatError(error))).not.toContain(rawMessage)
  })
})

function createApiError(status: number, body: Record<string, unknown>): APIError {
  return new APIError(status, body, undefined, new Headers())
}
