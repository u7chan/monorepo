import { useRef, type KeyboardEvent } from "react";
import { usePointerDrag } from "../../hooks/usePointerDrag";
import type { FileTreeResize } from "../../hooks/useFileTreeWidth";
import {
  clampFileTreeWidth,
  stepFileTreeWidth,
  FILE_TREE_WIDTH_STEP,
  type FileTreeWidthBounds,
} from "../../lib/fileTreeWidth";

/**
 * ファイルツリー右端に重ねる幅のハンドル (ドラッグ / →← / Home / End / ダブルクリック)。幅の state は
 * FileBrowser が持ち、ここは preview と commit を呼ぶだけ。位置は `--file-tree-width` に追随させる。
 */
export function FileTreeWidthResizeHandle({
  width,
  min,
  max,
  preview,
  commit,
  reset,
}: Omit<FileTreeResize, "resizable">) {
  const handleRef = useRef<HTMLDivElement>(null);
  const bounds: FileTreeWidthBounds = { min, max };

  const drag = usePointerDrag({
    start: width,
    move: (deltaX, start) => {
      // ハンドルはツリーの右端にあるため、右へ動かす = 幅を増やす
      const next = clampFileTreeWidth(start + deltaX, bounds);
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
    // ハンドルはツリーの右端にあるため、右へ動かす = 幅を増やす
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const delta = event.key === "ArrowRight" ? FILE_TREE_WIDTH_STEP : -FILE_TREE_WIDTH_STEP;
      event.preventDefault();
      commit(stepFileTreeWidth(width, delta, bounds));
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
      aria-label="ファイルツリーの幅"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className="panel-resize-handle absolute inset-y-0 left-[calc(var(--file-tree-width)_-_4px)] w-2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      onDoubleClick={reset}
      onKeyDown={handleKeyDown}
      {...drag}
    />
  );
}
