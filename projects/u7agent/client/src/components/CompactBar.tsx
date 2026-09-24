import type { RuntimeStatus } from "../hooks/runtimeStatus";
import { cn } from "../lib/cn";
import type { LayoutMode } from "../lib/layout";
import { BellIcon, FolderIcon, MenuIcon } from "./icons";
import { NotifyNote } from "./NotifyNote";
import { RuntimeAlert } from "./RuntimeAlert";

export type CompactBarProps = {
  mode: Exclude<LayoutMode, "desktop">;
  title: string;
  agentName?: string;
  runtimeStatus: RuntimeStatus;
  /**
   * 会話の通知トグル。deliverable は今の On が実際に送られるか (色とラベルの根拠)。
   * note は配信できない理由で、On の間は常に、Off では押した後に出る
   */
  notify: { on: boolean; note?: string; deliverable: boolean; onToggle: () => void; onOpenSettings?: () => void };
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
  // 配信できない On は、押しても切り替わらない理由を読み上げ名と title でも示す (色だけに頼らない)
  const notifyLabel = notify.on && !notify.deliverable ? "通知（停止中）" : "通知";

  return (
    <header className="grid min-w-0 grid-cols-1 border-b border-line bg-panel/85">
      <div className={cn("flex min-w-0 items-center gap-2.5 px-3", landscape ? "py-0.5" : "py-2")}>
        <button type="button" onClick={onOpenNav} aria-label="ナビゲーションを開く" className="icon-button">
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
          aria-label={notifyLabel}
          title={notifyLabel}
          className={cn("icon-button", notify.on && notify.deliverable && "border-accent/50 text-accent-text")}
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
            className={cn("icon-button", sessionFiles.open && "border-accent/50 text-accent-text")}
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
        <NotifyNote text={notify.note} onOpenSettings={notify.onOpenSettings} className="mx-3 mb-2" />
      ) : null}
    </header>
  );
}
