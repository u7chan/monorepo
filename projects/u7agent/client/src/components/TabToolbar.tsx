import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type TabToolbarProps = {
  /** 左スロット (パス等の文脈)。出せない面では空のまま置き、説明文で埋めない */
  context?: ReactNode;
  /** 右スロット (面の操作) */
  actions?: ReactNode;
  /** singleColumn では文脈の下に操作を積む。文脈が操作に押し潰されて縦 1 列になるのを避ける */
  stack?: boolean;
  /** layout (位置・幅・伸縮) だけを渡す。余白はこの行が持つ */
  className?: string;
};

export function TabToolbar({ context, actions, stack = false, className }: TabToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-4 py-2",
        stack && "singleColumn:flex-col singleColumn:items-stretch singleColumn:gap-y-2",
        className,
      )}
    >
      {/* 左スロットは行を縮める (min-w-0)。縮めないと nowrap の長いパスが行の最小幅になり、
          切り詰めが子の truncate まで降りず、右の操作が容器の外へ出る */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">{context}</div>
      {/* 操作は縮めない (狭い面でラベルが数文字まで潰れると何のボタンか読めない) */}
      <div className={cn("ml-auto flex shrink-0 items-center gap-2", stack && "singleColumn:self-end")}>{actions}</div>
    </div>
  );
}
