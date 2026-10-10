import { projectRowActions, type ProjectRowKind } from "../../lib/sidebarRowMenu";
import type { AgentDef, Project, SessionSummary } from "../../types";
import { FolderIcon } from "../icons";
import { RowMenu } from "../RowMenu";
import { SessionList } from "./SessionList";

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
  onRenameSession,
  onDeleteSession,
  onTogglePinnedSession,
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
  onRenameSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinnedSession: (sessionId: string) => void;
}) {
  // kind から行の props を引く表。actions と同じ種別に狭め、表の無い kind を型で検出する
  const handlers: Record<ProjectRowKind, () => void> = { "new-chat": onNewChat, delete: onDelete };

  return (
    <div>
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
      {/* 開閉は高さの遷移で見せる (styles/index.css の .tree-fold)。入れ物は開く前から置くので、
          初めて開くプロジェクトも 0fr から伸びる。行の間隔 (mt-1) も遷移の内側に置く: 外側の gap は
          畳んだ入れ物 (高さ 0) にも空く。閉じている間は inert にして、見えない行をフォーカスと読み上げの
          対象に残さない (FileBrowser の枝と同じ) */}
      <div className="tree-fold ml-3" data-open={open} inert={!open}>
        <div>
          <div className="project-fold-rows mt-1 grid gap-1 border-l border-line pl-1.5">
            {sessions.length === 0 ? (
              <div className="py-1 pl-0.5 text-1xs text-ink-faint">セッションはありません</div>
            ) : (
              <SessionList
                sessions={sessions}
                agents={agents}
                sessionId={sessionId}
                onSelect={onSelectSession}
                onRename={onRenameSession}
                onDelete={onDeleteSession}
                onTogglePin={onTogglePinnedSession}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
