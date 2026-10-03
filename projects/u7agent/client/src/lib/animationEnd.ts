import { maxDurationMs } from "./cssTime";

export function finishOnAnimationEnd(element: EventTarget, duration: string, onFinished: () => void): () => void {
  let active = true;
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    element.removeEventListener("animationend", onEnd);
  };
  const finish = () => {
    if (!active) return;
    cleanup();
    onFinished();
  };
  const onEnd = (event: Event) => {
    if (event.target === element) finish();
  };
  // animationend が来ない環境でも終了できるよう、CSS の長さから保険を決める。
  const timer = setTimeout(finish, maxDurationMs(duration) * 2 + 100);
  element.addEventListener("animationend", onEnd);
  return cleanup;
}
