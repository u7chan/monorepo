import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AgentSettingsPage } from "./components/AgentSettingsPage";
import { AppearancePage } from "./components/AppearancePage";
import { ArchiveSettingsPage } from "./components/ArchiveSettingsPage";
import { ChatArea } from "./components/ChatArea";
import { CompactBar } from "./components/CompactBar";
import { Composer } from "./components/Composer";
import { FileTreePage } from "./components/FileTreePage";
import { NavSheet } from "./components/NavSheet";
import { NotificationSettingsPage } from "./components/NotificationSettingsPage";
import { ProjectDialog } from "./components/ProjectDialog";
import { RuntimePage } from "./components/RuntimePage";
import { Sidebar } from "./components/Sidebar";
import { SessionFilesPanel, SessionFilesSheet } from "./components/SessionFilesPanel";
import { SkillSettingsPage } from "./components/SkillSettingsPage";
import { Topbar } from "./components/Topbar";
import { FileRefProvider } from "./components/markdown/FileRefLink";
import { useU7Agent } from "./hooks/useU7Agent";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useRoute } from "./hooks/useRoute";
import { useSessionFilesPanelWidth } from "./hooks/useSessionFilesPanelWidth";
import { useViewportWidth } from "./hooks/useViewportWidth";
import { agentIconOf } from "./lib/agentIcon";
import { chatScope } from "./lib/chatScope";
import { cn } from "./lib/cn";
import { fileRefRequestForSession } from "./lib/fileRefRequest";
import { resolveSidebarPlacement, SIDEBAR_WIDTH } from "./lib/layout";
import {
  notificationHasFailure,
  notifyCannotEnable,
  notifyDeliverable,
  notifyUnavailableNote,
} from "./lib/notifications";
import { sessionFilesDefaultOpen, sessionFilesRoot } from "./lib/sessionFiles";
import { type SettingsSection, type SidebarMode } from "./lib/settingsNav";

