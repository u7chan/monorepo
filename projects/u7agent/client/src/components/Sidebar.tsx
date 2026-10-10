import { useState } from "react";
import type { SidebarResize } from "../hooks/useSidebarWidth";
import type { U7Agent } from "../hooks/useU7Agent";
import { cn } from "../lib/cn";
import { type SettingsSection, type SidebarMode } from "../lib/settingsNav";
import { groupSessionsByProject } from "../lib/sessionsByProject";
import { sidebarProjectsStore } from "../lib/sidebarProjects";
import { sidebarSectionsStore, type SidebarSectionId } from "../lib/sidebarSections";
import { CloseIcon, DisclosureChevronIcon, GearIcon, LogoStarIcon, PlusIcon } from "./icons";
import { MenuItem } from "./MenuItem";
import { ProjectRow } from "./sidebar/ProjectRow";
import { SessionList } from "./sidebar/SessionList";
import { SidebarResizeHandle } from "./sidebar/SidebarResizeHandle";
import { SettingsNav } from "./sidebar/SettingsNav";

export type SidebarProps = Omit<
  Pick<
    U7Agent,
    | "sessions"
    | "sessionId"
    | "agents"
    | "projects"
    | "newChat"
    | "selectSession"
    | "renameSession"
    | "moveSession"
    | "deleteSession"
    | "deleteProject"
    | "togglePinned"
  >,
  "newChat" | "selectSession" | "renameSession" | "moveSession" | "deleteSession" | "deleteProject" | "togglePinned"
> & {
  spaceName?: string;
  pinError?: string;
  conversationOnly?: boolean;
  mode: SidebarMode;
  onSelectMode: (mode: SidebarMode) => void;
  activeSettingsSection: SettingsSection;
  /** 直近の通知の送信が失敗しているか (設定ナビの ⚠)。設定ページを開いていなくても要る */
  notificationsFailed: boolean;
  newChat: (agentId?: string, projectId?: string) => void;
  selectSession: (sessionId: string) => void;
  renameSession: (sessionId: string) => void;
  moveSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  deleteProject: (projectId: string) => void;
  togglePinned: (sessionId: string) => void;
  onNewProject: () => void;
  onOpenSettingsSection: (section: SettingsSection) => void;
  /** sheet variant のときだけ使う (モバイルのドロワーを閉じる) */
  onClose?: () => void;
  variant?: "sidebar" | "sheet";
  /** 幅の操作。docked の面だけが受け取り、overlay のドロワー (sheet) には渡さない */
  resize?: SidebarResize;
};

