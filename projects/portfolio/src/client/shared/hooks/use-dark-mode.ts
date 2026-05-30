import { useEffect, useState } from 'react'

export function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'dark') return true
    if (saved === 'light') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'))
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark
}
