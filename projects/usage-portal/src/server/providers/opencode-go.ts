import { fetchJson } from "./http";
import {
  ProviderError,
  type ProviderSnapshot,
  type UsageWindow,
  readObject,
  readPercent,
  WINDOW_LABELS,
  withUniqueLabels,
} from "./types";

export const OPENCODE_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";
export const OPENCODE_NAME = "OpenCode Go";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** 3 窓を表示対象にする。API が返さなかった窓は行を作らない（0% と誤表示しない）。 */
const WINDOW_ORDER = ["rolling", "weekly", "monthly"] as const;

export function parseOpenCodeUsage(body: unknown, capturedAt: number): ProviderSnapshot {
  const usage = readObject(body, "usage");

  if (!usage) {
    throw new ProviderError("schema", "OpenCode Go の応答を解釈できませんでした");
  }

  const windows: UsageWindow[] = [];
  let overflow = false;
  let abnormal = false;

  for (const kind of WINDOW_ORDER) {
    const raw = readObject(usage, kind);
    const percent = raw ? readPercent(raw.percent) : null;

    if (!raw || !percent) {
      continue;
    }

    windows.push({
      id: kind,
      label: WINDOW_LABELS[kind],
      durationSeconds: null,
      // 0.5 は 0.5% として扱う。百分率を 0〜1 に正規化しない。
      usedPercent: percent.usedPercent,
      resetsAt: parseIsoDate(raw.resetsAt),
    });

    overflow ||= percent.overflow;
    abnormal ||= typeof raw.status === "string" && raw.status !== "ok";
  }

  // 窓が 1 つも無い応答は「0%」ではなく schema の変化とみなし、前回の snapshot を残す。
  if (windows.length === 0) {
    throw new ProviderError("schema", "OpenCode Go の応答を解釈できませんでした");
  }

  const notes: string[] = [];

  if (overflow) {
    notes.push("上限超過");
  }

  if (abnormal) {
    notes.push("利用枠の状態が正常ではありません");
  }

  return {
    provider: "opencode-go",
    name: OPENCODE_NAME,
    plan: null,
    capturedAt,
    limitReached: abnormal,
    windows: withUniqueLabels(windows),
    notes,
  };
}

export async function fetchOpenCodeUsage(options: {
  apiKey: string | null;
  userAgent: string;
  now: () => number;
  timeoutMs?: number;
}): Promise<ProviderSnapshot> {
  if (!options.apiKey) {
    throw new ProviderError("config", "OpenCode Go の API キーが設定されていません");
  }

  const response = await fetchJson(OPENCODE_USAGE_URL, {
    headers: {
      // OpenCode Go は raw key を渡す契約。`Bearer` を付けると 401 になる。
      authorization: options.apiKey,
      accept: "application/json",
      "user-agent": options.userAgent,
    },
    timeoutMs: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS,
  });

  if (!response) {
    throw new ProviderError("upstream", "OpenCode Go に接続できませんでした");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("config", "OpenCode Go の API キーが受け付けられませんでした");
  }

  if (response.status !== 200) {
    throw new ProviderError("upstream", `OpenCode Go の取得に失敗しました（HTTP ${response.status}）`);
  }

  try {
    return parseOpenCodeUsage(response.json, options.now());
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    throw new ProviderError("schema", "OpenCode Go の応答を解釈できませんでした");
  }
}

function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}
