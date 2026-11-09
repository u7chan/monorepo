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
 * 高さの開閉 (styles/index.css の `.tree-fold`)。`data-open` で grid の行を 0fr → 1fr へ動かし、
 * 畳んだ中身は親の高さ 0 で潰す。
 *
 * 中身は開いた commit で mount し、閉じた後も遷移が終わるまで残す。閉じ切る前に unmount すると
 * 1fr → 0fr が走らず、閉じる側だけ瞬時に消えるため。`details::details-content` の遷移と違って
 * `interpolate-size` に依らないので、Safari でも開く (docs/frontend.md#コンポーネントの契約)。
 *
 * 閉じている間は inert にして、高さ 0 で見えない中身をフォーカスと読み上げの対象に残さない。
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