export function Sidebar({
  mode,
  onSelectMode,
  activeSettingsSection,
  notificationsFailed,
  onNewProject,
  onOpenSettingsSection,
  onClose,
  variant = "sidebar",
  resize,
  spaceName,
  pinError,
  conversationOnly = false,
  ...props
}: SidebarProps) {
  const sheet = variant === "sheet";
  const {
    sessions,
    sessionId,
    agents,
    projects,
    newChat,
    selectSession,
    renameSession,
    moveSession,
    deleteSession,
    deleteProject,
    togglePinned,
  } = props;
  // 既定は畳み (保存値が無ければ空 = 全行 closed)。書き込みは Effect ではなくクリック時に済ませる
  const [expanded, setExpanded] = useState<string[]>(() => sidebarProjectsStore.read());
  const [expandedSections, setExpandedSections] = useState<SidebarSectionId[]>(() => sidebarSectionsStore.read());
  const { groups, unassigned } = groupSessionsByProject(sessions, projects);

  /** 展開の集合を差し替えて保存する (末尾 = 今回開いた cwd) */
  const setProjectOpen = (cwd: string, open: boolean) => {
    const next = expanded.filter((item) => item !== cwd);
    if (open) next.push(cwd);
    setExpanded(next);
    sidebarProjectsStore.write(next);
  };

  const setSectionOpen = (section: SidebarSectionId, open: boolean) => {
    const next = expandedSections.filter((item) => item !== section);
    if (open) next.push(section);
    setExpandedSections(next);
    sidebarSectionsStore.write(next);
  };

  const projectsOpen = expandedSections.includes("projects");
  const unassignedOpen = expandedSections.includes("unassigned");

  return (
    <aside
      // docked と sheet は App が排他で描く (同時に立たない)。data-nav-root は NavSheet の focus 復帰が
      // docked 側を選ぶための印で、開閉 state を mount 時に読むこの形は排他が前提 (崩れると片側に反映されない)
      data-nav-root={sheet ? "sheet" : "docked"}
      className={cn(
        // relative は幅のハンドル (absolute inset-y-0 right-0) の基準。docked は <aside> 自身が
        // スクロールしない (一覧が flex-1 で吸収する) ので、ハンドルがスクロールで動くことはない
        "relative flex h-full min-h-0 flex-col gap-3.5 bg-panel px-3 py-4",
        // 高さが足りない compact でも全項目へ到達できるよう、drawer 全体も 1 つのスクロール領域にする
        "scrollbar-thin overflow-y-auto",
        // docked は一覧が flex-1 で高さを吸収するので、<aside> 自身のガターは実際にスクロールする sheet だけに確保する
        sheet ? "scrollbar-stable" : null,
        sheet ? null : "border-r border-line",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent-wash text-accent-strong">
          <LogoStarIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink-strong">u7agent</div>
          <div className="text-2xs text-ink-faint">local workspace</div>
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

      {spaceName ? (
        <div className="truncate px-2 text-xs text-ink-soft" title={spaceName}>
          スペース: {spaceName}
        </div>
      ) : null}
      {mode === "settings" ? (
        <SettingsNav
          activeSettingsSection={activeSettingsSection}
          notificationsFailed={notificationsFailed}
          onSelectMode={onSelectMode}
          onOpenSettingsSection={onOpenSettingsSection}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => newChat()}
            className="flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-raised text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent-text"
          >
            {/* 文字の「＋」は端末のフォントで字形と大きさが変わるため、他の追加ボタンと同じ PlusIcon で描く */}
            <span className="text-accent-text">
              <PlusIcon />
            </span>
            <span>新しい会話</span>
          </button>

          <div className="scrollbar-stable grid min-h-0 flex-1 scrollbar-thin content-start gap-4 overflow-y-auto pr-0.5">
            {!conversationOnly ? (
              <section className="grid">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-expanded={projectsOpen}
                    aria-controls="sidebar-projects-content"
                    onClick={() => setSectionOpen("projects", !projectsOpen)}
                    className="sidebar-category-toggle flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
                  >
                    <DisclosureChevronIcon />
                    <span className="truncate text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                      Projects
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSectionOpen("projects", true);
                      onNewProject();
                    }}
                    className="inline-flex min-h-7 items-center gap-1 rounded-lg border border-dashed border-line px-2 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                  >
                    <PlusIcon />
                    New Project
                  </button>
                </div>
                <div id="sidebar-projects-content" className="tree-fold" data-open={projectsOpen} inert={!projectsOpen}>
                  <div>
                    <div className="sidebar-category-content mt-2 grid gap-2">
                      {groups.length === 0 ? (
                        <div className="rounded-lg px-1 py-1 text-1xs text-ink-faint">プロジェクトはまだありません</div>
                      ) : (
                        <div className="grid gap-1.5">
                          {groups.map((group) => (
                            <ProjectRow
                              key={group.project.id}
                              project={group.project}
                              sessions={group.sessions}
                              agents={agents}
                              sessionId={sessionId}
                              open={expanded.includes(group.project.cwd)}
                              onToggle={() => setProjectOpen(group.project.cwd, !expanded.includes(group.project.cwd))}
                              onNewChat={() => {
                                setProjectOpen(group.project.cwd, true);
                                newChat(undefined, group.project.id);
                              }}
                              onDelete={() => deleteProject(group.project.id)}
                              onSelectSession={selectSession}
                              onRenameSession={renameSession}
                              onDeleteSession={deleteSession}
                              onTogglePinnedSession={togglePinned}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="grid">
              <button
                type="button"
                aria-expanded={unassignedOpen}
                aria-controls="sidebar-unassigned-content"
                onClick={() => setSectionOpen("unassigned", !unassignedOpen)}
                className="sidebar-category-toggle flex min-h-8.5 min-w-0 items-center gap-2 rounded-md px-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
              >
                <DisclosureChevronIcon />
                <span className="shrink-0 text-2xs font-semibold tracking-widest text-ink-faint uppercase">Chats</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-ghost">
                  {conversationOnly ? "会話" : "未所属"}
                </span>
              </button>
              <div
                id="sidebar-unassigned-content"
                className="tree-fold"
                data-open={unassignedOpen}
                inert={!unassignedOpen}
              >
                <div>
                  <div className="sidebar-category-content mt-2 grid gap-2">
                    {unassigned.length === 0 ? (
                      <div className="rounded-lg px-1 py-1 text-1xs text-ink-faint">
                        {conversationOnly ? "会話はまだありません" : "未所属のセッションはありません"}
                      </div>
                    ) : (
                      <SessionList
                        sessions={unassigned}
                        agents={agents}
                        sessionId={sessionId}
                        onSelect={selectSession}
                        onRename={renameSession}
                        onDelete={deleteSession}
                        onTogglePin={togglePinned}
                        onMove={moveSession}
                      />
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </>
      )}

      <div className="mt-auto grid gap-2">
        {pinError ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-raised px-2.5 py-2 text-2xs leading-relaxed text-danger-text"
          >
            {pinError}
          </p>
        ) : null}
        <div className="text-2xs leading-relaxed text-ink-ghost">ローカル実行 · セッションはサーバーに保存</div>
        {mode === "nav" ? (
          <MenuItem variant="nav" icon={<GearIcon />} label="設定" onClick={() => onSelectMode("settings")} />
        ) : null}
      </div>

      {resize ? <SidebarResizeHandle {...resize} /> : null}
    </aside>
  );
}
