import { loadProviderUsage, loadSamples, type DatabaseHandle } from "./db";
import { CODEX_SOURCE_ID } from "./codex/source";
import { openCodeSourceId } from "./opencode/accounts";
import { CODEX_PROVIDER } from "./providers";
import type { ProviderId, UsageWindow } from "./providers/types";
import { decideProviderState, type ProviderState, type UsageError } from "./state";
import { buildTrend, trendSpanMs, type Trend } from "./trend";

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
  /** この source の取得間隔。画面はバーの長さと次回表示に使う。 */
  fetchIntervalMs: number;
  /** 次回の取得予定。まだ決まっていなければ null。 */
  nextFetchAt: number | null;
  error: UsageError | null;
  limitReached: boolean;
  windows: UsageWindow[];
  notes: string[];
  /** 窓ごとの推移。sample が 2 点未満の窓は含めない。 */
  trends: Trend[];
};

export type UsagePayload = {
  generatedAt: number;
  sources: UsageSource[];
};

type SourceEntry = { sourceId: string; provider: ProviderId; account: UsageSourceAccount | null };

/**
 * `/api/usage` の応答を SQLite から組み立てる。上流へは取りに行かない（sampler だけが取得する）。
 * 並びは Codex → 登録順のアカウント。アカウントが 0 件でも Codex の行は返す。
 */
export function createUsageReader(options: {
  db: DatabaseHandle;
  /** provider ごとの取得間隔。停止判定と応答の両方で同じ値を使う。 */
  intervalFor: (provider: ProviderId) => number;
  /** sampler の次回予定。未定なら null を返す。 */
  nextFetchAt?: (sourceId: string) => number | null;
  now: () => number;
  accounts?: () => readonly UsageSourceAccount[];
  /** Codex の履歴キー。サインイン中の ChatGPT アカウントで変わる。 */
  codexSourceId?: () => string;
}): () => UsagePayload {
  return () => {
    const now = options.now();
    const entries = collectSources(options.codexSourceId?.() ?? CODEX_SOURCE_ID, options.accounts?.() ?? []);
    const stored = loadProviderUsage(
      options.db,
      entries.map((entry) => entry.sourceId),
    );

    return {
      generatedAt: now,
      sources: entries.map((entry) => {
        const { snapshot, error } = stored.get(entry.sourceId) ?? { snapshot: null, error: null };
        const capturedAt = snapshot?.capturedAt ?? null;
        const intervalMs = options.intervalFor(entry.provider);

        return {
          id: entry.account?.id ?? CODEX_SOURCE_ID,
          provider: entry.provider,
          // Codex の名前と plan は snapshot 由来。アカウントは登録した名前だけを使う。
          name: entry.account?.name ?? snapshot?.name ?? CODEX_PROVIDER.name,
          plan: entry.account ? null : (snapshot?.plan ?? null),
          account: entry.account,
          state: decideProviderState({
            snapshotCapturedAt: capturedAt,
            hasError: error !== null,
            now,
            intervalMs,
          }),
          capturedAt,
          fetchIntervalMs: intervalMs,
          nextFetchAt: options.nextFetchAt?.(entry.sourceId) ?? null,
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

function collectSources(codexSourceId: string, accounts: readonly UsageSourceAccount[]): SourceEntry[] {
  return [
    { sourceId: codexSourceId, provider: "codex", account: null },
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
