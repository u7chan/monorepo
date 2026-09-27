import { useCallback, useRef, useState, type RefObject } from "react";
import { sidebarWidth, sidebarWidthBounds, sidebarWidthStore } from "../lib/sidebarWidth";

/** 幅を選ぶハンドル (SidebarResizeHandle) が使う値と操作 */
export type SidebarResize = {
  /** 表示幅 (clamp 済み)。シェルの CSS 変数 --sidebar-width に渡す */
  width: number;
  min: number;
  max: number;
  /**
   * ドラッグ中の追従。state を動かさずシェルの CSS 変数だけを書き換える (左バーは一覧の行と
   * スクロール位置を含み、move ごとの再描画を避ける)。clamp は呼び出し側で済ませておく。
   */
  preview(width: number): void;
  /** 確定。state と保存値を更新する (ドラッグの終了 / キーボード操作) */
  commit(width: number): void;
  /** 未指定 (既定幅 = 下限) へ戻し、保存を消す */
  reset(): void;
};

export type SidebarWidth = SidebarResize & {
  /** シェル (div) へ渡す ref。preview はここへ CSS 変数を直接書く */
  shellRef: RefObject<HTMLDivElement | null>;
};

/**
 * 左バーの幅。state は「ユーザーが示した希望幅」(clamp 前) で、表示幅は bounds で clamp する
 * (狭い窓で選んでも、広げ直したときに選んだ幅へ戻せる)。bounds は定数なので viewport に依存しない。
 */
export function useSidebarWidth(): SidebarWidth {
  const [requested, setRequested] = useState<number | null>(() => sidebarWidthStore.read());
  const shellRef = useRef<HTMLDivElement | null>(null);
  const bounds = sidebarWidthBounds();
  const width = sidebarWidth(requested, bounds);

  // 依存を空にして identity を固定する (ハンドルのアンマウント時の後始末がこれに乗っている)
  const preview = useCallback((next: number) => {
    shellRef.current?.style.setProperty("--sidebar-width", `${next}px`);
  }, []);

  const commit = useCallback((next: number) => {
    setRequested(next);
    sidebarWidthStore.write(next);
  }, []);

  const reset = useCallback(() => {
    setRequested(null);
    sidebarWidthStore.write(null);
  }, []);

  return {
    shellRef,
    width,
    min: bounds.min,
    max: bounds.max,
    preview,
    commit,
    reset,
  };
}
