import { cn } from "../../lib/cn";
import { ArrowDownIcon } from "../icons";

export type ScrollToBottomButtonProps = {
  onClick: () => void;
  /** 浮かせる位置 (layout)。見た目はこのコンポーネントが持つ (shadcn/no-restyle) */
  className?: string;
};

/** 追従が外れているときだけ出す「最新のメッセージへ移動」ボタン */
export function ScrollToBottomButton({ onClick, className }: ScrollToBottomButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="最新のメッセージへ移動"
      className={cn(
        "grid size-9 place-items-center rounded-full border border-line bg-raised text-ink-soft shadow-md transition-colors hover:border-accent/50 hover:text-accent-text",
        className,
      )}
    >
      <ArrowDownIcon />
    </button>
  );
}
