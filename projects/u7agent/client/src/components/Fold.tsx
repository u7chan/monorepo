import { useEffect, useRef, useState, type ReactNode } from "react";
import { finishOnTransitionEnd } from "../lib/animationEnd";
import { cn } from "../lib/cn";

export type FoldProps = {
  open: boolean;
  /** 位置・幅だけ (見た目は持たない) */
  className?: string;
  /** 閉じている間も中身を残す (入力中の下書きを捨てない面)。既定は閉じ切ったら unmount する */
  keepMounted?: boolean;
  children: ReactNode;
};

/**
 * 高さの開閉 (styles/index.css の `.tree-fold`)。`data-open` で 0fr → 1fr へ動かし、中身は閉じた後も
 * 遷移が終わるまで残す (先に unmount すると閉じる側だけ瞬時に消える)。閉じている間は inert にする。
 */
export function Fold({ open, className, keepMounted = false, children }: FoldProps) {
  const [present, setPresent] = useState(open);
  const foldRef = useRef<HTMLDivElement>(null);
  // 描画中に同期する。Effect で拾うと中身の mount が data-open より 1 frame 遅れ、伸び始めの高さが飛ぶ
  if (open && !present) setPresent(true);
  const closing = !open && present;
  useEffect(() => {
    if (!closing) return;
    const element = foldRef.current;
    // 遷移中に入れ物ごと消えた (面の切替)。残す理由が無いので閉じ切る
    if (element === null) {
      setPresent(false);
      return;
    }
    return finishOnTransitionEnd(element, getComputedStyle(element).transitionDuration, "grid-template-rows", () =>
      setPresent(false),
    );
  }, [closing]);

  return (
    <div ref={foldRef} className={cn("tree-fold", className)} data-open={open} inert={!open}>
      <div>{keepMounted || present ? children : null}</div>
    </div>
  );
}
