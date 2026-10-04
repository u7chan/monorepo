import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  canResizeFileTree,
  fileTreeWidth,
  fileTreeWidthBounds,
  fileTreeWidthStore,
  FILE_TREE_WIDTH_MIN,
} from "../lib/fileTreeWidth";

/** 幅を選ぶハンドル (FileTreeWidthResizeHandle) が使う値と操作 */
export type FileTreeResize = {
  /** 表示幅 (clamp 済み)。本文のコンテナの CSS 変数 --file-tree-width に渡す */
  width: number;
  min: number;
  max: number;
  /** min == max の幅 (上下 2 段 / @2xl の境界ちょうど) ではハンドルを出さない */
  resizable: boolean;
  /**
   * ドラッグ中の追従。state を動かさずコンテナの CSS 変数だけを書き換える (ツリーは行と
   * スクロール位置を含み、move ごとの再描画を避ける)。clamp は呼び出し側で済ませておく。
   */
  preview(width: number): void;
  /** 確定。state と保存値を更新する (ドラッグの終了 / キーボード操作) */
  commit(width: number): void;
  /** 未指定 (既定幅) へ戻し、保存を消す */
  reset(): void;
};

export type FileTreeWidth = FileTreeResize & {
  /** 本文の `@container` へ渡す ref。preview はここへ CSS 変数を直接書く */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 計測したコンテナ幅。左右 2 段 (幅を選べる面) の判定にも使う */
  containerWidth: number;
  /** 計測したコンテナ高さ。上下 2 段のツリーの高さ (useFileTreeHeight) の根拠 */
  containerHeight: number;
};

/**
 * ファイルツリーの幅。state は「ユーザーが示した希望幅」(clamp 前) で、表示幅は bounds で clamp する
 * (狭い窓で選んでも、広げ直したときに選んだ幅へ戻せる)。bounds が本文のコンテナ幅に依存するため、
 * その要素自身を ResizeObserver で見て clientWidth / clientHeight を state に写す。
 */
export function useFileTreeWidth(): FileTreeWidth {
  const [requested, setRequested] = useState<number | null>(() => fileTreeWidthStore.read());
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bounds = fileTreeWidthBounds(containerWidth);
  const width = fileTreeWidth(requested, containerWidth);

  // 計測は clientWidth / clientHeight に一本化する (contentRect の端数を別の丸めで扱わない)。初回は
  // 描画前に読み、以降は大きさが変わったときだけ state を更新する (サイドバーのドラッグでも callback が走る)
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const nextWidth = container.clientWidth;
      const nextHeight = container.clientHeight;
      setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      setContainerHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 依存を空にして identity を固定する (ハンドルのアンマウント時の後始末がこれに乗っている)
  const preview = useCallback((next: number) => {
    containerRef.current?.style.setProperty("--file-tree-width", `${next}px`);
  }, []);

  const commit = useCallback((next: number) => {
    setRequested(next);
    fileTreeWidthStore.write(next);
  }, []);

  const reset = useCallback(() => {
    setRequested(null);
    fileTreeWidthStore.write(null);
  }, []);

  return {
    containerRef,
    containerWidth,
    containerHeight,
    width,
    min: bounds?.min ?? FILE_TREE_WIDTH_MIN,
    max: bounds?.max ?? FILE_TREE_WIDTH_MIN,
    resizable: canResizeFileTree(bounds),
    preview,
    commit,
    reset,
  };
}
