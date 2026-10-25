export type RateLimiter = {
  retryAfterSeconds(key: string): number | null;
  recordFailure(key: string): void;
  reset(key: string): void;
};

export function createRateLimiter(options: { maxFailures: number; windowMs: number; now: () => number }): RateLimiter {
  const failures = new Map<string, number[]>();

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
  };
}
