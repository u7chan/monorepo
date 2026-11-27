const GLOW_KEYFRAMES: Keyframe[] = [{ textShadow: "0 0 12px var(--c-accent)" }, { textShadow: "0 0 0 transparent" }];

const GLOW_OPTIONS: KeyframeAnimationOptions = { duration: 550, easing: "ease-out" };

/**
 * 途中の文字起こしが入るたびに入力欄の文字をひと光りさせる。前の光りが残っていれば切って最初から始める。
 * CSS の animation にしないのは、同じ class でやり直すのに reflow が要り、途中文の頻度で強制再描画が走るため。
 */
export function glowVoiceInputText(element: HTMLElement, previous: Animation | null): Animation | null {
  previous?.cancel();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return element.animate(GLOW_KEYFRAMES, GLOW_OPTIONS);
}
