import { messageFor } from "./errors";
import { startRequestDeadline } from "./request-deadline";

export const CATALOG_TIMEOUT_MS = 10_000;

// 上流の応答本文はログや UI に出さない。
export const CATALOG_ERROR_TIMEOUT = "モデル一覧の取得がタイムアウトしました";
export const CATALOG_ERROR_RATE_LIMITED = "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）";
export const CATALOG_ERROR_UNKNOWN = "モデル一覧を取得できませんでした";

interface CatalogCache<ModelRow> {
  fetchedAt: number;
  models: ModelRow[];
}

interface ContentModelCatalogOptions<Entry, ModelRow, Fallback extends "sdk" | "default"> {
  kind: "image" | "speech";
  url: string;
  fallbackEntries: () => readonly Entry[];
  fallbackSource: Fallback;
  fetchImpl: typeof fetch;
  now?: (() => number) | undefined;
  timeoutMs: number;
  entriesOf: (body: unknown) => Entry[] | undefined;
  readCache: () => CatalogCache<ModelRow> | undefined;
  saveCache: (row: CatalogCache<ModelRow>) => void;
  entryOf: (model: ModelRow) => Entry;
  cacheModelOf: (entry: Entry) => ModelRow;
}

type LiveCatalog<Entry> = { entries: Entry[]; fetchedAt: number };

export function createContentModelCatalog<Entry extends { id: string }, ModelRow, Fallback extends "sdk" | "default">(
  options: ContentModelCatalogOptions<Entry, ModelRow, Fallback>,
) {
  const { kind, url, fallbackEntries, fetchImpl, timeoutMs, entriesOf, readCache, saveCache, entryOf, cacheModelOf } =
    options;
  const now = options.now ?? (() => Date.now());
  let entries = [...fallbackEntries()];
  let source: Fallback | "live" | "stored" = options.fallbackSource;
  let fetchedAt: number | null = null;

  const adopt = (outcome: LiveCatalog<Entry>): void => {
    // キャッシュは次回起動用。保存できなくても、今回取得できた一覧は捨てない。
    entries = outcome.entries;
    source = "live";
    fetchedAt = outcome.fetchedAt;
    try {
      saveCache({ fetchedAt: outcome.fetchedAt, models: outcome.entries.map(cacheModelOf) });
    } catch {
      console.warn(`[u7agent] ${kind} catalog cache save failed`);
    }
  };

  const fetchLive = async (): Promise<LiveCatalog<Entry> | { error: string }> => {
    const deadline = startRequestDeadline(timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: deadline.signal });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const entries = response.ok ? entriesOf(body) : undefined;
      if (entries) return { entries, fetchedAt: now() };
      if (deadline.timedOut) return { error: CATALOG_ERROR_TIMEOUT };
      if (response.status === 429 || response.status >= 500) return { error: CATALOG_ERROR_RATE_LIMITED };
      return { error: CATALOG_ERROR_UNKNOWN };
    } catch {
      return deadline.timedOut ? { error: CATALOG_ERROR_TIMEOUT } : { error: CATALOG_ERROR_UNKNOWN };
    } finally {
      deadline.clear();
    }
  };

  return {
    snapshot: () => ({ entries, source, fetchedAt }),
    entryFor: (id: string) => entries.find((entry) => entry.id === id),

    loadStored: () => {
      try {
        const stored = readCache();
        if (!stored) return;
        entries = stored.models.map(entryOf);
        source = "stored";
        fetchedAt = stored.fetchedAt;
      } catch (error) {
        console.warn(`[u7agent] ${kind} catalog cache unavailable: ${messageFor(error)}`);
      }
    },

    refresh: async () => {
      const outcome = await fetchLive();
      if ("error" in outcome) {
        console.warn(`[u7agent] ${kind} catalog fetch failed: ${outcome.error}`);
        return outcome.error;
      }
      adopt(outcome);
      return null;
    },
  };
}
