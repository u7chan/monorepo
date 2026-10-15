import { useLayoutEffect, useState } from "react";
import { resolveLayoutMode, resolveWide, type LayoutMode } from "../lib/layout";

interface ViewportLayout {
  mode: LayoutMode;
  /** 一覧と編集面を並べてよい幅か (lib/layout.ts の WIDE_MIN_WIDTH) */
  wide: boolean;
}

function detectLayout(): ViewportLayout {
  return { mode: resolveLayoutMode(window.innerWidth, window.innerHeight), wide: resolveWide(window.innerWidth) };
}

/** モードを `html[data-layout]` へ写す。CSS の `singleColumn` バリアントと、top layer に載る popover がこれを見る */
function applyLayoutMode(mode: LayoutMode): void {
  document.documentElement.dataset.layout = mode;
}

/**
 * viewport の大きさに追従して、モードと「並べられる幅か」を返す。どちらも同じ resize / orientationchange を
 * 購読し、初期値は render 中に確定させる (モバイルで desktop shell が一瞬出るのを避ける)。
 * 高さがソフトキーボードで縮む場合の挙動は docs/ui-layout.md の制約を参照。
 */
function useViewportLayout(): ViewportLayout {
  const [layout, setLayout] = useState<ViewportLayout>(detectLayout);

  // ResizeObserver ではなく layout effect で購読するのは、初回を paint 前に同期するため。
  // 属性が無い間は CSS の singleColumn バリアントが効かず、初期 state が singleColumn でも desktop の寸法で描画される
  useLayoutEffect(() => {
    const update = () => {
      const next = detectLayout();
      // 属性は setState より先に書く。開いている popover は再描画時の layout effect で rect を測るので、
      // 逆順だと古い寸法のまま place() が走ってから新しい大きさに飛ぶ
      applyLayoutMode(next.mode);
      setLayout(next);
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

  return layout;
}

/** レイアウトモード。設定のシートへの出し分けは `useWideLayout` を使う (docs/ui-layout.md) */
export function useLayoutMode(): LayoutMode {
  return useViewportLayout().mode;
}

/** 一覧と編集面を並べてよい幅か。閾値の理由は lib/layout.ts の WIDE_MIN_WIDTH を参照 */
export function useWideLayout(): boolean {
  return useViewportLayout().wide;
}
