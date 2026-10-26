import { loadProviderUsage, loadSamples, type DatabaseHandle } from "./db";
import { openCodeSourceId } from "./opencode/accounts";
import { CODEX_PROVIDER } from "./providers";
import type { ProviderId, UsageWindow } from "./providers/types";
import { decideProviderState, type ProviderState, type UsageError } from "./state";
import { buildTrend, trendSpanMs, type Trend } from "./trend";

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
  /** 窓ごとの推移。sample が 2 点未満の窓は含めない。 */
  trends: Trend[];
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
          trends: snapshot ? readTrends(options.db, entry.sourceId, snapshot.windows, now) : [],
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

/** 窓ごとに、その窓の期間ぶんの sample を読む。窓が 3 つでも 1 source あたり 3 クエリで済む。 */
function readTrends(db: DatabaseHandle, sourceId: string, windows: UsageWindow[], now: number): Trend[] {
  return windows
    .map((window) => {
      const spanMs = trendSpanMs(window);
      const samples = loadSamples(db, sourceId, window.id, now - spanMs);

      return buildTrend(window.id, spanMs, samples);
    })
    .filter((trend): trend is Trend => trend !== null);
}
