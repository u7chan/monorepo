export const OPENCODE_STATUS_PAGE_URL = "https://opencode.ai/status/";
export const OPENCODE_STATUS_MAX_AGE_MS = 5 * 60_000;

export type ServiceStatus = "operational" | "degraded" | "outage" | "unknown";
export type StatusReason = "none" | "latency" | "upstream" | "errors" | "availability" | "unknown";

export type OpenCodeModelStatus = { id: string; status: ServiceStatus; reason: StatusReason };
export type OpenCodeIncident = {
  startedAt: number;
  status: ServiceStatus;
  reason: StatusReason;
  models: string[];
};

export type OpenCodeStatusSnapshot = {
  updatedAt: number;
  stale: boolean;
  status: ServiceStatus;
  reason: StatusReason;
  since: number | null;
  models: OpenCodeModelStatus[];
  incidents: OpenCodeIncident[];
};

export type OpenCodeStatusPayload = {
  state: "ok" | "stale" | "error";
  snapshot: OpenCodeStatusSnapshot | null;
};

export function readServiceStatus(value: unknown): ServiceStatus {
  return value === "operational" || value === "degraded" || value === "outage" ? value : "unknown";
}

export function readStatusReason(value: unknown): StatusReason {
  switch (value) {
    case "none":
    case "latency":
    case "upstream":
    case "errors":
    case "availability":
      return value;
    default:
      return "unknown";
  }
}

export function statusIsOld(snapshot: OpenCodeStatusSnapshot, now: number): boolean {
  return snapshot.stale || now - snapshot.updatedAt > OPENCODE_STATUS_MAX_AGE_MS;
}
