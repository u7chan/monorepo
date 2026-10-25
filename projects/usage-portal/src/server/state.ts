import type { ProviderErrorCode } from "./providers/types";

export type ProviderState = "loading" | "ok" | "stale" | "error";

export type UsageError = { code: ProviderErrorCode; message: string; at: number };

/**
 * snapshot と error から API の `state` を決める。
 * 取得が 2 周期止まっただけの snapshot を `ok` と出すと、止まっていることが画面から消える。
 */
export function decideProviderState(options: {
  snapshotCapturedAt: number | null;
  hasError: boolean;
  now: number;
  sampleIntervalMs: number;
}): ProviderState {
  if (options.snapshotCapturedAt === null) {
    return options.hasError ? "error" : "loading";
  }

  if (options.hasError) {
    return "stale";
  }

  return options.now - options.snapshotCapturedAt > 2 * options.sampleIntervalMs ? "stale" : "ok";
}
