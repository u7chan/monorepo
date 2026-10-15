import type { HealthResponse } from "../server/app"
import { api } from "./api"

export type HealthState =
  | { status: "ok"; health: HealthResponse }
  | { status: "error"; message: string }

export async function loadHealth(): Promise<HealthState> {
  try {
    const res = await api.api.health.$get()

    if (!res.ok) {
      return { status: "error", message: `HTTP ${res.status}` }
    }

    return { status: "ok", health: await res.json() }
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) }
  }
}
