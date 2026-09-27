import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { SidebarResize } from "../../hooks/useSidebarWidth";
import {
  clampSidebarWidth,
  stepSidebarWidth,
  SIDEBAR_WIDTH_STEP,
  type SidebarWidthBounds,
} from "../../lib/sidebarWidth";

/** ドラッグ中に body へ付けるクラス。styles/index.css がカーソルと選択抑止を持つ */
const RESIZING_CLASS = "is-resizing-panel";

/** pointer capture 中の 1 回のドラッグ。move ごとの再描画を避けるため ref に持つ */
type ResizeDrag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** 最後に表示した幅 (終了経路で commit する値) */
  width: number;
};

/**
 * 左バー右端に重ねる幅のハンドル。ドラッグ / →← / Home / End / ダブルクリックで幅を決める。
 * 幅の state は App 側が持つため、ここは表示の追従 (preview) と確定 (commit) を呼ぶだけ。
 * 右パネル (SessionFilesPanel の左端) とは向きが逆で、右へ動かす = 幅を増やす。
 */
export function SidebarResizeHandle({ width, min, max, preview, commit, reset }: SidebarResize) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const bounds: SidebarWidthBounds = { min, max };

  // 終了経路 (pointerup / pointercancel / lostpointercapture / unmount) をここへまとめる。
  // どの経路でもカーソルの解除・選択抑止の解除・aria-valuenow の確定を同じ処理で行う。
  // pointerId は「いま drag 中のポインター」だけを受け付ける (別の指の同時タッチで終わらせない)
  const finishDrag = (pointerId: number | null, commitWidth: boolean) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    document.body.classList.remove(RESIZING_CLASS);
    handleRef.current?.setAttribute("aria-valuenow", String(drag.width));
    // 移動ゼロのクリックは幅を選んだ操作ではないので、commit も保存もしない
    if (commitWidth && drag.width !== drag.startWidth) commit(drag.width);
  };

  // 左バーが消える経路 (overlay へ退避 / 設定ページからの unmount) でも、ドラッグ中の見た目と
  // 選択抑止を残さない
  useEffect(() => {
    return () => finishDrag(null, true);
  }, [commit]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 主ボタンだけで開始する。ドラッグ中の 2 本目のタッチでは開始し直さない
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
    document.body.classList.add(RESIZING_CLASS);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 開始幅からの絶対計算にする (clamp で端に貼り付いても、戻せば追従する)。
    // ハンドルは左バーの右端にあるため、右へ動かす = 幅を増やす
    const next = clampSidebarWidth(drag.startWidth + (event.clientX - drag.startX), bounds);
    drag.width = next;
    preview(next);
    // 読み上げの値も表示と同じタイミングで動かす (state へ入るのは終了時)
    handleRef.current?.setAttribute("aria-valuenow", String(next));
  };

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
      onLostPointerCapture={(event) => finishDrag(event.pointerId, true)}
      onPointerCancel={(event) => finishDrag(event.pointerId, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event.pointerId, true)}
    />
  );
}
