import { useRef, type KeyboardEvent } from "react";
import { usePointerDrag } from "../../hooks/usePointerDrag";
import type { SidebarResize } from "../../hooks/useSidebarWidth";
import {
  clampSidebarWidth,
  stepSidebarWidth,
  SIDEBAR_WIDTH_STEP,
  type SidebarWidthBounds,
} from "../../lib/sidebarWidth";

/**
 * 左バー右端に重ねる幅のハンドル (ドラッグ / →← / Home / End / ダブルクリック)。幅の state は App が
 * 持ち、ここは preview と commit を呼ぶだけ。右パネルとは向きが逆で、右へ動かす = 幅を増やす。
 */
export function SidebarResizeHandle({ width, min, max, preview, commit, reset }: SidebarResize) {
  const handleRef = useRef<HTMLDivElement>(null);
  const bounds: SidebarWidthBounds = { min, max };

  const drag = usePointerDrag({
    start: width,
    move: (deltaX, start) => {
      // ハンドルは左バーの右端にあるため、右へ動かす = 幅を増やす
      const next = clampSidebarWidth(start + deltaX, bounds);
      preview(next);
      handleRef.current?.setAttribute("aria-valuenow", String(next));
      return next;
    },
    end: (value, start) => {
      handleRef.current?.setAttribute("aria-valuenow", String(value));
      if (value !== start) commit(value);
    },
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // ハンドルは左バーの右端にあるため、右へ動かす = 幅を増やす
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const delta = event.key === "ArrowRight" ? SIDEBAR_WIDTH_STEP : -SIDEBAR_WIDTH_STEP;
      event.preventDefault();
      commit(stepSidebarWidth(width, delta, bounds));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      commit(event.key === "Home" ? min : max);
    }
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-label="左バーの幅"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className="panel-resize-handle absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      onDoubleClick={reset}
      onKeyDown={handleKeyDown}
      {...drag}
    />
  );
}
