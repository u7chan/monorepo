import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openaiMock } = vi.hoisted(() => ({ openaiMock: vi.fn() }))

vi.mock('openai', () => ({
  default: openaiMock,
}))

import { createUpstreamClient } from '#/server/lib/upstream-client'

describe('createUpstreamClient', () => {
  beforeEach(() => {
    openaiMock.mockClear()
  })

  it('api-key と base-url を渡し、リダイレクト追従を禁止する', () => {
    createUpstreamClient({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })

    expect(openaiMock).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      fetchOptions: { redirect: 'error' },
    })
  })
})
