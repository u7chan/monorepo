import { useEffect, useState, type RefObject } from "react";
import { finishOnAnimationEnd } from "../lib/animationEnd";
import { exitPhaseAfterAnimation, nextExitPhase, type ExitPhase } from "../lib/exitPhase";

/**
 * 退場アニメの間だけ mount を延ばす phase。`open` が閉じたフレームで `closing` に入り、
 * `elementRef` の `animationend` (animation を切る環境では CSS の時間値から決めた保険) で `closed` になる。
 * 演出は CSS が持ち、ここは phase の寿命だけを決める。時間値は要素の computed から読むため、
 * CSS 側の長さを TS へ写さない (NavSheet と同じ)。
 */
export function useExitPhase(open: boolean, elementRef: RefObject<HTMLElement | null>): ExitPhase {
  const [phase, setPhase] = useState<ExitPhase>("closed");
  // 描画中の同期。Effect で拾うと closing へ入るのが 1 フレーム遅れ、退場アニメが始まらない
  const next = nextExitPhase(phase, open);
  if (next !== phase) setPhase(next);

  const closing = phase === "closing";
  useEffect(() => {
    if (!closing) return;
    const element = elementRef.current;
    // 退場中に要素が消えた (docked へ戻った等)。残す理由が無いので閉じ切る
    if (!element) {
      setPhase("closed");
      return;
    }
    return finishOnAnimationEnd(element, getComputedStyle(element).animationDuration, () => {
      setPhase(exitPhaseAfterAnimation("closing"));
    });
  }, [closing, elementRef]);

  return phase;
}
