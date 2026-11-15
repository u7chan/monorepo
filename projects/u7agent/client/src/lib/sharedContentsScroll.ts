export function keepSharedContentHeadingVisible(
  scroller: HTMLElement,
  heading: HTMLElement,
  restoreScrollTop?: number,
): void {
  if (!scroller.contains(heading)) return;

  if (restoreScrollTop !== undefined) scroller.scrollTop = restoreScrollTop;
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  const headingRect = heading.getBoundingClientRect();
  if (headingRect.top < top || headingRect.height > scroller.clientHeight) {
    scroller.scrollTop += headingRect.top - top;
  } else if (headingRect.bottom > bottom) {
    scroller.scrollTop += headingRect.bottom - bottom;
  }
}
