// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('useChatForm', () => {
  const importSubject = async () => {
    const { useChatForm } = await import('#/client/components/chat/hooks/use-chat-form')
    return { useChatForm }
  }

  const createChangeEvent = (value: string) =>
    ({ target: { value } }) as unknown as React.ChangeEvent<HTMLTextAreaElement>

  it('送信設定を user message metadata に残す', async () => {
    const { useChatForm } = await importSubject()
    const formRef = { current: null }
    const { result } = renderHook(() => useChatForm({ formRef }))

    act(() => {
      result.current.handleChangeInput(createChangeEvent('hello'))
    })

    const built = result.current.buildChatMessages({
      apiMode: 'chat_completions',
      interactiveMode: true,
      messages: [],
      model: 'gpt-test',
      streamMode: true,
      temperature: 0.4,
      maxTokens: 256,
    })

    expect(built?.draftUserMessage.metadata).toEqual({
      model: 'gpt-test',
      apiMode: 'chat_completions',
      stream: true,
      temperature: 0.4,
      maxTokens: 256,
    })
  })
})
