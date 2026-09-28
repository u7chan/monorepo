import { cn } from "../../lib/cn";

/**
 * 現在有効なコンテキストの開始位置。要約で置き換わった範囲 (薄暗い表示) との境界を、
 * 色だけに依存せず 1 行のラベルで示す。位置はサーバーの履歴投影 (activeContextStartId) が正。
 */
export function ContextBoundary({ compact }: { compact: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-2xs text-accent-text", compact ? "py-0.5" : "py-1")}>
      <span className="h-px min-w-0 flex-1 bg-accent/40" />
      <span className="shrink-0">ここから現在の有効な会話</span>
      <span className="h-px min-w-0 flex-1 bg-accent/40" />
    </div>
  );
}
