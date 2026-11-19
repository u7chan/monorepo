import type { ProviderErrorCode } from "./providers/types";

export type ProviderState = "loading" | "ok" | "stale" | "error";

export type UsageError = { code: ProviderErrorCode; message: string; at: number };

/**
 * snapshot と error から API の `state` を決める。
 * 取得が閾値を超えて止まっただけの snapshot を `ok` と出すと、止まっていることが画面から消える。
 * 閾値は provider ごとに渡す（周期取得は 2 間隔、画面を開いたときだけ取る provider はその間隔）。
 */
export function decideProviderState(options: {
  snapshotCapturedAt: number | null;
  hasError: boolean;
  now: number;
  /** この source の値を stale と見なすまでに許す古さ。 */
  staleAfterMs: number;
}): ProviderState {
  if (options.snapshotCapturedAt === null) {
    return options.hasError ? "error" : "loading";
  }

  if (options.hasError) {
    return "stale";
  }

  return options.now - options.snapshotCapturedAt > options.staleAfterMs ? "stale" : "ok";
}
