import { useSyncExternalStore } from 'react'

const mobileMediaQuery = '(max-width: 767px)'

function getMobileLayoutSnapshot() {
  return window.matchMedia(mobileMediaQuery).matches
}

function subscribeToMobileLayout(onStoreChange: () => void) {
  const mediaQueryList = window.matchMedia(mobileMediaQuery)
  mediaQueryList.addEventListener('change', onStoreChange)

  return () => mediaQueryList.removeEventListener('change', onStoreChange)
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribeToMobileLayout, getMobileLayoutSnapshot, () => false)
}
