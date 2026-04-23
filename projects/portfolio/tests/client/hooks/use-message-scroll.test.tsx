// @vitest-environment jsdom

import type { Message } from '#/types'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('useMessageScroll', () => {
  const messages: Message[] = []

  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(1000)
        return 1
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const importSubject = async () => {
    const { useMessageScroll } = await import('#/client/components/chat/hooks/use-message-scroll')
    return { useMessageScroll }
  }

  it('最下端から離れると isPinnedToBottom が false になる', async () => {
    const { useMessageScroll } = await importSubject()
    const { result } = renderHook(() =>
      useMessageScroll({
        loading: false,
        streamMode: true,
        stream: null,
        messages,
      })
    )

    const scrollContainer = document.createElement('div')
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 100, writable: true },
      scrollHeight: { value: 600, writable: true },
      clientHeight: { value: 200, writable: true },
    })

    act(() => {
      result.current.scrollContainerRef.current = scrollContainer
      result.current.handleScroll()
    })

    expect(result.current.isPinnedToBottom).toBe(false)
  })

  it('閾値内へ戻ると isPinnedToBottom が true になる', async () => {
    const { useMessageScroll } = await importSubject()
    const { result } = renderHook(() =>
      useMessageScroll({
        loading: false,
        streamMode: true,
        stream: null,
        messages,
      })
    )

    const scrollContainer = document.createElement('div')
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 100, writable: true },
      scrollHeight: { value: 600, writable: true },
      clientHeight: { value: 200, writable: true },
    })

    act(() => {
      result.current.scrollContainerRef.current = scrollContainer
      result.current.handleScroll()
    })

    act(() => {
      scrollContainer.scrollTop = 370
      result.current.handleScroll()
    })

    expect(result.current.isPinnedToBottom).toBe(true)
  })

  it('scrollToMessageEnd でスクロールしつつ isPinnedToBottom を true に戻す', async () => {
    const { useMessageScroll } = await importSubject()
    const { result } = renderHook(() =>
      useMessageScroll({
        loading: false,
        streamMode: true,
        stream: null,
        messages,
      })
    )

    const scrollContainer = document.createElement('div')
    Object.defineProperties(scrollContainer, {
      scrollTop: { value: 100, writable: true },
      scrollHeight: { value: 600, writable: true },
      clientHeight: { value: 200, writable: true },
    })
    act(() => {
      result.current.scrollContainerRef.current = scrollContainer
      result.current.handleScroll()
    })

    act(() => {
      result.current.scrollToMessageEnd('smooth')
    })

    expect(result.current.isPinnedToBottom).toBe(true)
    expect(scrollContainer.scrollTop).toBe(400)
    expect(requestAnimationFrame).toHaveBeenCalled()
  })
})
