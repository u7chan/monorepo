/**
 * 退場アニメの間だけ mount を延ばすための phase。演出は CSS が持ち、ここは「閉じた後も再生が終わるまで
 * 要素を残す」寿命だけを決める (時間は要素の computed から読むので値を持たない)。
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
