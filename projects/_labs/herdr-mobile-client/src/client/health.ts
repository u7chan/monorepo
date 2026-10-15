import type { HealthResponse } from "../server/app"
import { api, authorizationHeader } from "./api"

export type HealthState =
  | { status: "ok"; health: HealthResponse }
  | { status: "unauthorized" }
  | { status: "unreachable"; reason: string }

export async function loadHealth(token: string): Promise<HealthState> {
  try {
    const res = await api.api.health.$get(undefined, { headers: authorizationHeader(token) })

    if (res.status === 401) {
      return { status: "unauthorized" }
    }

    if (!res.ok) {
      return { status: "unreachable", reason: `HTTP ${res.status}` }
    }

    return { status: "ok", health: await res.json() }
  } catch (error) {
    return { status: "unreachable", reason: error instanceof Error ? error.message : String(error) }
  }
}
