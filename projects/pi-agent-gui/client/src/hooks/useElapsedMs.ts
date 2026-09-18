import { useEffect, useState } from "react";

const TICK_MS = 1000;

export function useElapsedMs(startedAt?: number): number | undefined {
  const [tick, setTick] = useState(() => ({ startedAt, now: Date.now() }));
  // 起点が変わった描画で now を取り直す (前の起点のままの差分を出さない)
  if (tick.startedAt !== startedAt) setTick({ startedAt, now: Date.now() });
  useEffect(() => {
    if (startedAt === undefined) return;
    const id = window.setInterval(() => setTick({ startedAt, now: Date.now() }), TICK_MS);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, tick.now - startedAt);
}
