import { useEffect } from 'react'

/**
 * Locks/unlocks body scroll when the locked state changes.
 * Useful for modals, slide-in panels, and other overlay UI.
 */
export function useLockBodyScroll(locked: boolean): void {
  useEffect(() => {
    if (locked) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [locked])
}
