import { useState, type ReactNode } from "react";
import type { AgentDesk } from "../hooks/useAgentDesk";
import { SETTINGS_SECTIONS, type SettingsSection, type SidebarMode } from "../lib/settingsNav";
import { groupSessionsByProject } from "../lib/sessionsByProject";
import { messageTimeLabel } from "../lib/messageTime";
import type { Project, SessionSummary } from "../types";
import { ArrowLeftIcon, ChevronIcon, CloseIcon, FolderIcon, PlusIcon, TrashIcon } from "./icons";

const STATUS_LABELS: Record<string, string> = {
  running: "実行中",
  queued: "キュー待ち",
  completed: "完了",
  stopped: "停止",
  error: "エラー",
  idle: "",
};

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "dot dot-accent dot-pulse";
    case "queued":
    case "stopped":
      return "dot dot-warn";
    case "error":
      return "dot dot-danger";
    case "completed":
      return "dot dot-ok";
    default:
      return "dot dot-idle";
  }
}

function SessionRow({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: SessionSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const bits = [
    item.agentName,
    // 同じ表記をセッション一覧にも使う (locale 依存の toLocaleTimeString をやめる)
    messageTimeLabel(item.lastUsedAt),
    STATUS_LABELS[item.status],
    item.queueDepth > 0 ? `待機${item.queueDepth}件` : "",
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        "min-h-[42px]",
        active ? "border border-accent/35 bg-accent-wash" : "border border-transparent bg-soft hover:bg-hover",
      ].join(" ")}
    >
      <span className={statusDotClass(item.status)} aria-hidden />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="truncate text-xs text-ink">{item.title || "無題のセッション"}</strong>
        <small className="truncate text-[10px] text-ink-muted">{bits.join(" · ")}</small>
      </span>
      <span
        role="button"
        tabIndex={0}
        title="セッションを削除"
        aria-label="セッションを削除"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
            onDelete();
          }
        }}
        // タッチ端末では常時表示する (ChatArea のコピーボタンと同じ can-hover の使い方)
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-[13px] leading-none text-ink-ghost transition-colors group-hover:text-danger hover:bg-danger/20 hover:text-danger can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
      >
        ×
      </span>
    </button>
  );
}

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

