import type { RowMenuRect } from "./rowMenu";

/**
 * popover のアンカー可視性に使う領域。viewport に加えて、overflow-y を持つ直近の祖先
 * (一覧のスクロール枠) を返す。popover は top layer に載るので枠に切られはしないが、
 * アンカーが枠の外へ動いたら追従せず閉じる (見えていない行のメニューを残さない)。
 */
export function scrollClip(element: HTMLElement): RowMenuRect | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent.getBoundingClientRect();
  }
  return null;
}

export function visibleClips(element: HTMLElement): RowMenuRect[] {
  const viewport = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  const clip = scrollClip(element);
  return clip === null ? [viewport] : [viewport, clip];
}
