import { useLayoutEffect, useState } from "react";
import { resolveLayoutMode, type LayoutMode } from "../lib/layout";

function detectLayoutMode(): LayoutMode {
  return resolveLayoutMode(window.innerWidth, window.innerHeight);
}

/** モードを `html[data-layout]` へ写す。CSS の `singleColumn` バリアントと、top layer に載る popover がこれを見る */
function applyLayoutMode(mode: LayoutMode): void {
  document.documentElement.dataset.layout = mode;
}

/**
 * viewport の大きさに追従してレイアウトモードを返す。
 * 初期値は render 中に確定させる (モバイルで desktop shell が一瞬出るのを避ける)。
 * 高さがソフトキーボードで縮む場合の挙動は docs/ui-layout.md の制約を参照。
 */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(detectLayoutMode);

  // ResizeObserver ではなく layout effect で購読するのは、初回を paint 前に同期するため。
  // 属性が無い間は CSS の singleColumn バリアントが効かず、初期 state が singleColumn でも desktop の寸法で描画される
  useLayoutEffect(() => {
    const update = () => {
      const next = detectLayoutMode();
      // 属性は setState より先に書く。開いている popover は再描画時の layout effect で rect を測るので、
      // 逆順だと古い寸法のまま place() が走ってから新しい大きさに飛ぶ
      applyLayoutMode(next);
      setMode(next);
    };
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