function ProjectRow({
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
          "group flex min-h-[42px] items-center gap-1 rounded-lg border pr-1.5 transition-colors",
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
            <small className="truncate text-[10px] text-ink-muted">{project.cwd}</small>
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
          <div className="ml-3 border-l border-line pl-2 py-1 text-[11px] text-ink-faint">セッションはありません</div>
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

export type SidebarProps = Omit<
  Pick<
    AgentDesk,
    | "sessions"
    | "sessionId"
    | "projects"
    | "selectedProjectId"
    | "selectProject"
    | "newChat"
    | "selectSession"
    | "deleteSession"
    | "deleteProject"
  >,
  "newChat" | "selectSession" | "deleteSession" | "deleteProject"
> & {
  /** nav: プロジェクト階層 / settings: 設定ナビ。App が持ち、drawer を閉じても保たれる */
  mode: SidebarMode;
  onSelectMode: (mode: SidebarMode) => void;
  /** settings モードでメイン領域に出ているページ (項目のハイライトに使う) */
  activeSettingsSection: SettingsSection;
  /** 選択中プロジェクト配下に新しい会話を作る (未所属を選んでいれば未所属) */
  newChat: (agentId?: string, projectId?: string) => void;
  selectSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  deleteProject: (projectId: string) => void;
  /** プロジェクト追加の dialog を開く */
  onNewProject: () => void;
  /** settings モードの項目。メイン領域のページを切り替える */
  onOpenSettingsSection: (section: SettingsSection) => void;
  /** sheet variant のときだけ使う (モバイルのドロワーを閉じる) */
  onClose?: () => void;
  /** sidebar: desktop の左カラム / sheet: モバイルのドロワー内 */
  variant?: "sidebar" | "sheet";
};

export function Sidebar({
  mode,
  onSelectMode,
  activeSettingsSection,
  onNewProject,
  onOpenSettingsSection,
  onClose,
  variant = "sidebar",
  ...props
}: SidebarProps) {
  const sheet = variant === "sheet";
  const { sessions, sessionId, projects, selectedProjectId, selectProject, newChat, selectSession, deleteSession, deleteProject } =
    props;
  /** 折りたたんだプロジェクト (既定は展開)。drawer を閉じると消えるが、desktop では保たれる */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { groups, unassigned } = groupSessionsByProject(sessions, projects);

  return (
    <aside
      className={[
        "flex h-full min-h-0 flex-col gap-3.5 bg-panel px-3 py-4",
        // 高さが足りない compact でも全項目へ到達できるよう、drawer 全体も 1 つのスクロール領域にする
        "overflow-y-auto",
        sheet ? null : "border-r border-line",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* ブランド */}
      <div className="flex items-center gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent-wash text-sm text-accent-strong">
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink-strong">agent desk</div>
          <div className="text-[10px] text-ink-faint">local workspace</div>
        </div>
        {sheet && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="ナビゲーションを閉じる"
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>

      {mode === "settings" ? (
        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-2 overflow-y-auto pr-0.5">
          <button
            type="button"
            onClick={() => onSelectMode("nav")}
            className="flex min-h-10 w-full items-center gap-1.5 rounded-lg border border-line px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
          >
            <ArrowLeftIcon />
            アプリに戻る
          </button>
          <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-ink-faint">設定</div>
          {SETTINGS_SECTIONS.map((item) => {
            const active = item.section === activeSettingsSection;
            return (
              <button
                key={item.section}
                type="button"
                // 押すとメイン領域のページが切り替わる。開いているページを他と区別する
                aria-current={active ? "page" : undefined}
                onClick={() => onOpenSettingsSection(item.section)}
                className={[
                  "flex min-h-10 w-full items-center gap-2 rounded-lg border px-3 text-xs transition-colors",
                  active
                    ? "border-accent/35 bg-accent-wash text-accent-text"
                    : "border-line bg-soft text-ink hover:border-accent/50 hover:bg-hover hover:text-accent-text",
                ].join(" ")}
              >
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                <span className="text-ink-faint">
                  <ChevronIcon />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {/* 新しい会話 */}
          <button
            type="button"
            onClick={() => newChat()}
            className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-raised text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent-text"
          >
            <span className="text-[18px] leading-3 text-accent-text">＋</span> 新しい会話
          </button>

          {/* プロジェクト階層と未所属チャット。まとめて 1 つのスクロール領域にし、設定を下部に固定する */}
          <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-4 overflow-y-auto pr-0.5">
            <section className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">Projects</div>
                <button
                  type="button"
                  onClick={onNewProject}
                  className="inline-flex min-h-7 items-center gap-1 rounded-lg border border-dashed border-line px-2 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                >
                  <PlusIcon />
                  New Project
                </button>
              </div>
              {groups.length === 0 ? (
                <div className="rounded-lg px-1 py-1 text-[11px] text-ink-faint">プロジェクトはまだありません</div>
              ) : (
                <div className="grid gap-1.5">
                  {groups.map((group) => (
                    <ProjectRow
                      key={group.project.id}
                      project={group.project}
                      sessions={group.sessions}
                      sessionId={sessionId}
                      selected={group.project.id === selectedProjectId}
                      open={!collapsed[group.project.id]}
                      onSelect={() => selectProject(group.project.id)}
                      onToggle={() => setCollapsed((prev) => ({ ...prev, [group.project.id]: !prev[group.project.id] }))}
                      onNewChat={() => newChat(undefined, group.project.id)}
                      onDelete={() => deleteProject(group.project.id)}
                      onSelectSession={selectSession}
                      onDeleteSession={deleteSession}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* 未所属セッションは常時展開 (0 件でも見出しとプレースホルダを出す)。
                見出し自体を押せるようにし、「新しい会話」の作成先を未所属へ戻せるようにする (他の戻し方が無い) */}
            <section className="grid gap-2">
              <button
                type="button"
                onClick={() => selectProject("")}
                aria-current={selectedProjectId ? undefined : "true"}
                title="未所属を「新しい会話」の作成先にする"
                className={[
                  "flex min-h-[34px] w-full items-center gap-2 rounded-lg border px-2.5 text-left transition-colors",
                  // プロジェクト行と同じ弱いハイライトで「作成先」であることを示す
                  selectedProjectId ? "border-transparent hover:bg-hover" : "border-accent/25 bg-accent-wash/60",
                ].join(" ")}
              >
                <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">Chats</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-ink-ghost">未所属</span>
              </button>
              {unassigned.length === 0 ? (
                <div className="rounded-lg px-1 py-1 text-[11px] text-ink-faint">未所属のセッションはありません</div>
              ) : (
                <div className="grid gap-1">
                  {unassigned.map((item) => (
                    <SessionRow
                      key={item.sessionId}
                      item={item}
                      active={item.sessionId === sessionId}
                      onSelect={() => selectSession(item.sessionId)}
                      onDelete={() => deleteSession(item.sessionId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {/* フットノート + 設定 */}
      <div className="mt-auto grid gap-2">
        <div className="text-[10px] leading-relaxed text-ink-ghost">ローカル実行 · インメモリセッション</div>
        {mode === "nav" ? (
          <button
            type="button"
            onClick={() => onSelectMode("settings")}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-line bg-soft px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
          >
            <span aria-hidden className="text-[13px] leading-none">
              ⚙
            </span>
            <span className="min-w-0 flex-1 truncate text-left">設定</span>
            <span className="text-ink-faint">
              <ChevronIcon />
            </span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
