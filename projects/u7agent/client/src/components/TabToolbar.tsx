import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type TabToolbarProps = {
  /** 左スロット (パス等の文脈)。出せない面では空のまま置き、説明文で埋めない */
  context?: ReactNode;
  /** 右スロット (面の操作) */
  actions?: ReactNode;
  /** layout (位置・幅・伸縮) だけを渡す。余白はこの行が持つ */
  className?: string;
};

/**
 * 面 (タブ) のツールバー。タブ行のすぐ下の行として、左に文脈を、右に操作を出す。
 * 余白と区切り線はこの行が持ち、呼び出し側の className は layout (位置・幅・伸縮) だけにする。
 */
export function TabToolbar({ context, actions, className }: TabToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-4 py-2",
        className,
      )}
    >
      {/* 左スロットは行を縮める (min-w-0)。縮めないと nowrap の長いパスが行の最小幅になり、
          切り詰めが子の truncate まで降りず、右の操作が容器の外へ出る */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">{context}</div>
      {/* 操作は縮めない (狭い面でラベルが数文字まで潰れると何のボタンか読めない) */}
      <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}
