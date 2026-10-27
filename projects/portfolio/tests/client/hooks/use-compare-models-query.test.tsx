// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchChatModelsMock } = vi.hoisted(() => ({ fetchChatModelsMock: vi.fn() }))

vi.mock('#/client/features/chat/api/models-client', () => ({
  fetchChatModels: fetchChatModelsMock,
}))

import { useCompareModelsQuery } from '#/client/features/chat-compare/hooks/use-compare-models-query'

const settings = {
  schemaVersion: '1.0.0',
  baseURL: 'https://example.com',
  apiKey: 'test-key',
  apiMode: 'chat_completions' as const,
}

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useCompareModelsQuery', () => {
  beforeEach(() => {
    fetchChatModelsMock.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('モデルを取得できない場合も一覧を配列のまま保ち、エラー文言を返す', async () => {
    fetchChatModelsMock.mockResolvedValue({ models: [], error: 'ログインしてください' })

    const { result } = renderHook(() => useCompareModelsQuery(settings), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.modelsError).toBe('ログインしてください'))
    expect(result.current.models).toEqual([])
  })

  it('取得成功時はモデル名の配列を返す', async () => {
    fetchChatModelsMock.mockResolvedValue({ models: ['claude-3.7', 'gpt-4.1'], error: null })

    const { result } = renderHook(() => useCompareModelsQuery(settings), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.models).toEqual(['claude-3.7', 'gpt-4.1']))
    expect(result.current.modelsError).toBeNull()
  })
})
