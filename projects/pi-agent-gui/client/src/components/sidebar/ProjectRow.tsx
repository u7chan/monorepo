import type { ReactNode } from "react";
import type { Project, SessionSummary } from "../../types";
import { ChevronIcon, FolderIcon, PlusIcon, TrashIcon } from "../icons";
import { SessionRow } from "./SessionRow";

/** プロジェクト行の右端の操作 (行の選択とは別のクリック領域にする) */
function RowAction({
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
      className={[
        "grid size-7 shrink-0 place-items-center rounded-md text-ink-ghost transition-colors hover:bg-hover",
        danger ? "hover:text-danger" : "hover:text-accent-text",
        hoverOnly ? "can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100" : null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}

export function ProjectRow({
  project,
  sessions,
  sessionId,
  selected,
  open,
  onSelect,
  onToggle,
  onNewChat,
  onDelete,
  onSelectSession,
  onDeleteSession,
}: {
  project: Project;
  sessions: SessionSummary[];
  sessionId: string;
  selected: boolean;
  open: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onNewChat: () => void;
  onDelete: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  return (
    <div className="grid gap-1">
      {/* 行の選択 (作成先) は弱いハイライトに留め、開いているセッションの行と区別する */}
      <div
        className={[
          "group flex min-h-10.5 items-center gap-1 rounded-lg border pr-1.5 transition-colors",
          selected ? "border-accent/25 bg-accent-wash/60" : "border-transparent hover:bg-hover",
        ].join(" ")}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <span className="shrink-0 text-ink-faint">
            <FolderIcon />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <strong className="truncate text-xs text-ink">{project.name}</strong>
            <small className="truncate text-2xs text-ink-muted">{project.cwd}</small>
          </span>
        </button>
        <RowAction label={open ? "折りたたむ" : "展開する"} onClick={onToggle}>
          <span className={["block transition-transform", open ? "rotate-90" : ""].join(" ")}>
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
