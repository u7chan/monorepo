import { useState } from "react";
import type { AgentDesk } from "../hooks/useAgentDesk";
import { type SettingsSection, type SidebarMode } from "../lib/settingsNav";
import { groupSessionsByProject } from "../lib/sessionsByProject";
import { ChevronIcon, CloseIcon, GearIcon, PlusIcon } from "./icons";
import { ProjectRow } from "./sidebar/ProjectRow";
import { SessionRow } from "./sidebar/SessionRow";
import { SettingsNav } from "./sidebar/SettingsNav";

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
        <SettingsNav
          activeSettingsSection={activeSettingsSection}
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

            {/* 見出しを押すと「新しい会話」の作成先を未所属へ戻せる (他の戻し方が無い)。0 件でも見出しとプレースホルダを出す */}
            <section className="grid gap-2">
              <button
                type="button"
                onClick={() => selectProject("")}
                aria-current={selectedProjectId ? undefined : "true"}
                title="未所属を「新しい会話」の作成先にする"
                className={[
                  "flex min-h-[34px] w-full items-center gap-2 rounded-lg border px-2.5 text-left transition-colors",
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

      <div className="mt-auto grid gap-2">
        <div className="text-[10px] leading-relaxed text-ink-ghost">ローカル実行 · インメモリセッション</div>
        {mode === "nav" ? (
          <button
            type="button"
            onClick={() => onSelectMode("settings")}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-line bg-soft px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:bg-hover hover:text-accent-text"
          >
            <GearIcon />
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
