import { useCallback, useEffect, useState } from "react";
import { ChatArea } from "./components/ChatArea";
import { CompactBar } from "./components/CompactBar";
import { Composer } from "./components/Composer";
import { FileTreeScreen } from "./components/FileTreeScreen";
import { ManagerScreen } from "./components/ManagerScreen";
import { NavSheet } from "./components/NavSheet";
import { ProjectDialog } from "./components/ProjectDialog";
import { Sidebar, type SettingsSection, type SidebarMode } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useAgentDesk } from "./hooks/useAgentDesk";
import { useLayoutMode } from "./hooks/useLayoutMode";

export default function App() {
  const desk = useAgentDesk();
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  const [managerOpen, setManagerOpen] = useState(false);
  /** ManagerScreen を開くときのタブ (設定ナビの項目と合わせる) */
  const [managerSection, setManagerSection] = useState<"agent" | "skill">("agent");
  const [filesOpen, setFilesOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  /** nav: プロジェクト階層 / settings: 設定ナビ。drawer を閉じても保つ */
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("nav");
  // ManagerScreen の dialog close / 戻るボタンへ渡す安定参照
  const closeManager = useCallback(() => setManagerOpen(false), []);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeProjectDialog = useCallback(() => setProjectDialogOpen(false), []);

  // 回転やウィンドウ拡大で desktop shell に戻ったら、ドロワーは畳む
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  const handleSend = useCallback(
    (text: string) => {
      void desk.sendMessage(text);
    },
    [desk],
  );

  const handleStop = useCallback(() => {
    void desk.stopAgent();
  }, [desk]);

  // エージェントの切替は「新しい会話」と同じで、現在の会話はセッション一覧に残す
  const handleAgentChange = useCallback(
    (agentId: string) => {
      desk.newChat(agentId);
    },
    [desk],
  );

  const refreshCatalog = useCallback(async () => {
    const catalog = await desk.loadCatalog();
    void desk.refreshSessions();
    return catalog;
  }, [desk]);

  // --- nav (sidebar / drawer) ---

  const closeNav = useCallback(() => setNavOpen(false), []);

  /** settings モードの項目。ページ化はせず、既存の full screen dialog を開く */
  const openSettingsSection = useCallback((section: SettingsSection) => {
    if (section === "files") {
      setFilesOpen(true);
      return;
    }
    setManagerSection(section === "skills" ? "skill" : "agent");
    setManagerOpen(true);
  }, []);

  const navProps = {
    mode: sidebarMode,
    onSelectMode: setSidebarMode,
    sessions: desk.sessions,
    sessionId: desk.sessionId,
    projects: desk.projects,
    selectedProjectId: desk.selectedProjectId,
    newChat: desk.newChat,
    selectSession: (sessionId: string) => {
      if (sessionId !== desk.sessionId) void desk.selectSession(sessionId);
    },
    deleteSession: (sessionId: string) => {
      void desk.deleteSession(sessionId);
    },
    selectProject: desk.selectProject,
    deleteProject: (projectId: string) => {
      void desk.deleteProject(projectId);
    },
    onNewProject: () => setProjectDialogOpen(true),
    onOpenSettingsSection: openSettingsSection,
  };

  // ドロワーは選んだら閉じる。削除だけは confirm の後も開いたまま残す (連続操作しうる)
  const drawerProps = {
    ...navProps,
    // モードの切替は閉じない (設定ナビは drawer の中で出す)
    newChat: (agentId?: string, projectId?: string) => {
      closeNav();
      desk.newChat(agentId, projectId);
    },
    selectSession: (sessionId: string) => {
      closeNav();
      if (sessionId !== desk.sessionId) void desk.selectSession(sessionId);
    },
    onNewProject: () => {
      closeNav();
      setProjectDialogOpen(true);
    },
    onOpenSettingsSection: (section: SettingsSection) => {
      closeNav();
      openSettingsSection(section);
    },
  };

  const activeSession = desk.sessions.find((item) => item.sessionId === desk.sessionId);
  // ファイル画面へ渡す作業ディレクトリ。作成済みはセッションの実効 cwd、
  // 未作成チャットは選択中プロジェクト、未所属はワークスペース root (health.cwd)
  const filesCwd = desk.sessionId ? desk.cwd : desk.selectedProject?.cwd || desk.cwd;
  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = desk.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || desk.selectedAgent?.name;

  return (
    <div
      className={[
        "grid h-dvh min-h-0 bg-base text-ink",
        // compact は main だけが子なので 1 行。desktop は sidebar + main の 2 カラム
        compact ? "grid-rows-[minmax(0,1fr)]" : "grid-cols-[252px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
      ].join(" ")}
    >
      {compact ? null : <Sidebar {...navProps} />}
      <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        {compactMode ? (
          <CompactBar
            mode={compactMode}
            title={barTitle}
            agentName={barAgentName}
            runtimeStatus={desk.runtimeStatus}
            onOpenNav={() => setNavOpen(true)}
          />
        ) : (
          <Topbar runtimeStatus={desk.runtimeStatus} />
        )}
        <ChatArea bubbles={desk.chat.bubbles} compact={compact} suggestions={desk.selectedAgent?.suggestions} onSuggestion={handleSend} />
        <Composer
          activity={desk.chat.activity}
          runtimeReady={desk.health?.ready !== false}
          sending={desk.sending}
          stopVisible={desk.stopVisible}
          queueDepth={desk.chat.queueDepth}
          context={desk.chat.context}
          settings={desk.composerSettings}
          agents={desk.catalog.agents}
          agentId={desk.agentId}
          mode={layout}
          onSend={handleSend}
          onStop={handleStop}
          onChangeModel={desk.changeModel}
          onChangeThinkingLevel={desk.changeThinkingLevel}
          onChangeAgent={handleAgentChange}
        />
      </main>
      {compact && navOpen ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}
      {managerOpen ? (
        <ManagerScreen
          compact={compact}
          initialType={managerSection}
          onClose={closeManager}
          catalog={desk.catalog}
          agentId={desk.agentId}
          refreshCatalog={refreshCatalog}
          modelOptions={desk.health?.modelOptions ?? []}
          defaultModel={desk.health?.model}
          defaultThinkingLevel={desk.health?.defaultThinkingLevel}
        />
      ) : null}
      {projectDialogOpen ? (
        <ProjectDialog compact={compact} onClose={closeProjectDialog} onCreate={desk.createProject} />
      ) : null}
      {filesOpen ? <FileTreeScreen compact={compact} cwd={filesCwd} onClose={closeFiles} /> : null}
    </div>
  );
}
