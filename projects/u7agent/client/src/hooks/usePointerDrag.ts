import { useCallback, useEffect, useRef, type PointerEvent } from "react";

/** ドラッグ中に body へ付けるクラス。styles/index.css がカーソルと選択抑止を持つ */
const RESIZING_CLASS = "is-resizing-panel";

/** pointer capture 中の 1 回のドラッグ。move ごとの再描画を避けるため ref に持つ */
type DragState = {
  pointerId: number;
  startX: number;
  /** 開始時の値。終了時に move の結果と比べ、動いていなければ確定しない */
  start: number;
  /** 最後に表示した値 (終了経路で確定する値) */
  value: number;
};

export type PointerDragOptions = {
  /** ドラッグ開始時点の値 (幅など)。pointerdown の瞬間に控え、以後の移動量の基準にする
   * (毎回の移動量を足し込まないので、clamp で端に貼り付いても戻せば追従する) */
  start: number;
  /** 横移動量 (px) と開始値を受け取り、表示する値を返す。返した値がそのまま終了時の値になる */
  move: (deltaX: number, start: number) => number;
  /** 終了経路で 1 回だけ呼ぶ。動いていなければ `value` は `start` と同じ */
  end: (value: number, start: number) => void;
};

/** ハンドル要素へ配る配線。要素へ直接購読せず props で渡す (React の合成イベントの順序を変えない) */
export type PointerDragHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
};

/**
 * ウィンドウ境界のドラッグ (pointerdown → move → 終了) の殻。幅の計算・aria-*・確定の条件は
 * 呼び出し側に残す (3 か所で向きも clamp も違う)。移動ゼロのクリックは幅を選んだ操作ではない。
 */
export function usePointerDrag({ start, move, end }: PointerDragOptions): PointerDragHandlers {
  const dragRef = useRef<DragState | null>(null);
  // move / end から最新の callback を使う (依存で identity が変わってもドラッグを切らない)
  const optionsRef = useRef({ start, move, end });
  optionsRef.current = { start, move, end };

  /**
   * 終了経路 (pointerup / pointercancel / lostpointercapture / unmount) をここへまとめ、カーソルの解除・
   * 選択抑止の解除・確定を同じ処理で行う (drag 中の pointerId だけを受け付ける)。
   */
  const finish = useCallback((pointerId: number | null) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    document.body.classList.remove(RESIZING_CLASS);
    optionsRef.current.end(drag.value, drag.start);
  }, []);

  // ハンドルが消える経路 (パネルを閉じる / 会話の切替 / overlay への退避) でも、ドラッグ中の
  // 見た目と選択抑止を残さない
  useEffect(() => {
    return () => finish(null);
  }, [finish]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    // 主ボタンだけで開始する。ドラッグ中の 2 本目のタッチでは開始し直さない
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startValue = optionsRef.current.start;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, start: startValue, value: startValue };
    document.body.classList.add(RESIZING_CLASS);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.value = optionsRef.current.move(event.clientX - drag.startX, drag.start);
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => finish(event.pointerId), [finish]);
  const onPointerCancel = useCallback((event: PointerEvent<HTMLElement>) => finish(event.pointerId), [finish]);
  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLElement>) => finish(event.pointerId), [finish]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture };
}
