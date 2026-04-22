// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'portfolio.chat-settings'

const defaultSettings = {
  schemaVersion: '1.2.0',
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
  interactiveMode: true,
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

type HookProps = {
  selectedConversationId: string | null
}

describe('useChatPageState', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'localStorage',
      createLocalStorageMock({
        [STORAGE_KEY]: JSON.stringify(defaultSettings),
      })
    )
    vi.resetModules()
  })

  const importHook = async () => {
    const mod = await import('#/client/pages/chat/use-chat-page-state')
    return mod.useChatPageState
  }

  it('startNewConversation で popup を閉じて trigger を更新する', async () => {
    const useChatPageState = await importHook()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100)

    const { result } = renderHook(({ selectedConversationId }: HookProps) => useChatPageState(selectedConversationId), {
      initialProps: { selectedConversationId: 'conversation-1' as string | null },
    })

    act(() => {
      result.current.toggleSettingsPopup()
    })

    expect(result.current.selectedConversationId).toBe('conversation-1')
    expect(result.current.isSettingsPopupOpen).toBe(true)
    expect(result.current.newChatTrigger).toBe(100)

    nowSpy.mockReturnValue(200)
    act(() => {
      result.current.startNewConversation()
    })

    expect(result.current.selectedConversationId).toBe('conversation-1')
    expect(result.current.isSettingsPopupOpen).toBe(false)
    expect(result.current.newChatTrigger).toBe(200)
  })

  it('setSubmitting が showSettingsActions を反転する', async () => {
    const useChatPageState = await importHook()
    const { result } = renderHook(() => useChatPageState(null))

    expect(result.current.showSettingsActions).toBe(true)

    act(() => {
      result.current.setSubmitting(true)
    })

    expect(result.current.isSubmitting).toBe(true)
    expect(result.current.showSettingsActions).toBe(false)

    act(() => {
      result.current.setSubmitting(false)
    })

    expect(result.current.isSubmitting).toBe(false)
    expect(result.current.showSettingsActions).toBe(true)
  })

  it('会話選択と settings 更新を独立して保持する', async () => {
    const useChatPageState = await importHook()
    const { result, rerender } = renderHook(
      ({ selectedConversationId }: HookProps) => useChatPageState(selectedConversationId),
      {
        initialProps: { selectedConversationId: 'conversation-2' as string | null },
      }
    )

    act(() => {
      result.current.updateSettings({
        ...result.current.settings,
        model: 'gpt-5',
        streamMode: false,
      })
    })

    expect(result.current.selectedConversationId).toBe('conversation-2')
    expect(result.current.settings.model).toBe('gpt-5')
    expect(result.current.settings.streamMode).toBe(false)

    rerender({ selectedConversationId: 'conversation-3' })

    expect(result.current.selectedConversationId).toBe('conversation-3')
    expect(result.current.settings.model).toBe('gpt-5')
  })

  it('選択中会話が null になると新規会話 trigger を更新する', async () => {
    const useChatPageState = await importHook()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100)

    const { result, rerender } = renderHook(
      ({ selectedConversationId }: HookProps) => useChatPageState(selectedConversationId),
      {
        initialProps: { selectedConversationId: 'conversation-1' as string | null },
      }
    )

    act(() => {
      result.current.toggleSettingsPopup()
    })

    nowSpy.mockReturnValue(300)
    rerender({ selectedConversationId: null })

    expect(result.current.selectedConversationId).toBeNull()
    expect(result.current.isSettingsPopupOpen).toBe(false)
    expect(result.current.newChatTrigger).toBe(300)
  })
})
