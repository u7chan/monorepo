export type RateLimiter = {
  retryAfterSeconds: (key: string) => number | null;
  recordFailure: (key: string) => void;
  reset: (key: string) => void;
  /** 同一キーの処理を直列化する。判定・照合・記録の間に別の要求が入らないようにするため。 */
  exclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;
};

export function createRateLimiter(options: { maxFailures: number; windowMs: number; now: () => number }): RateLimiter {
  const failures = new Map<string, number[]>();
  const chains = new Map<string, Promise<unknown>>();

  function recent(key: string): number[] {
    const now = options.now();
    const kept = (failures.get(key) ?? []).filter((at) => now - at < options.windowMs);

    if (kept.length === 0) {
      failures.delete(key);

      return [];
    }

    failures.set(key, kept);

    return kept;
  }

  return {
    retryAfterSeconds(key) {
      const kept = recent(key);

      if (kept.length < options.maxFailures) {
        return null;
      }

      const oldest = Math.min(...kept);

      return Math.max(1, Math.ceil((oldest + options.windowMs - options.now()) / 1000));
    },
    recordFailure(key) {
      const kept = recent(key);

      kept.push(options.now());
      failures.set(key, kept);
    },
    reset(key) {
      failures.delete(key);
    },
    async exclusive(key, task) {
      const previous = chains.get(key) ?? Promise.resolve();
      // 前の処理が失敗しても次の要求は実行する。直列化だけが目的。
      const current = previous.catch(() => undefined).then(task);

      chains.set(key, current);

      try {
        return await current;
      } finally {
        if (chains.get(key) === current) {
          chains.delete(key);
        }
      }
    },
  };
}
