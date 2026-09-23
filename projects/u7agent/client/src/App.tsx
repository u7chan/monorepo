import { useCallback, useEffect, useRef, useState } from "react";
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
import { SessionFilesPanel, SessionFilesSheet } from "./components/SessionFilesPanel";
import { SkillSettingsPage } from "./components/SkillSettingsPage";
import { Topbar } from "./components/Topbar";
import { FileRefProvider } from "./components/markdown/FileRefLink";
import { useU7Agent } from "./hooks/useU7Agent";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useRoute } from "./hooks/useRoute";
import { agentIconOf } from "./lib/agentIcon";
import { cn } from "./lib/cn";
import { fileRefRequestForSession } from "./lib/fileRefRequest";
import { sessionFilesRoot } from "./lib/sessionFiles";
import { type SettingsSection, type SidebarMode } from "./lib/settingsNav";

export default function App() {
  const app = useU7Agent();
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // セッションファイル UI の開閉は保存しない (desktop は右パネル、compact は全画面シート)
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
  // ファイル参照から開いたときの起点要素。compact の sheet は閉じたときにここへ focus を戻す
  const fileRefOriginRef = useRef<HTMLElement | null>(null);
  const { requestFileRef } = app;
  const openFileRef = useCallback(
    (path: string, origin: HTMLElement | null) => {
      // 起点はクリック時に自分で持つ (document.activeElement がクリックした button を指すとは限らない)
      fileRefOriginRef.current = origin;
      setSessionFilesOpen(true);
      requestFileRef(path);
    },
    [requestFileRef],
  );
  const toggleSessionFiles = useCallback(() => {
    // トグルからの開閉ではファイル参照へ focus を戻さない
    fileRefOriginRef.current = null;
    setSessionFilesOpen((open) => !open);
  }, []);
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
      void app.sendMessage(text);
    },
    [app],
  );

  const handleStop = useCallback(() => {
    void app.stopAgent();
  }, [app]);

  // エージェントの切替は「新しい会話」と同じで、現在の会話はセッション一覧に残す
  const handleAgentChange = useCallback(
    (agentId: string) => {
      app.newChat(agentId);
    },
    [app],
  );

  const refreshCatalog = useCallback(async () => {
    const catalog = await app.loadCatalog();
    void app.refreshSessions();
    return catalog;
  }, [app]);

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
    sessions: app.sessions,
    sessionId: app.sessionId,
    agents: app.agents,
    projects: app.projects,
    selectedProjectId: app.selectedProjectId,
    newChat: app.newChat,
    selectSession: (sessionId: string) => {
      if (sessionId !== app.sessionId) void app.selectSession(sessionId);
    },
    deleteSession: (sessionId: string) => {
      void app.deleteSession(sessionId);
    },
    selectProject: app.selectProject,
    deleteProject: (projectId: string) => {
      void app.deleteProject(projectId);
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
      app.newChat(agentId, projectId);
    },
    selectSession: (sessionId: string) => {
      closeNav();
      if (sessionId !== app.sessionId) void app.selectSession(sessionId);
    },
    selectProject: (projectId: string) => {
      closeNav();
      app.selectProject(projectId);
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

  // 選択中セッションの作業フォルダ (payload.cwd) を root にする。表示方法だけ layout で分ける。
  // 設定 → ファイルはワークスペース root 固定なので、セッションのファイルとは別の入口にする。
  const filesRoot = sessionFilesRoot({ chatView: mainView === "chat", cwd: app.cwd });
  const filesPanelOpen = !compact && filesRoot !== "" && sessionFilesOpen;
  const filesSheetOpen = compact && filesRoot !== "" && sessionFilesOpen;
  // 未消費の要求は選択中セッションのときだけパネルへ渡す (セッションが変われば useSessions が破棄する)
  const pendingFileRef = fileRefRequestForSession(app.fileRefRequest, app.sessionId);

  const activeSession = app.sessions.find((item) => item.sessionId === app.sessionId);
  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = app.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || app.selectedAgent?.name;
  // 吹き出しの名前はセッションのスナップショット (resync が持つ)、アイコンはカタログから live 解決する。
  // 未作成チャットでは選択中のエージェントを出し、作成後に payload の値へ切り替わる
  const chatAgentName = app.chat.sessionAgentName || app.selectedAgent?.name;
  const chatAgentIcon = agentIconOf(app.agents, app.chat.sessionAgentId ?? app.agentId);

  // 設定ページは main を丸ごと使う (チャットとは排他)。compact ではヘッダが CompactBar の代わりになるため、
  // 設定ページ間を移るための nav の導線をページへ渡す
  const pageProps = { compact, onBack: backToChat, onOpenNav: compact ? openNav : undefined };

  return (
    <div
      className={cn(
        "grid h-dvh min-h-0 bg-base text-ink",
        compact ? "grid-cols-1 grid-rows-1" : "grid-cols-[252px_minmax(0,1fr)] grid-rows-1",
      )}
    >
      {compact ? null : <Sidebar {...navProps} />}
      <main
        className={cn(
          "grid min-h-0 min-w-0 grid-rows-1 overflow-hidden",
          // 右パネルはシェルの 3 カラム目 (チャット列の隣)。狭い viewport では 30vw まで縮めてチャット列を残す
          filesPanelOpen ? "grid-cols-[minmax(0,1fr)_min(360px,30vw)]" : "grid-cols-1",
        )}
      >
        <div className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden">
          {/* 設定ページを開いている間もチャットは mount したまま display だけ切る。
              実行中のラン (SSE)・入力中の下書き・スクロール位置を unmount で失わないため */}
          <div
            className={
              mainView === "settings"
                ? "hidden"
                : "grid min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
            }
          >
            {compactMode ? (
              <CompactBar
                mode={compactMode}
                title={barTitle}
                agentName={barAgentName}
                runtimeStatus={app.runtimeStatus}
                sessionFiles={filesRoot ? { open: filesSheetOpen, onToggle: toggleSessionFiles } : undefined}
                onOpenNav={openNav}
              />
            ) : (
              <Topbar
                runtimeStatus={app.runtimeStatus}
                sessionFiles={filesRoot ? { open: filesPanelOpen, onToggle: toggleSessionFiles } : undefined}
              />
            )}
            <FileRefProvider rootCwd={app.health?.cwd ?? ""} cwd={app.cwd} onOpen={openFileRef}>
              <ChatArea
                visible={mainView === "chat"}
                bubbles={app.chat.bubbles}
                compactions={app.chat.compactions}
                compact={compact}
                suggestions={app.selectedAgent?.suggestions}
                agentName={chatAgentName}
                agentIcon={chatAgentIcon}
                rootCwd={app.health?.cwd ?? ""}
                onSuggestion={handleSend}
              />
            </FileRefProvider>
            <Composer
              visible={mainView === "chat"}
              activity={app.chat.activity}
              runningSince={app.chat.runStatus === "running" ? app.chat.runStartedAt : undefined}
              runtimeReady={app.health?.ready !== false}
              sending={app.sending}
              stopVisible={app.stopVisible}
              queueDepth={app.chat.queueDepth}
              context={app.chat.context}
              settings={app.composerSettings}
              agents={app.agents}
              agentId={app.agentId}
              mode={layout}
              attachments={app.attachments}
              rootCwd={app.health?.cwd ?? ""}
              skills={app.sessionSkills}
              onSend={handleSend}
              onStop={handleStop}
              onAttachFiles={app.attachFiles}
              onRemoveAttachment={app.removeAttachment}
              onChangeModel={app.changeModel}
              onChangeThinkingLevel={app.changeThinkingLevel}
              onReloadSkills={app.reloadSessionSkills}
              onChangeAgent={handleAgentChange}
            />
          </div>
          {mainView === "settings" ? (
            settingsSection === "agents" ? (
              <AgentSettingsPage
                {...pageProps}
                catalog={app.catalog}
                agentId={app.agentId}
                refreshCatalog={refreshCatalog}
                modelOptions={app.health?.modelOptions ?? []}
                defaultModel={app.health?.model}
                defaultThinkingLevel={app.health?.defaultThinkingLevel}
              />
            ) : settingsSection === "skills" ? (
              <SkillSettingsPage {...pageProps} catalog={app.catalog} refreshCatalog={refreshCatalog} />
            ) : settingsSection === "files" ? (
              // root を選択中の session / project に追随させると、選択を変えると同じ画面が別の場所を指して分かりにくい。
              // 設定のファイルはワークスペース全体に固定し、セッションの作業フォルダはツリーから辿って開く
              <FileTreePage {...pageProps} cwd="" />
            ) : settingsSection === "backup" ? (
              <BackupPage
                {...pageProps}
                catalog={app.catalog}
                projects={app.projects}
                sessions={app.sessions}
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
            runEndSeq={app.chat.runEndSeq}
            onClose={closeSessionFiles}
            openRequest={pendingFileRef}
            onHandled={app.ackFileRef}
          />
        ) : null}
      </main>
      {filesSheetOpen ? (
        <SessionFilesSheet
          key={filesRoot}
          root={filesRoot}
          runEndSeq={app.chat.runEndSeq}
          onClose={closeSessionFiles}
          openRequest={pendingFileRef}
          onHandled={app.ackFileRef}
          returnFocus={fileRefOriginRef.current}
        />
      ) : null}
      {compact && navOpen ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}
      {projectDialogOpen ? (
        <ProjectDialog compact={compact} onClose={closeProjectDialog} onCreate={app.createProject} />
      ) : null}
    </div>
  );
}
