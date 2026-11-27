import { useCallback, useState, type RefObject } from "react";
import {
  canResizeFileTreeHeight,
  fileTreeHeight,
  fileTreeHeightBounds,
  fileTreeHeightLimit,
  fileTreeHeightStore,
  FILE_TREE_HEIGHT_DEFAULT_MAX,
  FILE_TREE_HEIGHT_MIN,
} from "../lib/fileTreeHeight";

/** 高さを選ぶハンドル (FileTreeHeightResizeHandle) が使う値と操作 */
export type FileTreeHeightResize = {
  /** 選んだ高さ。null は未指定 = 内容の高さ (上限 256px / コンテナ) に追随する */
  height: number | null;
  min: number;
  max: number;
  /** min == max の高さ (容器がプレビューの下限以下) ではハンドルを出さない */
  resizable: boolean;
  /**
   * ドラッグ中の追従。state を動かさずコンテナの CSS 変数だけを書き換える (行とスクロール位置の
   * 再描画を避ける)。clamp は呼び出し側で済ませ、null は未指定 (auto) へ戻す。
   */
  preview(height: number | null): void;
  /** 確定。state と保存値を更新する (ドラッグの終了 / キーボード操作) */
  commit(height: number): void;
  /** 未指定 (内容の高さ) へ戻し、保存を消す */
  reset(): void;
};

export type FileTreeHeight = FileTreeHeightResize & {
  /** CSS 変数 --file-tree-height-max に入れる上限 (未指定のときは既定の上限) */
  limit: number;
};

export type FileTreeHeightInput = {
  /** 幅の hook が持つ本文のコンテナ (preview はここへ CSS 変数を直接書く) */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 計測したコンテナ高さ (useFileTreeWidth)。bounds の根拠 */
  containerHeight: number;
};

/**
 * 上下 2 段のときのファイルツリーの高さ。state は clamp 前の希望高さで、表示は bounds で clamp する
 * (狭い窓で選んでも広げ直したときに戻せる)。未指定 (null) は CSS の auto と上限に任せる。
 */
export function useFileTreeHeight({ containerRef, containerHeight }: FileTreeHeightInput): FileTreeHeight {
  const [requested, setRequested] = useState<number | null>(() => fileTreeHeightStore.read());
  const bounds = fileTreeHeightBounds(containerHeight);
  const height = fileTreeHeight(requested, containerHeight);

  /**
   * 依存を空にして identity を固定する (アンマウント時の後始末がこれに乗っている)。未指定は変数を
   * 消す (`auto` を入れると CSS の `max-height` が `auto` になり上限が消える)。
   */
  const preview = useCallback(
    (next: number | null) => {
      const container = containerRef.current;
      if (!container) return;
      if (next === null) container.style.removeProperty("--file-tree-height");
      else container.style.setProperty("--file-tree-height", `${next}px`);
    },
    [containerRef],
  );

  const commit = useCallback((next: number) => {
    setRequested(next);
    fileTreeHeightStore.write(next);
  }, []);

  const reset = useCallback(() => {
    setRequested(null);
    fileTreeHeightStore.write(null);
  }, []);

  return {
    height,
    min: bounds?.min ?? FILE_TREE_HEIGHT_MIN,
    max: bounds?.max ?? FILE_TREE_HEIGHT_DEFAULT_MAX,
    resizable: canResizeFileTreeHeight(bounds),
    limit: fileTreeHeightLimit(containerHeight),
    preview,
    commit,
    reset,
  };
}
