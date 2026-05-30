// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('useChatForm', () => {
  const importSubject = async () => {
    const { useChatForm } = await import('#/client/features/chat/hooks/use-chat-form')
    return { useChatForm }
  }

  const createChangeEvent = (value: string) =>
    ({ target: { value } }) as unknown as React.ChangeEvent<HTMLTextAreaElement>

  const createKeyDownEvent = ({ key = 'Enter', shiftKey = false, value = 'hello' } = {}) =>
    ({
      key,
      shiftKey,
      currentTarget: { value },
      preventDefault: vi.fn(),
    }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>

  it('送信設定を user message metadata に残す', async () => {
    const { useChatForm } = await importSubject()
    const formRef = { current: null }
    const { result } = renderHook(() => useChatForm({ formRef }))

    act(() => {
      result.current.handleChangeInput(createChangeEvent('hello'))
    })

    const built = result.current.buildChatMessages({
      apiMode: 'chat_completions',
      includeChatHistory: true,
      messages: [],
      model: 'gpt-test',
      streamMode: true,
      sendImagesOnlyOnce: true,
      temperature: 0.4,
      maxTokens: 256,
      reasoningEffort: 'high',
    })

    expect(built?.draftUserMessage.metadata).toEqual({
      model: 'gpt-test',
      apiMode: 'chat_completions',
      stream: true,
      temperature: 0.4,
      maxTokens: 256,
      reasoningEffort: 'high',
      sendImagesOnlyOnce: true,
    })
  })

  it('ON 時は過去履歴の画像を API payload から除外し、保存用メッセージには画像を残す', async () => {
    const { useChatForm } = await importSubject()
    const formRef = { current: null }
    const { result } = renderHook(() => useChatForm({ formRef }))

    act(() => {
      result.current.handleChangeInput(createChangeEvent('色は？'))
      result.current.handleUploadImageChange('data:image/png;base64,current')
    })

    const built = result.current.buildChatMessages({
      apiMode: 'chat_completions',
      includeChatHistory: true,
      messages: [
        {
          id: 'previous-user',
          role: 'user',
          content: [
            { type: 'text', text: 'これはなに？' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,previous' } },
          ],
          metadata: { model: 'gpt-test', sendImagesOnlyOnce: true },
        },
      ],
      model: 'gpt-test',
      streamMode: true,
      sendImagesOnlyOnce: true,
    })

    expect(built?.draftUserMessage.content).toEqual([
      { type: 'text', text: '色は？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
    ])
    expect(built?.apiMessages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'これはなに？' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '色は？' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
        ],
      },
    ])
    expect(built?.imageContext).toEqual({ policy: 'send_once', sent: 1, historyOnly: 1 })
  })

  it('OFF 時は過去履歴の画像も API payload に含める', async () => {
    const { useChatForm } = await importSubject()
    const formRef = { current: null }
    const { result } = renderHook(() => useChatForm({ formRef }))

    act(() => {
      result.current.handleChangeInput(createChangeEvent('続けて'))
    })

    const built = result.current.buildChatMessages({
      apiMode: 'chat_completions',
      includeChatHistory: true,
      messages: [
        {
          id: 'previous-user',
          role: 'user',
          content: [
            { type: 'text', text: 'これはなに？' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,previous' } },
          ],
          metadata: { model: 'gpt-test', sendImagesOnlyOnce: false },
        },
      ],
      model: 'gpt-test',
      streamMode: true,
      sendImagesOnlyOnce: false,
    })

    expect(built?.apiMessages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'これはなに？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,previous' } },
      ],
    })
    expect(built?.imageContext).toEqual({ policy: 'full_history', sent: 1, historyOnly: 0 })
  })

  it('Enter でフォーム送信する', async () => {
    const { useChatForm } = await importSubject()
    const requestSubmit = vi.fn()
    const formRef = { current: { requestSubmit } as unknown as HTMLFormElement }
    const { result } = renderHook(() => useChatForm({ formRef }))
    const event = createKeyDownEvent()

    act(() => {
      result.current.handleKeyDown(event)
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(requestSubmit).toHaveBeenCalledOnce()
  })

  it('送信不可の Enter はフォーム送信しない', async () => {
    const { useChatForm } = await importSubject()
    const requestSubmit = vi.fn()
    const formRef = { current: { requestSubmit } as unknown as HTMLFormElement }
    const { result } = renderHook(() => useChatForm({ formRef, submitDisabled: true }))
    const event = createKeyDownEvent()

    act(() => {
      result.current.handleKeyDown(event)
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(requestSubmit).not.toHaveBeenCalled()
  })

  it('Shift+Enter はフォーム送信しない', async () => {
    const { useChatForm } = await importSubject()
    const requestSubmit = vi.fn()
    const formRef = { current: { requestSubmit } as unknown as HTMLFormElement }
    const { result } = renderHook(() => useChatForm({ formRef }))
    const event = createKeyDownEvent({ shiftKey: true })

    act(() => {
      result.current.handleKeyDown(event)
    })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
  })

  it('変換中の Enter はフォーム送信しない', async () => {
    const { useChatForm } = await importSubject()
    const requestSubmit = vi.fn()
    const formRef = { current: { requestSubmit } as unknown as HTMLFormElement }
    const { result } = renderHook(() => useChatForm({ formRef }))
    const event = createKeyDownEvent()

    act(() => {
      result.current.handleChangeComposition(true)
    })
    act(() => {
      result.current.handleKeyDown(event)
    })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(requestSubmit).not.toHaveBeenCalled()
  })
})
