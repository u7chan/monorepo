import { loadHealth, type HealthState } from "./health"
import { clearToken, loadToken } from "./token"

export type Session = {
  token: string | null
  health: HealthState | null
}

export async function startSession(): Promise<Session> {
  const token = loadToken()

  if (token === null) {
    return { token: null, health: null }
  }

  const health = await loadHealth(token)

  if (health.status === "unauthorized") {
    clearToken()

    return { token: null, health }
  }

  return { token, health }
}
