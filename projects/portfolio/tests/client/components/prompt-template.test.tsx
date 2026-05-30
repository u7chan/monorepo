// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'portfolio.chat-settings'

const promptTemplatesGetMock = vi.fn()

vi.mock('hono/client', () => ({
  hc: () => ({
    api: {
      'prompt-templates': {
        $get: (...args: unknown[]) => promptTemplatesGetMock(...args),
      },
    },
  }),
}))

vi.mock('#/client/components/chat/chat-settings/hooks/use-model-fetching', () => ({
  useModelFetching: () => ({
    fetchedModels: [],
    isLoadingModels: false,
    fetchError: null,
  }),
}))

const defaultSettings = {
  schemaVersion: '1.4.0',
  model: 'gpt-4.1-mini',
  baseURL: '',
  apiKey: '',
  apiMode: 'chat_completions',
  temperature: 0.7,
  temperatureEnabled: false,
  maxTokens: undefined,
  reasoningEffort: 'medium',
  reasoningEffortEnabled: false,
  fakeMode: false,
  autoModel: false,
  markdownPreview: true,
  streamMode: true,
  includeChatHistory: true,
  sendImagesOnlyOnce: true,
  sidebarOpen: true,
  templateModels: {},
}

const createLocalStorageMock = (initialEntries: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initialEntries))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

describe('PromptTemplate', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'localStorage',
      createLocalStorageMock({
        [STORAGE_KEY]: JSON.stringify(defaultSettings),
      })
    )
    promptTemplatesGetMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'commit_message',
            inputType: 'text',
            title: 'コミットメッセージを作成',
            placeholder: '変更内容',
            prompt: 'Create commit message',
          },
        ],
      }),
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('APIから取得したテンプレートを表示して送信する', async () => {
    const onSubmit = vi.fn()
    const { PromptTemplate } = await import('#/client/components/chat/prompt-template')

    render(<PromptTemplate autoModel={false} onSubmit={onSubmit} />)

    const input = await screen.findByPlaceholderText('変更内容')
    fireEvent.change(input, { target: { value: 'add prompt templates' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(promptTemplatesGetMock).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      model: '',
      prompt: 'Create commit message',
      content: 'add prompt templates',
    })
  })

  it('有効テンプレートが0件の場合はテンプレート欄を表示しない', async () => {
    promptTemplatesGetMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })
    const { PromptTemplate } = await import('#/client/components/chat/prompt-template')

    render(<PromptTemplate autoModel={false} />)

    await waitFor(() => {
      expect(screen.queryByText('コミットメッセージを作成')).toBeNull()
    })
  })

  it('取得失敗時はテンプレート欄を表示しない', async () => {
    promptTemplatesGetMock.mockRejectedValue(new Error('network error'))
    const { PromptTemplate } = await import('#/client/components/chat/prompt-template')

    render(<PromptTemplate autoModel={false} />)

    await waitFor(() => {
      expect(screen.queryByText('コミットメッセージを作成')).toBeNull()
    })
  })
})
