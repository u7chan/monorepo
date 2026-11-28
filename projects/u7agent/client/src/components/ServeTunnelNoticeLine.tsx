import { cn } from "../lib/cn";
import type { ServeTunnelNotice } from "../lib/serveTunnel";
import { CloseIcon } from "./icons";

/**
 * 共有が終わった理由の 1 行。閉じるまで残す (色ではなく文字で示し、通知の音や自動消去はしない)。
 * 入口が 2 か所あっても、閉じる操作は 1 つの通知を消す。
 */
export function ServeTunnelNoticeLine({
  notice,
  onDismiss,
  className,
}: {
  notice: ServeTunnelNotice;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn("flex min-w-0 items-start gap-1 text-1xs leading-relaxed text-ink-soft", className)}
    >
      <p className="min-w-0 flex-1 py-0.5 break-words">{notice.text}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="共有の終了の通知を閉じる"
        title="閉じる"
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:text-ink singleColumn:size-9"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
