import { loadProviderUsage, loadSamples, type DatabaseHandle } from "./db";
import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "./providers";
import type { ProviderId, UsageWindow } from "./providers/types";
import { decideProviderState, type ProviderState, type UsageError } from "./state";
import { buildTrend, selectTrendWindow, type Trend } from "./trend";

export const TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProviderUsage = {
  id: ProviderId;
  name: string;
  plan: string | null;
  state: ProviderState;
  capturedAt: number | null;
  error: UsageError | null;
  limitReached: boolean;
  windows: UsageWindow[];
  notes: string[];
  trend: Trend | null;
};

export type UsagePayload = {
  generatedAt: number;
  sampleIntervalMs: number;
  providers: ProviderUsage[];
};

/** `/api/usage` の応答を SQLite から組み立てる。上流へは取りに行かない（sampler だけが取得する）。 */
export function createUsageReader(options: {
  db: DatabaseHandle;
  sampleIntervalMs: number;
  now: () => number;
  providers?: readonly ProviderDefinition[];
}): () => UsagePayload {
  const providers = options.providers ?? PROVIDER_DEFINITIONS;

  return () => {
    const now = options.now();
    const stored = loadProviderUsage(
      options.db,
      providers.map((provider) => provider.id),
    );

    return {
      generatedAt: now,
      sampleIntervalMs: options.sampleIntervalMs,
      providers: providers.map((definition) => {
        const { snapshot, error } = stored.get(definition.id) ?? { snapshot: null, error: null };
        const capturedAt = snapshot?.capturedAt ?? null;

        return {
          id: definition.id,
          name: definition.name,
          plan: snapshot?.plan ?? null,
          state: decideProviderState({
            snapshotCapturedAt: capturedAt,
            hasError: error !== null,
            now,
            sampleIntervalMs: options.sampleIntervalMs,
          }),
          capturedAt,
          error,
          limitReached: snapshot?.limitReached ?? false,
          windows: snapshot?.windows ?? [],
          notes: snapshot?.notes ?? [],
          trend: snapshot ? readTrend(options.db, definition.id, snapshot.windows, now) : null,
        };
      }),
    };
  };
}

/** 推移は最新 snapshot で最も使用率が高い枠の 1 本だけを返す。 */
function readTrend(db: DatabaseHandle, provider: ProviderId, windows: UsageWindow[], now: number): Trend | null {
  const target = selectTrendWindow(windows);

  if (!target) {
    return null;
  }

  return buildTrend(target.id, loadSamples(db, provider, target.id, now - TREND_WINDOW_MS));
}
