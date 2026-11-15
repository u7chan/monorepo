import {
  type OpenCodeIncident,
  type OpenCodeModelStatus,
  type OpenCodeStatusPayload,
  type OpenCodeStatusSnapshot,
  readServiceStatus,
  readStatusReason,
  statusIsOld,
} from "../../shared/opencode-status";
import { fetchJson } from "../providers/http";

export const OPENCODE_STATUS_API_URL = "https://opencode.ai/status/api/status";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;

export function parseOpenCodeStatus(body: unknown): OpenCodeStatusSnapshot | null {
  const root = object(body);
  const updatedAt = timestamp(root?.updatedAt);
  const go = array(root?.components)
    .map(object)
    .find((component) => component?.service === "go");

  if (!root || updatedAt === null || typeof root.stale !== "boolean" || !go || typeof go.status !== "string") {
    return null;
  }

  const status = readServiceStatus(go.status);
  const models: OpenCodeModelStatus[] = array(go.breakdown).flatMap((value) => {
    const model = object(value);
    const id = modelId(model?.id);

    return id ? [{ id, status: readServiceStatus(model?.status), reason: readStatusReason(model?.reason) }] : [];
  });

  for (const value of array(go.models)) {
    const model = object(value);
    const id = modelId(model?.id);

    if (id && !models.some((candidate) => candidate.id === id)) {
      models.push({ id, status, reason: readStatusReason(model?.reason) });
    }
  }

  const incidents: OpenCodeIncident[] = array(root.incidents).flatMap((value) => {
    const incident = object(value);
    const startedAt = timestamp(incident?.startedAt);

    if (incident?.service !== "go" || incident.resolvedAt !== null || startedAt === null) {
      return [];
    }

    return [
      {
        startedAt,
        status: readServiceStatus(incident.status),
        reason: readStatusReason(incident.reason),
        models: array(incident.models).flatMap((value) => {
          const id = modelId(object(value)?.id);

          return id ? [id] : [];
        }),
      },
    ];
  });

  return {
    updatedAt,
    stale: root.stale,
    status,
    reason: readStatusReason(go.reason),
    since: timestamp(go.since),
    models,
    incidents: incidents.sort((a, b) => b.startedAt - a.startedAt),
  };
}

export function createOpenCodeStatusReader(options: {
  userAgent: string;
  now?: () => number;
  request?: typeof fetchJson;
}): () => Promise<OpenCodeStatusPayload> {
  const now = options.now ?? Date.now;
  const request = options.request ?? fetchJson;
  let snapshot: OpenCodeStatusSnapshot | null = null;
  let failed = false;
  let nextCheckAt = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const response = await request(OPENCODE_STATUS_API_URL, {
        headers: { accept: "application/json", "user-agent": options.userAgent },
        timeoutMs: TIMEOUT_MS,
      });
      const parsed = response?.status === 200 ? parseOpenCodeStatus(response.json) : null;

      failed = parsed === null;

      if (parsed) {
        snapshot = parsed;
      }
    } catch {
      failed = true;
    } finally {
      // 失敗時も間隔を空けないと、開いている端末の数だけ再試行が上流へ届く。
      nextCheckAt = now() + CACHE_MS;
    }
  };

  return async () => {
    if (!inFlight && now() >= nextCheckAt) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }

    if (inFlight) {
      await inFlight;
    }

    return {
      state: snapshot === null ? "error" : failed || statusIsOld(snapshot, now()) ? "stale" : "ok",
      snapshot,
    };
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : null;
}

function modelId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value) ? value : null;
}
