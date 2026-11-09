import { maxDurationMs } from "./cssTime";

/**
 * 1 本のイベント (animationend / transitionend) で終わるまで待つ。`finished` が true を返した
 * イベントだけを終了として扱い、イベントが来ない環境でも CSS の長さから決めた保険で終了する。
 */
function finishOnEvent(
  element: EventTarget,
  eventName: string,
  duration: string,
  finished: (event: Event) => boolean,
  onFinished: () => void,
): () => void {
  let active = true;
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    element.removeEventListener(eventName, onEvent);
  };
  const finish = () => {
    if (!active) return;
    cleanup();
    onFinished();
  };
  const onEvent = (event: Event) => {
    if (finished(event)) finish();
  };
  // イベントが来ない環境でも終了できるよう、CSS の長さから保険を決める。
  const timer = setTimeout(finish, maxDurationMs(duration) * 2 + 100);
  element.addEventListener(eventName, onEvent);
  return cleanup;
}

export function finishOnAnimationEnd(element: EventTarget, duration: string, onFinished: () => void): () => void {
  return finishOnEvent(element, "animationend", duration, (event) => event.target === element, onFinished);
}

/**
 * 対象の要素自身の、指定した property の遷移が終わってから完了する。`transitionend` は色や
 * chevron の遷移でも鳴り、子孫の遷移も泡で届くため、propertyName と target の両方で絞る
 * (折りたたみの高さ = grid-template-rows だけを待つ)。
 */
export function finishOnTransitionEnd(
  element: EventTarget,
  duration: string,
  propertyName: string,
  onFinished: () => void,
): () => void {
  return finishOnEvent(
    element,
    "transitionend",
    duration,
    (event) => event.target === element && (event as TransitionEvent).propertyName === propertyName,
    onFinished,
  );
}