export default function App() {
  // 画面は URL がただ 1 つの正。`/` はチャット、`/settings/<section>` は設定の各画面、
  // `/s/<id>` は通知のリンクの入口 (選択待ちの間だけ URL を保つ。lib/route.ts)
  const { route, navigate, consumePendingEntry, lastSettingsSection } = useRoute();
  const app = useU7Agent({
    pendingSessionId: route.view === "chat" ? route.pendingSessionId : undefined,
    onPendingSessionResolved: consumePendingEntry,
  });
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  // 左バーの置き方だけが変わる (中身はどちらも同じ Sidebar)。overlay は ☰ から開く
  const viewportWidth = useViewportWidth();
  const sidebarDocked = resolveSidebarPlacement(viewportWidth, layout) === "docked";
  // 右パネルの幅は main 列の残りで決まる (docked の左バー 252px を引く。overlay は main = viewport)
  const panelWidth = useSessionFilesPanelWidth({
    viewportWidth,
    mainWidth: sidebarDocked ? viewportWidth - SIDEBAR_WIDTH : viewportWidth,
  });
  const mainView = route.view;
  // 作業先 (バーのチップ / 空状態の見出し)。未作成チャットは作成先、セッションはその所属が作業先になる
  const scope = chatScope({
    cwd: app.cwd,
    sessionId: app.sessionId,
    selectedProjectId: app.selectedProjectId,
    projects: app.projects,
    sessions: app.sessions,
  });
  // 作業フォルダの root。projectCwd はセッション未作成かつ作成先が解決済みのときだけ渡す (lib/sessionFiles.ts)
  const filesRoot = sessionFilesRoot({
    chatView: mainView === "chat",
    cwd: app.cwd,
    projectCwd: app.sessionId === "" ? (app.selectedProject?.cwd ?? "") : "",
  });
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // 作業フォルダの開閉は保存しない (desktop は右パネル、compact は全画面シートで state も分ける)
  const [sessionFilesOpen, setSessionFilesOpen] = useState(() =>
    sessionFilesDefaultOpen({ compact, projectId: app.selectedProjectId }),
  );
  const [sessionFilesSheetOpen, setSessionFilesSheetOpen] = useState(false);
  // シートを閉じる契機の監視キー。route 全体は比べない (/s/<id> が / へ畳まれるだけでは閉じない)
  const [sheetScope, setSheetScope] = useState(() => ({ compact, view: mainView, root: filesRoot }));
  // 設定ページへの出入り / root の変更 / desktop への復帰でシートを閉じる。showModal() は子の Effect で
  // 親より先に走るため、Effect ではなく前の描画の値と比べる描画中の同期で閉じる
  if (sheetScope.compact !== compact || sheetScope.view !== mainView || sheetScope.root !== filesRoot) {
    setSheetScope({ compact, view: mainView, root: filesRoot });
    setSessionFilesSheetOpen(false);
  }
  // 配信できない設定で通知を On にしようとしたか。押した後だけ出す注記の根拠で、会話を移ったら捨てる
  const [notifyAttempted, setNotifyAttempted] = useState(false);
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
      // ファイル参照の意味は変えず、開く先だけを layout に従わせる
      if (compact) setSessionFilesSheetOpen(true);
      else setSessionFilesOpen(true);
      requestFileRef(path);
    },
    [compact, requestFileRef],
  );
  const toggleSessionFiles = useCallback(() => {
    // トグルからの開閉ではファイル参照へ focus を戻さない
    fileRefOriginRef.current = null;
    // 押した面 (layout で決まる) だけを反転する
    if (compact) setSessionFilesSheetOpen((open) => !open);
    else setSessionFilesOpen((open) => !open);
  }, [compact]);
  // 閉じる導線は押した面だけを閉じる。特にシートの close で desktop のパネルを閉じると、
  // compact を往復しただけで開閉が変わる (レイアウト切替は互いの state に影響しない)
  const closeSessionFiles = useCallback(() => setSessionFilesOpen(false), []);
  const closeSessionFilesSheet = useCallback(() => setSessionFilesSheetOpen(false), []);

  // 幅を広げて左バーが docked に戻ったら、ドロワーは畳む (開いたままにしない)
  useEffect(() => {
    if (sidebarDocked) setNavOpen(false);
  }, [sidebarDocked]);

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

  const handleCompact = useCallback(() => {
    void app.compactSession();
  }, [app]);

  const handleToggleNotify = useCallback(() => {
    // 送られない On を作らない。押しても切り替わらず、理由と導線をバーの下に出す
    if (notifyCannotEnable(app.notify, app.notifications.settings)) {
      setNotifyAttempted(true);
      return;
    }
    setNotifyAttempted(false);
    void app.toggleNotify();
  }, [app]);

  // 押した後の注記はその場のフィードバックなので、会話を移ったら捨てる (戻ってきたときに復活させない)
  useEffect(() => {
    setNotifyAttempted(false);
  }, [app.sessionId]);

  // 利用者操作の新規会話の入口をここへ寄せる (サイドバー / ドロワー / エージェント切替)。
  // 既定 (プロジェクト配下なら開) を適用するのはこの入口と起動時の初期化だけで、内部フォールバックは
  // useSessions が newChat を直接呼ぶため通らない
  const handleNewChat = useCallback(
    (agentId?: string, projectId?: string) => {
      setSessionFilesOpen(sessionFilesDefaultOpen({ compact, projectId: projectId ?? app.selectedProjectId }));
      app.newChat(agentId, projectId);
    },
    [app, compact],
  );

  // エージェントの切替は「新しい会話」と同じで、現在の会話はセッション一覧に残す
  const handleAgentChange = useCallback(
    (agentId: string) => {
      handleNewChat(agentId);
    },
    [handleNewChat],
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

  // 会話の通知トグル。note は On で配信できない間は常に、Off では押した後だけ出す (Off へは常に戻せる)。
  // deliverable (色とラベルの根拠) と notifyCannotEnable (押下を止める根拠) を混ぜない
  const notifyToggle = {
    on: app.notify,
    note: notifyUnavailableNote(app.notify, app.notifications.settings, notifyAttempted),
    deliverable: notifyDeliverable(app.notifications.settings),
    onToggle: handleToggleNotify,
    onOpenSettings: () => openSettingsSection("notifications"),
  };

  const navProps = {
    mode: sidebarMode,
    onSelectMode: selectMode,
    activeSettingsSection: settingsSection,
    // 設定ナビの ⚠。通知設定は facade が持つため、ページを開いていなくても反映される
    notificationsFailed: notificationHasFailure(app.notifications.settings),
    sessions: app.sessions,
    sessionId: app.sessionId,
    agents: app.agents,
    projects: app.projects,
    selectedProjectId: app.selectedProjectId,
    newChat: handleNewChat,
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
      handleNewChat(agentId, projectId);
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

  // 表示方法だけを layout で分ける (desktop は右パネル、compact は全画面シート)。設定 → ファイルは
  // ワークスペース root 固定なので、作業フォルダとは別の入口にする
  const filesPanelOpen = !compact && filesRoot !== "" && sessionFilesOpen;
  const filesSheetOpen = compact && filesRoot !== "" && sessionFilesSheetOpen;
  // 未消費の要求は選択中セッションのときだけパネルへ渡す (セッションが変われば useSessions が破棄する)
  const pendingFileRef = fileRefRequestForSession(app.fileRefRequest, app.sessionId);
  // ツリーの行のダウンロードの出し分け。取得前は空 = 導線を出し、実際の拒否はサーバーの check に任せる
  const excludeNames = app.archiveSettings.settings?.excludeNames ?? [];

  const activeSession = app.sessions.find((item) => item.sessionId === app.sessionId);
  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = app.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || app.selectedAgent?.name;
  // 吹き出しの名前はセッションのスナップショット (resync が持つ)、アイコンはカタログから live 解決する。
  // 未作成チャットでは選択中のエージェントを出し、作成後に payload の値へ切り替わる
  const chatAgentName = app.chat.sessionAgentName || app.selectedAgent?.name;
  const chatAgentIcon = agentIconOf(app.agents, app.chat.sessionAgentId ?? app.agentId);

  // 設定ページは main を丸ごと使う (チャットとは排他)。compact ではヘッダが CompactBar の代わりになり、
  // 狭い desktop では左バーが overlay になるため、どちらも nav の導線をページへ渡す
  const pageProps = { compact, onBack: backToChat, onOpenNav: sidebarDocked ? undefined : openNav };

  return (
    <div
      className={cn(
        "grid h-dvh min-h-0 bg-base text-ink",
        sidebarDocked ? "grid-cols-[252px_minmax(0,1fr)] grid-rows-1" : "grid-cols-1 grid-rows-1",
      )}
    >
      {sidebarDocked ? <Sidebar {...navProps} /> : null}
      <main
        ref={panelWidth.mainRef}
        // パネルの列幅。ドラッグ中は同じ変数を直接書き換える (hooks/useSessionFilesPanelWidth)
        style={{ "--session-files-width": `${panelWidth.width}px` } as CSSProperties}
        className={cn(
          "grid min-h-0 min-w-0 grid-rows-1 overflow-hidden",
          // 右パネルはシェルの 3 カラム目 (チャット列の隣)。幅はハンドルで選ぶ (lib/sessionFilesPanel.ts)
          filesPanelOpen ? "grid-cols-[minmax(0,1fr)_var(--session-files-width)]" : "grid-cols-1",
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
                scope={scope}
                runtimeStatus={app.runtimeStatus}
                notify={notifyToggle}
                sessionFiles={filesRoot ? { open: filesSheetOpen, onToggle: toggleSessionFiles } : undefined}
                onOpenNav={openNav}
              />
            ) : (
              <Topbar
                scope={scope}
                runtimeStatus={app.runtimeStatus}
                notify={notifyToggle}
                sessionFiles={filesRoot ? { open: filesPanelOpen, onToggle: toggleSessionFiles } : undefined}
                nav={sidebarDocked ? undefined : { onOpen: openNav }}
              />
            )}
            <FileRefProvider rootCwd={app.health?.cwd ?? ""} cwd={app.cwd} onOpen={openFileRef}>
              <ChatArea
                visible={mainView === "chat"}
                bubbles={app.chat.bubbles}
                compactions={app.chat.compactions}
                compact={compact}
                scope={scope}
                suggestions={app.selectedAgent?.suggestions}
                agentName={chatAgentName}
                agentIcon={chatAgentIcon}
                rootCwd={app.health?.cwd ?? ""}
                sessionId={app.sessionId}
                sendSeq={app.chat.sendSeq}
                onSuggestion={handleSend}
              />
            </FileRefProvider>
            <Composer
              visible={mainView === "chat"}
              activity={app.chat.activity}
              runningSince={
                app.chat.runStatus === "running"
                  ? app.chat.runStartedAt
                  : app.chat.runStatus === "compacting"
                    ? app.chat.compactionStartedAt
                    : undefined
              }
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
              onCompact={app.sessionId ? handleCompact : undefined}
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
              <FileTreePage {...pageProps} cwd="" excludeNames={excludeNames} />
            ) : settingsSection === "archive" ? (
              <ArchiveSettingsPage {...pageProps} archiveSettings={app.archiveSettings} />
            ) : settingsSection === "appearance" ? (
              <AppearancePage {...pageProps} />
            ) : settingsSection === "runtime" ? (
              <RuntimePage {...pageProps} health={app.health} onRefreshHealth={app.refreshHealth} />
            ) : (
              <NotificationSettingsPage {...pageProps} notifications={app.notifications} />
            )
          ) : null}
        </div>
        {filesPanelOpen ? (
          <SessionFilesPanel
            key={filesRoot}
            root={filesRoot}
            excludeNames={excludeNames}
            runEndSeq={app.chat.runEndSeq}
            onClose={closeSessionFiles}
            openRequest={pendingFileRef}
            onHandled={app.ackFileRef}
            resize={panelWidth}
          />
        ) : null}
      </main>
      {filesSheetOpen ? (
        <SessionFilesSheet
          key={filesRoot}
          root={filesRoot}
          excludeNames={excludeNames}
          runEndSeq={app.chat.runEndSeq}
          onClose={closeSessionFilesSheet}
          openRequest={pendingFileRef}
          onHandled={app.ackFileRef}
          returnFocus={fileRefOriginRef.current}
        />
      ) : null}
      {/* overlay の左バーは docked の Sidebar と排他にする (docked へ戻ったフレームで両方を描かない) */}
      {navOpen && !sidebarDocked ? <NavSheet {...drawerProps} onClose={closeNav} /> : null}
      {projectDialogOpen ? (
        <ProjectDialog compact={compact} onClose={closeProjectDialog} onCreate={app.createProject} />
      ) : null}
    </div>
  );
}
