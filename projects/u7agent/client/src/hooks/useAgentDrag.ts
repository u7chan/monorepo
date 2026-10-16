import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import {
  AGENT_DRAG_THRESHOLD,
  dropTargetFor,
  edgeScrollStep,
  moveAgentId,
  scrollableAncestor,
} from "../lib/agentReorder";

/** ドラッグ中に body へ付けるクラス。styles/index.css がカーソルと選択抑止を持つ */
const DRAGGING_CLASS = "is-dragging-agent";

/** 表示の追従に使う CSS 変数。行は layout の位置を保ち、この値だけでポインタへ追わせる */
const DRAG_Y_VARIABLE = "--agent-drag-y";

/** pointer capture 中の 1 回のドラッグ。move ごとの再描画を避けるため ref に持つ */
type AgentDragSession = {
  pointerId: number;
  id: string;
  /**
   * capture を取得した要素。グリップではなく**行の容器**が取る: live 差し替えでは React が行を
   * DOM 上で移動させるため、グリップ自身が外れて capture が失われる（docs/ui-layout.md）。
   * 終了経路で解放するのはこの要素（どの経路でも capture を残さない）。
   */
  captured: HTMLElement;
  /** 現在の表示順（ドラッグできる行だけ）。live 差し替えはこの配列の並べ替えとして計算する */
  current: string[];
  startY: number;
  pointerY: number;
  /** しきい値を越えるまでは掴んでいない（行の選択 / タップと区別する） */
  grabbed: boolean;
  /** 並びを実際に動かしたか。動いていなければ確定を送らない */
  moved: boolean;
  frame: number | null;
};

export type AgentDragOptions = {
  /** 行を含む容器（行は `data-agent-row` に id を持つ）。pointer capture もこの要素が取る */
  containerRef: RefObject<HTMLElement | null>;
  /** ドラッグできる行の id（表示順）。ビルトインは含めない */
  ids: readonly string[];
  /** live 差し替え（下書きの更新） */
  onMove: (ids: string[]) => void;
  /** 移動があったときだけ呼ぶ確定 */
  onCommit: () => void;
  /** 取り消し（Escape / pointercancel / unmount / レイアウト切替） */
  onCancel: () => void;
  /** 保存中は新しいドラッグを開始させない */
  disabled: boolean;
};

export type AgentDragContainerHandlers = {
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
};

export type AgentDrag = {
  /** ドラッグ中の行の id（見た目の切替に使う） */
  draggingId: string | null;
  /** グリップへ配る配線（開始だけ。以降のイベントは容器へ retarget される） */
  gripHandlers: (id: string) => { onPointerDown: (event: PointerEvent<HTMLElement>) => void };
  /** 行の容器へ配る配線 */
  containerHandlers: AgentDragContainerHandlers;
};

/**
 * エージェント一覧のグリップのドラッグ。判定は `lib/agentReorder.ts` の純関数へ置き、ここは
 * pointer capture・live 差し替え・端の自動スクロール・終了経路の後始末だけを持つ。
 * 終了経路（pointerup / pointercancel / lostpointercapture / Escape / unmount）は finishDrag 1 箇所に
 * まとめ、二重に走っても安全にする（SidebarResizeHandle と同じ作法）。
 */
