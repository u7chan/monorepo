const GLOW_KEYFRAMES: Keyframe[] = [{ textShadow: "0 0 12px var(--c-accent)" }, { textShadow: "0 0 0 transparent" }];

const GLOW_OPTIONS: KeyframeAnimationOptions = { duration: 550, easing: "ease-out" };

/**
 * 途中の文字起こしが入るたびに、入力欄の文字をアクセント色でひと光りさせる。前の光りが残っていれば
 * 切って最初から始め、続けて届いても光が溜まらない。動きの軽減を求める環境では光らせず null を返す。
 *
 * CSS の animation にしないのは、同じ class のまま演出をやり直すには reflow を挟む必要があり、
 * 途中文の頻度で強制再描画が走るため。そのぶん動きの軽減の判定はここで持つ。
 */
export function glowVoiceInputText(element: HTMLElement, previous: Animation | null): Animation | null {
  previous?.cancel();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  return element.animate(GLOW_KEYFRAMES, GLOW_OPTIONS);
}
