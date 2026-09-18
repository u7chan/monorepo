import { useCallback, useEffect, useState } from "react";
import { AgentSettingsPage } from "./components/AgentSettingsPage";
import { AppearancePage } from "./components/AppearancePage";
import { BackupPage } from "./components/BackupPage";
import { ChatArea } from "./components/ChatArea";
import { CompactBar } from "./components/CompactBar";
import { Composer } from "./components/Composer";
import { FileTreePage } from "./components/FileTreePage";
import { NavSheet } from "./components/NavSheet";
import { ProjectDialog } from "./components/ProjectDialog";
import { Sidebar } from "./components/Sidebar";
import { SessionFilesPanel } from "./components/SessionFilesPanel";
import { SkillSettingsPage } from "./components/SkillSettingsPage";
import { Topbar } from "./components/Topbar";
import { useAgentDesk } from "./hooks/useAgentDesk";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useRoute } from "./hooks/useRoute";
import { cn } from "./lib/cn";
import { sessionFilesRoot } from "./lib/sessionFiles";
import { type SettingsSection, type SidebarMode } from "./lib/settingsNav";

export default function App() {
  const desk = useAgentDesk();
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // 右パネルの開閉は保存しない (起動時は閉。URL や localStorage に載せない)
  const [sessionFilesOpen, setSessionFilesOpen] = useState(false);
  // 画面は URL がただ 1 つの正。`/` はチャット、`/settings/<section>` は設定 5 画面 (lib/route.ts)
  const { route, navigate, lastSettingsSection } = useRoute();
  const mainView = route.view;
  const sidebarMode: SidebarMode = route.view === "settings" ? "settings" : "nav";
  // URL にセクションが無いときだけ「最後に開いていたセクション」を見せる (URL の指定を上書きしない)
  const settingsSection: SettingsSection = route.view === "settings" ? route.section : lastSettingsSection;
  const closeProjectDialog = useCallback(() => setProjectDialogOpen(false), []);
  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const backToChat = useCallback(() => navigate({ view: "chat" }), [navigate]);
  const toggleSessionFiles = useCallback(() => setSessionFilesOpen((open) => !open), []);
  const closeSessionFiles = useCallback(() => setSessionFilesOpen(false), []);

  // 回転やウィンドウ拡大で desktop shell に戻ったら、ドロワーは畳む
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  // 設定ページは dialog ではないため、showModal() が担っていた Escape を自前で受ける。
  // ドロワーが開いているときは Escape をドロワーの close に任せる (モードは保つ)
  useEffect(() => {
    if (mainView !== "settings" || navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      backToChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mainView, navOpen, backToChat]);

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

  // Sidebar の「設定」は onSelectMode("settings") を呼ぶため、モード切替も URL へ集約する
  const selectMode = useCallback(
    (mode: SidebarMode) => {
      navigate(mode === "settings" ? { view: "settings", section: lastSettingsSection } : { view: "chat" });
    },
    [navigate, lastSettingsSection],
  );

  const openSettingsSection = useCallback(
    (section: SettingsSection) => {
      navigate({ view: "settings", section });
    },
    [navigate],
  );

  const navProps = {
    mode: sidebarMode,
    onSelectMode: selectMode,
    activeSettingsSection: settingsSection,
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

  // ドロワーは選んだら閉じる。削除だけは confirm の後も開いたまま残す (連続操作しうる)。
  // 折りたたみ chevron は選択ではないので閉じない (Sidebar 側で行を選択しない)
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
    selectProject: (projectId: string) => {
      closeNav();
      desk.selectProject(projectId);
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

  // 右パネルは選択中セッションの作業フォルダ (payload.cwd) を root にする。設定 → ファイル はワークスペース root
  // 固定なので、同じ FileBrowser を別の root で使い分ける (root が "" のときは出さない)
  const filesRoot = sessionFilesRoot({ desktop: layout === "desktop", chatView: mainView === "chat", cwd: desk.cwd });
  const filesPanelOpen = filesRoot !== "" && sessionFilesOpen;

  const activeSession = desk.sessions.find((item) => item.sessionId === desk.sessionId);
  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = desk.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || desk.selectedAgent?.name;

  // 設定ページは main を丸ごと使う (チャットとは排他)。compact ではヘッダが CompactBar の代わりになるため、
  // 設定ページ間を移るための nav の導線をページへ渡す
  const pageProps = { compact, onBack: backToChat, onOpenNav: compact ? openNav : undefined };

  return (
    <div
      className={cn(
        "grid h-dvh min-h-0 bg-base text-ink",
        compact ? "grid-rows-1" : "grid-cols-[252px_minmax(0,1fr)] grid-rows-1",
      )}
    >
      {compact ? null : <Sidebar {...navProps} />}
      <main
        className={cn(
          "grid min-h-0 grid-rows-1 overflow-hidden",
          // 右パネルはシェルの 3 カラム目 (チャット列の隣)。狭い viewport では 30vw まで縮めてチャット列を残す
          filesPanelOpen && "grid-cols-[minmax(0,1fr)_min(360px,30vw)]",
        )}
      >
        <div className="grid min-h-0 grid-rows-1 overflow-hidden">
          {/* 設定ページを開いている間もチャットは mount したまま display だけ切る。
              実行中のラン (SSE)・入力中の下書き・スクロール位置を unmount で失わないため */}
          <div
            className={
              mainView === "settings" ? "hidden" : "grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
            }
          >
            {compactMode ? (
              <CompactBar
                mode={compactMode}
                title={barTitle}
                agentName={barAgentName}
                runtimeStatus={desk.runtimeStatus}
                onOpenNav={openNav}
              />
            ) : (
              <Topbar
                runtimeStatus={desk.runtimeStatus}
                sessionFiles={filesRoot ? { open: filesPanelOpen, onToggle: toggleSessionFiles } : undefined}
              />
            )}
            <ChatArea
              visible={mainView === "chat"}
              bubbles={desk.chat.bubbles}
              compactions={desk.chat.compactions}
              compact={compact}
              suggestions={desk.selectedAgent?.suggestions}
              onSuggestion={handleSend}
            />
            <Composer
              visible={mainView === "chat"}
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
          </div>
          {mainView === "settings" ? (
            settingsSection === "agents" ? (
              <AgentSettingsPage
                {...pageProps}
                catalog={desk.catalog}
                agentId={desk.agentId}
                refreshCatalog={refreshCatalog}
                modelOptions={desk.health?.modelOptions ?? []}
                defaultModel={desk.health?.model}
                defaultThinkingLevel={desk.health?.defaultThinkingLevel}
              />
            ) : settingsSection === "skills" ? (
              <SkillSettingsPage {...pageProps} catalog={desk.catalog} refreshCatalog={refreshCatalog} />
            ) : settingsSection === "files" ? (
              // root を選択中の session / project に追随させると、選択を変えると同じ画面が別の場所を指して分かりにくい。
              // 設定のファイルはワークスペース全体に固定し、セッションの作業フォルダはツリーから辿って開く
              <FileTreePage {...pageProps} cwd="" />
            ) : settingsSection === "backup" ? (
              <BackupPage
                {...pageProps}
                catalog={desk.catalog}
                projects={desk.projects}
                sessions={desk.sessions}
                refreshCatalog={refreshCatalog}
              />
            ) : (
              <AppearancePage {...pageProps} />
            )
          ) : null}
        </div>
        {filesPanelOpen ? (
          <SessionFilesPanel
            key={filesRoot}
            root={filesRoot}
            runEndSeq={desk.chat.runEndSeq}
            onClose={closeSessionFiles}
          />
        ) : null}
      </main>
      {compact && navOpen ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}
      {projectDialogOpen ? (
        <ProjectDialog compact={compact} onClose={closeProjectDialog} onCreate={desk.createProject} />
      ) : null}
    </div>
  );
}
