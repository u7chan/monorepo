import { describe, expect, it } from 'vitest'
import { readChatError } from '#/client/shared/lib/chat-error'

const createResponse = (status: number, body: unknown) => ({
  status,
  json: async () => body,
})

describe('readChatError', () => {
  it('401 ではログインを促すエラーを返す', async () => {
    const error = await readChatError(createResponse(401, { error: 'Authentication error' }))

    expect(error).toEqual({
      code: 'AUTHENTICATION_FAILED',
      message: 'ログインしてください。サインインの有効期限が切れた場合は Home からサインインし直してください。',
      retryable: false,
    })
  })

  it('公開契約の本文があればその内容を返す', async () => {
    const error = await readChatError(
      createResponse(502, {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'upstream down',
        retryable: true,
      })
    )

    expect(error).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'upstream down', retryable: true })
  })

  it('解釈できない本文は汎用エラーへ丸める', async () => {
    const error = await readChatError(createResponse(500, { error: 'Internal Server Error' }))

    expect(error.code).toBe('UNKNOWN_UPSTREAM_ERROR')
  })
})
