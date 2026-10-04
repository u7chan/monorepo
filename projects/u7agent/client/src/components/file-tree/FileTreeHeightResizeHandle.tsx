import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FileTreeHeightResize } from "../../hooks/useFileTreeHeight";
import {
  clampFileTreeHeight,
  stepFileTreeHeight,
  FILE_TREE_HEIGHT_STEP,
  type FileTreeHeightBounds,
} from "../../lib/fileTreeHeight";

/** ドラッグ中に body へ付けるクラス。styles/index.css がカーソルと選択抑止を持つ */
const RESIZING_CLASS = "is-resizing-row";

/** pointer capture 中の 1 回のドラッグ。move ごとの再描画を避けるため ref に持つ */
type ResizeDrag = {
  pointerId: number;
  startY: number;
  startHeight: number;
  /** 最後に表示した高さ (終了経路で commit する値) */
  height: number;
};

/**
 * 上下 2 段のツリーの下端に重ねる高さのハンドル。ドラッグ / ↑↓ / Home / End / ダブルクリックで高さを決める。
 * 幅 (FileTreeWidthResizeHandle) と逆向きで、下へ動かす = ツリーを高くする。プレビュー側へはみ出さないよう、
 * 当たり判定はツリーの中 (境界の上) に置く。0px はツリーを完全に隠す (このハンドルは残るので戻せる)。
 * 高さの state は FileBrowser 側が持つため、ここは表示の追従 (preview) と確定 (commit) を呼ぶだけ。
 */
export function FileTreeHeightResizeHandle({
  height,
  min,
  max,
  preview,
  commit,
  reset,
}: Omit<FileTreeHeightResize, "resizable">) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  // 未指定 (内容の高さ) のときの現在値は state に無いため、親 (ツリー) を測って持つ。
  // ↑↓ の起点と、ドラッグの起点と aria-valuenow に使う
  const [current, setCurrent] = useState<number | null>(null);
  // アンマウント時の後始末 (cleanup) は mount 時の closure を掴むため、判断に使う選択状態は ref から読む
  const heightRef = useRef(height);
  heightRef.current = height;
  const bounds: FileTreeHeightBounds = { min, max };

  useLayoutEffect(() => {
    const tree = handleRef.current?.parentElement;
    if (!tree) return;
    const measure = () => setCurrent(Math.round(tree.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  // 終了経路 (pointerup / pointercancel / lostpointercapture / unmount) をここへまとめる。
  // どの経路でもカーソルの解除・選択抑止の解除・aria-valuenow の確定を同じ処理で行う。
  // pointerId は「いま drag 中のポインター」だけを受け付ける (別の指の同時タッチで終わらせない)
  const finishDrag = (pointerId: number | null, commitHeight: boolean) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    document.body.classList.remove(RESIZING_CLASS);
    handleRef.current?.setAttribute("aria-valuenow", String(drag.height));
    // 移動ゼロのクリックは高さを選んだ操作ではないので、commit も保存もしない。未指定 (auto) から
    // 始めたドラッグは、プレビューで書いた px をここで変数ごと auto へ戻す (再描画は起きない)
    if (commitHeight && drag.height !== drag.startHeight) {
      commit(drag.height);
      return;
    }
    if (heightRef.current === null) preview(null);
  };

  // ツリーが消える経路 (タブを全部閉じる / パネルを閉じる) でも、ドラッグ中の見た目と
  // 選択抑止を残さない
  useEffect(() => {
    return () => finishDrag(null, true);
  }, [commit]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 主ボタンだけで開始する。ドラッグ中の 2 本目のタッチでは開始し直さない
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // 起点は「いま見えている高さ」にする (未指定でも、掴んだ位置から動き出す)
    const tree = event.currentTarget.parentElement;
    const start = tree ? Math.round(tree.clientHeight) : (current ?? height ?? min);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: start, height: start };
    document.body.classList.add(RESIZING_CLASS);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 開始高さからの絶対計算にする (clamp で端に貼り付いても、戻せば追従する)。
    // ハンドルはツリーの下端にあるため、下へ動かす = 高さを増やす
    const next = clampFileTreeHeight(drag.startHeight + (event.clientY - drag.startY), bounds);
    drag.height = next;
    preview(next);
    // 読み上げの値も表示と同じタイミングで動かす (state へ入るのは終了時)
    handleRef.current?.setAttribute("aria-valuenow", String(next));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 起点は選択値。未指定のときだけ実測値を使う (計測は 1 フレーム遅れるため、選択値を実測で
    // 上書きすると連打で同じ値を書き戻してしまう)
    const base = height ?? current ?? min;
    // ハンドルはツリーの下端にあるため、下へ動かす = 高さを増やす
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const delta = event.key === "ArrowDown" ? FILE_TREE_HEIGHT_STEP : -FILE_TREE_HEIGHT_STEP;
      event.preventDefault();
      commit(stepFileTreeHeight(base, delta, bounds));
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
      aria-label="ファイルツリーの高さ"
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={height ?? current ?? min}
      tabIndex={0}
      className="file-tree-height-handle panel-resize-handle absolute inset-x-0 bottom-0 h-2 cursor-row-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset pointer-coarse:h-5"
      onDoubleClick={() => {
        reset();
        // 既に未指定 (null) のときは再描画が起きず、変数がドラッグ中の px のまま残る
        if (heightRef.current === null) preview(null);
      }}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => finishDrag(event.pointerId, true)}
      onPointerCancel={(event) => finishDrag(event.pointerId, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event.pointerId, true)}
    />
  );
}
