import { cn } from "../../lib/cn";
import type { AgentDef, Project, SessionSummary } from "../../types";
import { ChevronIcon, FolderIcon, PlusIcon, TrashIcon } from "../icons";
import { RowAction } from "./RowAction";
import { SessionRow } from "./SessionRow";

export function ProjectRow({
  project,
  sessions,
  agents,
  sessionId,
  open,
  onToggle,
  onNewChat,
  onDelete,
  onSelectSession,
  onDeleteSession,
}: {
  project: Project;
  sessions: SessionSummary[];
  agents: AgentDef[];
  sessionId: string;
  open: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onDelete: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  return (
    <div className="grid gap-1">
      {/* 行のクリックは折りたたみのトグル。選択ハイライトは持たず (作成先は ＋ が明示する)、
          開いているセッションの行だけを強調する */}
      <div className="group flex min-h-10.5 items-center gap-1 rounded-lg border border-transparent pr-1.5 transition-colors hover:bg-hover">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <span className="shrink-0 text-ink-faint">
            <FolderIcon open={open} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <strong className="truncate text-xs text-ink">{project.name}</strong>
            <small className="truncate text-2xs text-ink-muted">{project.cwd}</small>
          </span>
        </button>
        <RowAction label={open ? "折りたたむ" : "展開する"} onClick={onToggle}>
          <span className={cn("block transition-transform", open ? "rotate-90" : "")}>
            <ChevronIcon />
          </span>
        </RowAction>
        <RowAction label="このプロジェクトに新しい会話" onClick={onNewChat} hoverOnly>
          <PlusIcon />
        </RowAction>
        <RowAction label="プロジェクトを削除" onClick={onDelete} hoverOnly danger>
          <TrashIcon />
        </RowAction>
      </div>
      {open ? (
        sessions.length === 0 ? (
          <div className="ml-3 border-l border-line py-1 pl-2 text-1xs text-ink-faint">セッションはありません</div>
        ) : (
          <div className="ml-3 grid gap-1 border-l border-line pl-1.5">
            {sessions.map((item) => (
              <SessionRow
                key={item.sessionId}
                item={item}
                agents={agents}
                active={item.sessionId === sessionId}
                onSelect={() => onSelectSession(item.sessionId)}
                onDelete={() => onDeleteSession(item.sessionId)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
