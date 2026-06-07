import { useCallback, useEffect, useState } from 'react'

function getIsDark() {
  return document.documentElement.classList.contains('dark')
}

export function useTheme() {
  const [isDark, setIsDark] = useState(getIsDark)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const stored = localStorage.getItem('theme')
      if (stored) return
      document.documentElement.classList.toggle('dark', e.matches)
      setIsDark(e.matches)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const toggle = useCallback(() => {
    const next = !getIsDark()
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // localStorage unavailable
    }
    setIsDark(next)
  }, [])

  return { isDark, toggle } as const
}
