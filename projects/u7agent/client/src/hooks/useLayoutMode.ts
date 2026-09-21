import { useEffect, useState } from "react";
import { resolveLayoutMode, type LayoutMode } from "../lib/layout";

function detectLayoutMode(): LayoutMode {
  return resolveLayoutMode(window.innerWidth, window.innerHeight);
}

/**
 * viewport の大きさに追従してレイアウトモードを返す。
 * 初期値は render 中に確定させる (モバイルで desktop shell が一瞬出るのを避ける)。
 * 高さがソフトキーボードで縮む場合の挙動は docs/ui-layout.md の制約を参照。
 */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(detectLayoutMode);

  useEffect(() => {
    const update = () => setMode(detectLayoutMode());
    // 初回 render とこの effect の間にリサイズされている場合に追いつく
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return mode;
}
