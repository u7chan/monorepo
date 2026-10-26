import { loadProviderUsage, loadSamples, type DatabaseHandle } from "./db";
import { openCodeSourceId } from "./opencode/accounts";
import { CODEX_PROVIDER } from "./providers";
import type { ProviderId, UsageWindow } from "./providers/types";
import { decideProviderState, type ProviderState, type UsageError } from "./state";
import { buildTrend, selectTrendWindow, type Trend } from "./trend";

export const TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

const CODEX_SOURCE_ID = "codex";

/** 画面のヘッダーに出すアカウントの識別情報。キーは含めない。 */
export type UsageSourceAccount = { id: string; name: string; icon: string };

export type UsageSource = {
  /** `codex` または account の uuid。 */
  id: string;
  provider: ProviderId;
  name: string;
  plan: string | null;
  /** Codex は null。 */
  account: UsageSourceAccount | null;
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
  sources: UsageSource[];
};

type SourceEntry = { sourceId: string; provider: ProviderId; account: UsageSourceAccount | null };

/**
 * `/api/usage` の応答を SQLite から組み立てる。上流へは取りに行かない（sampler だけが取得する）。
 * 並びは Codex → 登録順のアカウント。アカウントが 0 件でも Codex の行は返す。
 */
export function createUsageReader(options: {
  db: DatabaseHandle;
  sampleIntervalMs: number;
  now: () => number;
  accounts?: () => readonly UsageSourceAccount[];
}): () => UsagePayload {
  return () => {
    const now = options.now();
    const entries = collectSources(options.accounts?.() ?? []);
    const stored = loadProviderUsage(
      options.db,
      entries.map((entry) => entry.sourceId),
    );

    return {
      generatedAt: now,
      sampleIntervalMs: options.sampleIntervalMs,
      sources: entries.map((entry) => {
        const { snapshot, error } = stored.get(entry.sourceId) ?? { snapshot: null, error: null };
        const capturedAt = snapshot?.capturedAt ?? null;

        return {
          id: entry.account?.id ?? entry.sourceId,
          provider: entry.provider,
          // Codex の名前と plan は snapshot 由来。アカウントは登録した名前だけを使う。
          name: entry.account?.name ?? snapshot?.name ?? CODEX_PROVIDER.name,
          plan: entry.account ? null : (snapshot?.plan ?? null),
          account: entry.account,
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
          trend: snapshot ? readTrend(options.db, entry.sourceId, snapshot.windows, now) : null,
        };
      }),
    };
  };
}

function collectSources(accounts: readonly UsageSourceAccount[]): SourceEntry[] {
  return [
    { sourceId: CODEX_SOURCE_ID, provider: "codex", account: null },
    ...accounts.map((account) => ({
      sourceId: openCodeSourceId(account.id),
      provider: "opencode-go" as const,
      account,
    })),
  ];
}

/** 推移は最新 snapshot で最も使用率が高い枠の 1 本だけを返す。 */
function readTrend(db: DatabaseHandle, sourceId: string, windows: UsageWindow[], now: number): Trend | null {
  const target = selectTrendWindow(windows);

  if (!target) {
    return null;
  }

  return buildTrend(target.id, loadSamples(db, sourceId, target.id, now - TREND_WINDOW_MS));
}