export function useAgentDrag({ containerRef, ids, onMove, onCommit, onCancel, disabled }: AgentDragOptions): AgentDrag {
  const dragRef = useRef<AgentDragSession | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // move / tick から最新の callback を使う（依存で identity が変わってもドラッグを切らない）
  const handlersRef = useRef({ onMove, onCommit, onCancel });
  handlersRef.current = { onMove, onCommit, onCancel };
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const rowElements = useCallback(
    (order: readonly string[]): HTMLElement[] => {
      const container = containerRef.current;
      if (!container) return [];
      const found = new Map<string, HTMLElement>();
      for (const element of container.querySelectorAll<HTMLElement>("[data-agent-row]")) {
        const id = element.dataset.agentRow;
        if (id) found.set(id, element);
      }
      return order.map((id) => found.get(id)).filter((element): element is HTMLElement => element !== undefined);
    },
    [containerRef],
  );

  const finishDrag = useCallback(
    (pointerId: number | null, commitOrder: boolean) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
      dragRef.current = null;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      document.body.classList.remove(DRAGGING_CLASS);
      rowElements([drag.id])[0]?.style.removeProperty(DRAG_Y_VARIABLE);
      // capture の解放で lostpointercapture が来るが、dragRef が空なので再入は no-op になる
      if (drag.captured.hasPointerCapture(drag.pointerId)) drag.captured.releasePointerCapture(drag.pointerId);
      setDraggingId(null);
      if (!drag.grabbed) return;
      if (commitOrder && drag.moved) handlersRef.current.onCommit();
      else handlersRef.current.onCancel();
    },
    [rowElements],
  );

  /**
   * 掴んだ行をポインタの下へ留める。rect は自分の translate を含むので、いま書いている値を差し引いて
   * layout 位置を出し、**祖先のスクロールを含む viewport 座標**で合わせる（offsetTop では一覧の
   * スクロール枠の scrollTop が差し引かれない）。
   */
  const followPointer = useCallback(
    (drag: AgentDragSession): boolean => {
      const row = rowElements([drag.id])[0];
      if (!row) return false;
      const applied = Number.parseFloat(row.style.getPropertyValue(DRAG_Y_VARIABLE)) || 0;
      const rect = row.getBoundingClientRect();
      const center = rect.top + rect.height / 2 - applied;
      row.style.setProperty(DRAG_Y_VARIABLE, `${drag.pointerY - center}px`);
      return true;
    },
    [rowElements],
  );

  /** 端の帯に入ったら、いま実際にスクロールしている祖先（無ければページ）を回す */
  const autoScroll = useCallback(
    (drag: AgentDragSession): boolean => {
      const container = containerRef.current;
      if (!container) return false;
      const target = scrollableAncestor(container.parentElement) ?? document.scrollingElement;
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const step = edgeScrollStep(drag.pointerY, rect.top, rect.bottom);
      if (step === 0) return false;
      // 端まで来たら回し続けない (この場合は pointermove で再開する)
      const before = target.scrollTop;
      target.scrollTop += step;
      return target.scrollTop !== before;
    },
    [containerRef],
  );

  const tick = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || !drag.grabbed) return;
    drag.frame = null;
    const scrolled = autoScroll(drag);
    // 中心線を越えたら配列を差し替える（行の translate は差し替え後の位置へ合わせ直す）。中心線は
    // 掴んでいる行以外で見る: 自分の rect は translate でポインタに追従しており、判定を自己参照にする
    const rows = rowElements(drag.current);
    const centers: number[] = [];
    let from = -1;
    rows.forEach((row, index) => {
      if (drag.current[index] === drag.id) {
        from = index;
        return;
      }
      const rect = row.getBoundingClientRect();
      centers.push(rect.top + rect.height / 2);
    });
    if (from !== -1) {
      // 移動前の添字で数えた挿入先へ差し替える
      const next = moveAgentId(drag.current, from, dropTargetFor(centers, drag.pointerY, from));
      if (next.some((id, index) => id !== drag.current[index])) {
        drag.current = next;
        drag.moved = true;
        handlersRef.current.onMove(next);
      }
    }
    followPointer(drag);
    if (scrolled) drag.frame = requestAnimationFrame(tick);
  }, [autoScroll, followPointer, rowElements]);

  const scheduleTick = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || drag.frame !== null) return;
    drag.frame = requestAnimationFrame(tick);
  }, [tick]);

  const onGripPointerDown = useCallback(
    (id: string, event: PointerEvent<HTMLElement>) => {
      // 主ボタンだけで開始する。保存中とドラッグ中の 2 本目では開始し直さない
      if (disabled || dragRef.current || event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();
      container.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        id,
        captured: container,
        current: [...idsRef.current],
        startY: event.clientY,
        pointerY: event.clientY,
        grabbed: false,
        moved: false,
        frame: null,
      };
    },
    [containerRef, disabled],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.pointerY = event.clientY;
      if (!drag.grabbed) {
        if (Math.abs(event.clientY - drag.startY) < AGENT_DRAG_THRESHOLD) return;
        drag.grabbed = true;
        document.body.classList.add(DRAGGING_CLASS);
        setDraggingId(drag.id);
      }
      scheduleTick();
    },
    [scheduleTick],
  );

  const gripHandlers = useCallback(
    (id: string) => ({ onPointerDown: (event: PointerEvent<HTMLElement>) => onGripPointerDown(id, event) }),
    [onGripPointerDown],
  );

  const containerHandlers: AgentDragContainerHandlers = {
    onPointerMove,
    onPointerUp: (event) => finishDrag(event.pointerId, true),
    onPointerCancel: (event) => finishDrag(event.pointerId, false),
    onLostPointerCapture: (event) => finishDrag(event.pointerId, false),
  };

  // Escape は capture で受ける。App の設定ページの Escape（チャットへ戻る）は window の bubble で
  // defaultPrevented を見るため、消費しないと画面遷移まで起きる（docs/ui-layout.md）
  useEffect(() => {
    if (draggingId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finishDrag(null, false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [draggingId, finishDrag]);

  // 一覧が unmount する経路（レイアウト切替 / ページ移動）でも、capture・rAF・見た目・下書きを残さない
  useEffect(() => () => finishDrag(null, false), [finishDrag]);

  // live 差し替えは React のコミットで行の layout 位置を動かす。DOM 更新の直後（描画前）に測り直さないと、
  // 差し替えたフレームだけ行が別の位置に見える
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (drag?.grabbed) followPointer(drag);
  });

  return { draggingId, gripHandlers, containerHandlers };
}
