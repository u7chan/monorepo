import { useEffect, useState } from "react";
import { resolveLayoutMode, type LayoutMode } from "../lib/layout";

function detectLayoutMode(): LayoutMode {
  return resolveLayoutMode(window.innerWidth, window.innerHeight);
}

/**
 * viewport の大きさに追従してレイアウトモードを返す。
 * 初期値は render 中に確定させる (モバイルで desktop shell が一瞬出るのを避ける)。
 *
 * Android Chrome はソフトキーボード表示で innerHeight が縮むため、desktop 表示中に
 * 入力すると一時的に landscape へ切り替わることがある。復帰するので許容する。
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
