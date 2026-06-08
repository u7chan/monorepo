import { useCallback, useSyncExternalStore } from 'react'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'
const themeListeners = new Set<() => void>()

function getIsDark() {
  return document.documentElement.classList.contains('dark')
}

function getStoredTheme() {
  try {
    return localStorage.getItem('theme')
  } catch {
    return null
  }
}

function emitThemeChange() {
  for (const listener of themeListeners) {
    listener()
  }
}

function subscribeTheme(onStoreChange: () => void) {
  themeListeners.add(onStoreChange)

  const mq = window.matchMedia(DARK_MODE_QUERY)
  const handleChange = (e: MediaQueryListEvent) => {
    if (getStoredTheme()) return
    document.documentElement.classList.toggle('dark', e.matches)
    emitThemeChange()
  }

  mq.addEventListener('change', handleChange)
  return () => {
    themeListeners.delete(onStoreChange)
    mq.removeEventListener('change', handleChange)
  }
}

export function useTheme() {
  const isDark = useSyncExternalStore(subscribeTheme, getIsDark, () => false)

  const toggle = useCallback(() => {
    const next = !getIsDark()
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // localStorage unavailable
    }
    emitThemeChange()
  }, [])

  return { isDark, toggle } as const
}
