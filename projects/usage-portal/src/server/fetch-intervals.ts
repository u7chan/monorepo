import type { DatabaseHandle } from "./db";
import { loadFetchIntervals, saveFetchInterval } from "./db";
import type { FetchIntervalProvider } from "../shared/fetch-interval";

export type FetchIntervalStore = {
  /** 保存値が無ければ既定値（env か 10 分）を返す。 */
  get: (provider: FetchIntervalProvider) => number;
  list: () => Record<FetchIntervalProvider, number>;
  set: (provider: FetchIntervalProvider, intervalMs: number) => void;
};

/**
 * 取得間隔は SQLite に置く。sample と同じ DB にまとまり、再起動をまたいで残る。
 * 秘密ではないので credential ディレクトリには置かない。
 */
export function createFetchIntervalStore(options: {
  db: DatabaseHandle;
  defaultMs: number;
  log?: (message: string) => void;
}): FetchIntervalStore {
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));

  function read(): Map<string, number> {
    try {
      return loadFetchIntervals(options.db);
    } catch {
      // 読めない行で取得を止めない。既定値で動かし、警告だけ残す。
      log("取得間隔を読めないため、既定値を使います");

      return new Map();
    }
  }

  function get(provider: FetchIntervalProvider): number {
    return read().get(provider) ?? options.defaultMs;
  }

  return {
    get,
    list() {
      const stored = read();

      return {
        codex: stored.get("codex") ?? options.defaultMs,
        "opencode-go": stored.get("opencode-go") ?? options.defaultMs,
      };
    },
    set(provider, intervalMs) {
      saveFetchInterval(options.db, provider, intervalMs);
    },
  };
}
