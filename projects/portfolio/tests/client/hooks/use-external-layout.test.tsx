// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDarkMode } from '#/client/shared/hooks/use-dark-mode'
import { useMobileLayout } from '#/client/shared/hooks/use-mobile-layout'

const createLocalStorageMock = () => {
  const store = new Map<string, string>()

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  }
}

describe('external layout hooks', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock())
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('テーマ変更を反映する', async () => {
    const { result } = renderHook(() => useDarkMode())

    expect(result.current).toBe(false)

    await act(async () => {
      localStorage.setItem('theme', 'dark')
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }))
    })

    expect(result.current).toBe(true)
  })

  it('モバイル向けメディアクエリの変更を反映する', () => {
    let matches = false
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({
      matches,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }))

    const { result } = renderHook(() => useMobileLayout())
    expect(result.current).toBe(false)

    act(() => {
      matches = true
      listeners.forEach((listener) => listener())
    })

    expect(result.current).toBe(true)
  })
})
