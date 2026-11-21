// useScrollPast - ページが threshold (px) より下までスクロールされたか

import { useEffect, useState } from "react";

export function useScrollPast(threshold: number): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    // 同じ値の set は再描画を起こさないため、スクロールのたびに呼んでよい
    const update = () => setPast(window.scrollY > threshold);

    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [threshold]);

  return past;
}

export default useScrollPast;
