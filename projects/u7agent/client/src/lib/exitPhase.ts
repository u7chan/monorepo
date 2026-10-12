/**
 * 退場アニメの間だけ mount を延ばすための phase。演出そのものは CSS が持ち、ここは
 * 「state が閉じた後も CSS の再生が終わるまで要素を残す」ための寿命だけを決める。
 * 時間の突き合わせは要素の computed から読む (lib/animationEnd.ts) ので、ここに値は持たない。
 */

export type ExitPhase = "open" | "closing" | "closed";

/**
 * `open` の変化に対する次の phase。初期値は `closed` なので、閉じた状態で生まれた要素は
 * 退場アニメを再生しない (起動直後に 1 度だけ閉じる動きを見せない)。
 */
export function nextExitPhase(phase: ExitPhase, open: boolean): ExitPhase {
  if (open) return "open";
  return phase === "open" ? "closing" : phase;
}

/** アニメの終了。再生中だけ閉じ切る (再生していない phase の終了イベントでは何も進めない) */
export function exitPhaseAfterAnimation(phase: ExitPhase): ExitPhase {
  return phase === "closing" ? "closed" : phase;
}
