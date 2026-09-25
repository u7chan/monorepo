import { useEffect, useState } from "react";

function detectViewportWidth(): number {
  return window.innerWidth;
}

/**
 * viewport の幅に追従する。モード判定 (useLayoutMode) とは別に、「左バーを引いた main 列の幅」と
 * 右パネルの bounds (30vw の下限 / main の残り幅) を出すために使う。
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(detectViewportWidth);

  useEffect(() => {
    const update = () => setWidth(detectViewportWidth());
    // 初回 render とこの effect の間にリサイズされている場合に追いつく
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return width;
}
