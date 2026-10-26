import type { SessionTitleNoticeState } from "../lib/sessionTitleNotice";
import { cn } from "../lib/cn";
import type { SessionTitleTone } from "../lib/sessionTitleStatus";
import { CheckIcon, CloseIcon, SparkleIcon, WarningIcon } from "./icons";

const TONE: Record<SessionTitleTone, string> = {
  accent: "border-accent/35 bg-accent-wash text-accent-text",
  danger: "border-danger/40 bg-raised text-danger-text",
  warn: "border-warn/40 bg-raised text-warn-text",
  muted: "border-line bg-soft text-ink-soft",
};

/**
 * AI 要約の完了 / 失敗をチャット上に 1 回だけ出す行。常設のバッジやチップではなく、
 * その場のお知らせとして「詳細」から同じダイアログを開ける。
 */
export function SessionTitleNotice({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: SessionTitleNoticeState;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role={notice.tone === "danger" ? "alert" : "status"}
      className={cn("flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2", TONE[notice.tone])}
    >
      <span className="mt-0.5 shrink-0">
        {notice.tone === "danger" ? <WarningIcon /> : notice.tone === "accent" ? <CheckIcon /> : <SparkleIcon />}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-xs font-semibold">{notice.heading}</p>
        {notice.detail ? <p className="min-w-0 truncate text-2xs opacity-90">{notice.detail}</p> : null}
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 text-2xs text-current underline underline-offset-2 hover:opacity-80"
      >
        詳細
      </button>
      <button type="button" onClick={onDismiss} aria-label="お知らせを閉じる" className="icon-button size-7">
        <CloseIcon />
      </button>
    </div>
  );
}
