import { useEffect, useState } from "react";
import { voiceInputRemainingRatio } from "../lib/voiceInput/composer";

/** 弧の刻み。1 秒ごとに描き直し、残り時間が 2 分あるうちは角度の差が読める粒度にする */
const TICK_MS = 1000;

/**
 * 録音の残り時間の割合（1 → 0）。録音中だけ時計を進め、停止・確定待ちでは止める。
 * 期限は `performance.now()` の基準（`client/src/lib/voiceInput/session.ts`）なので、`Date.now()` とは混ぜない。
 */
export function useVoiceInputRemaining(deadline: number | null, startedAt: number | null): number {
  const active = deadline !== null && startedAt !== null;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    setNow(performance.now());
    const id = window.setInterval(() => setNow(performance.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active, deadline, startedAt]);
  return voiceInputRemainingRatio(deadline, startedAt, now);
}
