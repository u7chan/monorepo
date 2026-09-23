import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * サイドバーの行の右端に置く操作 (行の選択とは別のクリック領域にする)。
 * 寸法をここ 1 箇所に固定し、プロジェクト行とセッション行でボタンの位置と大きさを揃える。
 */
export function RowAction({
  label,
  onClick,
  danger = false,
  hoverOnly = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** ホバーできる端末では隠しておく (タッチ端末では常時表示) */
  hoverOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-ink-ghost transition-colors hover:bg-hover",
        danger ? "hover:text-danger" : "hover:text-accent-text",
        hoverOnly ? "focus-visible:opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100" : null,
      )}
    >
      {children}
    </button>
  );
}
