import type { RuntimeStatus } from "../hooks/runtimeStatus";
import { cn } from "../lib/cn";
import type { LayoutMode } from "../lib/layout";
import { BellIcon, FolderIcon, MenuIcon } from "./icons";
import { RuntimeAlert } from "./RuntimeAlert";

export type CompactBarProps = {
  mode: Exclude<LayoutMode, "desktop">;
  title: string;
  agentName?: string;
  runtimeStatus: RuntimeStatus;
  /** 会話の通知トグル。note は On でも配信できないときに押した直後だけ出す */
  notify: { on: boolean; note?: string; onToggle: () => void };
  sessionFiles?: { open: boolean; onToggle: () => void };
  onOpenNav: () => void;
};

export function CompactBar({
  mode,
  title,
  agentName,
  runtimeStatus,
  notify,
  sessionFiles,
  onOpenNav,
}: CompactBarProps) {
  const landscape = mode === "landscape";

  return (
    <header className="grid min-w-0 grid-cols-1 border-b border-line bg-panel/85">
      <div className={cn("flex min-w-0 items-center gap-2.5 px-3", landscape ? "py-0.5" : "py-2")}>
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="ナビゲーションを開く"
          // 他の compact コントロールと同じ 36px のタップ領域を確保する
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
        >
          <MenuIcon />
        </button>
        {landscape ? (
          <span className="shrink-0 text-2xs text-ink-faint">{agentName || "エージェント未選択"}</span>
        ) : null}
        <div className="min-w-0 flex-1">
          {landscape ? null : (
            <div className="truncate text-2xs text-ink-faint">{agentName || "エージェント未選択"}</div>
          )}
          <div className={cn("truncate font-medium text-ink-strong", landscape ? "text-xs" : "text-1sm")}>{title}</div>
        </div>
        {runtimeStatus.error ? <span className="dot dot-danger shrink-0" aria-hidden /> : null}
        <button
          type="button"
          aria-pressed={notify.on}
          onClick={notify.onToggle}
          aria-label="通知"
          title="通知"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text",
            notify.on && "border-accent/50 text-accent-text",
          )}
        >
          <BellIcon ringing={notify.on} />
        </button>
        {sessionFiles ? (
          <button
            type="button"
            onClick={sessionFiles.onToggle}
            aria-label="セッションのファイル"
            title="セッションのファイル"
            aria-expanded={sessionFiles.open}
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text",
              sessionFiles.open && "border-accent/50 text-accent-text",
            )}
          >
            <FolderIcon />
          </button>
        ) : null}
      </div>
      {runtimeStatus.error ? (
        <div className="px-2.5 pb-2">
          <RuntimeAlert runtimeStatus={runtimeStatus} compact />
        </div>
      ) : null}
      {notify.note ? (
        // 配信できない状態は色ではなく文字で示す (色の意味を 1 つに保つ)
        <p role="status" className="px-3 pb-2 text-1xs leading-relaxed text-ink-soft">
          {notify.note}
        </p>
      ) : null}
    </header>
  );
}
