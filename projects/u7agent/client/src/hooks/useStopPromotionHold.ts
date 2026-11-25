import { useCallback, useEffect, useState } from "react";

/**
 * 送信・録音の終了の直後に主スロットの入れ替えを保留する時間。本文を消した描画で ↑ が ■ へ変わると、
 * 1 回目のクリックの続き (二度押し / ダブルタップ) がそのまま停止に届き、走っている実行と待機キューが落ちる
 */
const STOP_PROMOTION_HOLD_MS = 500;

/**
 * 主スロット (送信 ↑ / 停止 ■) の入れ替えの保留。`hold()` のたびに期限を延ばし、最後の呼び出しから
 * `STOP_PROMOTION_HOLD_MS` だけ `held` を保つ。送信の直後と録音の終了の直後で同じ形になるため、
 * どちらもこの 1 つのタイマーに寄せる。
 */
export function useStopPromotionHold(): { held: boolean; hold: () => void } {
  // 0 以外 = 保留中。番号を進めると、保留中に呼ばれた分も期限を延ばせる
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const timer = window.setTimeout(() => setCount(0), STOP_PROMOTION_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  const hold = useCallback(() => setCount((current) => current + 1), []);
  return { held: count > 0, hold };
}
