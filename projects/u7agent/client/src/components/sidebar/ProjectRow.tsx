import { projectRowActions, type ProjectRowKind } from "../../lib/sidebarRowMenu";
import type { SeenRuns } from "../../lib/sidebarStatus";
import type { AgentDef, Project, SessionSummary } from "../../types";
import { FolderIcon } from "../icons";
import { RowMenu } from "../RowMenu";
import { SessionRow } from "./SessionRow";

export function ProjectRow({
  project,
  sessions,
  agents,
  sessionId,
  seenRuns,
  open,
  onToggle,
  onNewChat,
  onDelete,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: {
  project: Project;
  sessions: SessionSummary[];
  agents: AgentDef[];
  sessionId: string;
  /** 既読の run id (会話 id -> run id)。配下の行へそのまま渡す */
  seenRuns: SeenRuns;
  open: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onDelete: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<ProjectRowKind, () => void> = { "new-chat": onNewChat, delete: onDelete };

  return (
    <div className="grid gap-1">
      {/* 行のクリックは折りたたみのトグル。選択ハイライトは持たず (作成先は ⋯ の「このプロジェクトに新しい会話」と
          追加の成功後が明示する)、開いているセッションの行だけを強調する */}
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
        <RowMenu name={project.name} actions={projectRowActions()} onSelect={(kind) => handlers[kind]()} />
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
                seenRuns={seenRuns}
                onSelect={() => onSelectSession(item.sessionId)}
                onRename={() => onRenameSession(item.sessionId)}
                onDelete={() => onDeleteSession(item.sessionId)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
