export const ACTIVE_SESSION_STORAGE_KEY = 'portfolio.chat.activeSession'

export type ActiveSession = {
  sessionId: string
  lastEventId?: string
}

export function saveActiveSession(session: ActiveSession): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function readActiveSession(): ActiveSession | null {
  if (typeof sessionStorage === 'undefined') return null

  const value = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
  if (!value) return null

  try {
    return JSON.parse(value) as ActiveSession
  } catch {
    clearActiveSession()
    return null
  }
}

export function clearActiveSession(): void {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
}

export function hasActiveChatSession(): boolean {
  return readActiveSession() !== null
}
