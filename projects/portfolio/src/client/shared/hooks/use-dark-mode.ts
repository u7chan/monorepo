import { useSyncExternalStore } from 'react'

function getDarkModeSnapshot() {
  if (typeof window === 'undefined') {
    return false
  }

  const saved = localStorage.getItem('theme')
  if (saved === 'dark') {
    return true
  }
  if (saved === 'light') {
    return false
  }
  return document.documentElement.classList.contains('dark')
}

function subscribeToDarkMode(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('storage', onStoreChange)

  return () => {
    observer.disconnect()
    window.removeEventListener('storage', onStoreChange)
  }
}

export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeToDarkMode, getDarkModeSnapshot, () => false)
}
