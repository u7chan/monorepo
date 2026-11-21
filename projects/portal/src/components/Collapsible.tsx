// Collapsible - 開閉で高さが滑らかに変わる領域
//
// 高さを直接アニメーションせず、grid の行を 0fr ↔ 1fr に切り替える。中身の高さが
// 不定でも JS で測らずに済む。閉じ終わるまで中身を残し、終わったらアンマウントする
// (開いたときだけ読み込む処理を、閉じている間は動かさないため)。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const DURATION_MS = 300;

export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }

    setExpanded(false);
    const timer = window.setTimeout(() => setMounted(false), DURATION_MS + 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 0fr の状態を一度確定させてから開く。同じフレームで切り替えると遷移が走らない
  useLayoutEffect(() => {
    if (mounted && open && !expanded) {
      ref.current?.getBoundingClientRect();
      setExpanded(true);
    }
  }, [mounted, open, expanded]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={ref}
      inert={!expanded}
      className={[
        "grid transition-[grid-template-rows,opacity] duration-300 ease-ios",
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      ].join(" ")}
    >
      {/* フォーカスリングが overflow で欠けないよう、余白を内側に取る */}
      <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
    </div>
  );
}

export default Collapsible;
