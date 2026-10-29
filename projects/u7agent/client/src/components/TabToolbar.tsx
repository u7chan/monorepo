import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";

export type TabToolbarProps = {
  /** 左スロット (パス等の文脈)。出せない面では空のまま置き、説明文で埋めない */
  context?: ReactNode;
  /** 右スロット (面の操作) */
  actions?: ReactNode;
  /** singleColumn では文脈の下に操作を積む。文脈が操作に押し潰されて縦 1 列になるのを避ける */
  stack?: boolean;
  /**
   * 文脈の最小幅 (px)。パスの末尾のように縮めてはいけない部分を持つ面が実測値を渡すと、帯に収まらない
   * 幅では操作が次の段へ落ちる。min-w-0 のままだと文脈が 0 まで縮み、shrink-0 の子が操作の下や
   * overflow-hidden の外へはみ出す。100% で頭打ちにするので、窓より広い値でもはみ出さない
   */
  contextMinWidth?: number;
  /** layout (位置・幅・伸縮) だけを渡す。余白はこの行が持つ */
  className?: string;
};

export function TabToolbar({ context, actions, stack = false, contextMinWidth, className }: TabToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-4 py-2",
        stack && "singleColumn:flex-col singleColumn:items-stretch singleColumn:gap-y-2",
        className,
      )}
    >
      {/* 左スロットは行を縮める (min-w-0)。縮めないと nowrap の長いパスが行の最小幅になり、
          切り詰めが子の truncate まで降りず、右の操作が容器の外へ出る。最小幅を渡された面だけは
          代わりにその幅を確保し、入り切らない幅では操作を次の段へ落とす */}
      <div
        className={cn(
          "flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1",
          contextMinWidth === undefined ? "min-w-0" : "min-w-(--tab-toolbar-context-min-width)",
        )}
        style={
          contextMinWidth === undefined
            ? undefined
            : ({ "--tab-toolbar-context-min-width": `min(${contextMinWidth}px, 100%)` } as CSSProperties)
        }
      >
        {context}
      </div>
      {/* 操作は縮めない (狭い面でラベルが数文字まで潰れると何のボタンか読めない)。入り切らない幅では
          縮める代わりに行を分ける (はみ出すと overflow-hidden の外へ出て、押せない操作ができる) */}
      <div
        className={cn(
          "ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2",
          stack && "singleColumn:self-end",
        )}
      >
        {actions}
      </div>
    </div>
  );
}
