export type ProviderId = "codex" | "opencode-go";

export type UsageWindow = {
  id: string;
  label: string;
  durationSeconds: number | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type ProviderSnapshot = {
  provider: ProviderId;
  name: string;
  plan: string | null;
  capturedAt: number;
  limitReached: boolean;
  windows: UsageWindow[];
  notes: string[];
};

/** 画面が分岐に使える固定の分類。上流の文言や例外文をそのまま入れない。 */
export type ProviderErrorCode = "not_connected" | "reauth_required" | "upstream" | "schema" | "config";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export const WINDOW_LABELS = {
  rolling: "ローリング",
  weekly: "週次",
  monthly: "月次",
} as const;

export type WindowKind = keyof typeof WINDOW_LABELS;

const ROLLING_MAX_SECONDS = 6 * 60 * 60;
const WEEKLY_MAX_SECONDS = 8 * 24 * 60 * 60;

/** `limit_window_seconds` を種類へ振る。読めない値は rolling に寄せる（上流の欠損で行を消さない）。 */
export function windowKind(seconds: number | null): WindowKind {
  if (seconds === null || seconds <= ROLLING_MAX_SECONDS) {
    return "rolling";
  }

  return seconds <= WEEKLY_MAX_SECONDS ? "weekly" : "monthly";
}

/**
 * 同じ provider 内でラベルが重なったときだけ「第 N 枠」を後ろに付ける。
 * 実際には起きにくいが、同じ名前の meter が 2 本並ぶと読み手が区別できない。
 */
export function withUniqueLabels(windows: UsageWindow[]): UsageWindow[] {
  const counts = new Map<string, number>();

  for (const window of windows) {
    counts.set(window.label, (counts.get(window.label) ?? 0) + 1);
  }

  const order = new Map<UsageWindow, number>();

  for (const window of [...windows].sort((a, b) => durationOf(a) - durationOf(b))) {
    order.set(window, order.size + 1);
  }

  return windows.map((window) =>
    (counts.get(window.label) ?? 0) > 1
      ? { ...window, label: `${window.label}（第${order.get(window) ?? 1}枠）` }
      : window,
  );
}

function durationOf(window: UsageWindow): number {
  return window.durationSeconds ?? Number.MAX_SAFE_INTEGER;
}

export type PercentReading = { usedPercent: number; overflow: boolean };

/**
 * 0〜100 へ clamp する。`Number.isFinite` で見るのは、0% を欠損として落とさないため。
 * 上流が 100 を超えたら 100 で表示し、100 を超えたこと自体を note で伝える。
 */
export function readPercent(value: unknown): PercentReading | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return { usedPercent: Math.min(100, Math.max(0, value)), overflow: value > 100 };
}

export function readDurationSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function readObject(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const child = (value as Record<string, unknown>)[key];

  return typeof child === "object" && child !== null ? (child as Record<string, unknown>) : null;
}

export function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const child = (value as Record<string, unknown>)[key];

  return typeof child === "string" && child.trim() !== "" ? child.trim() : null;
}

export function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const child = (value as Record<string, unknown>)[key];

  return typeof child === "number" && Number.isFinite(child) ? child : null;
}
