import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { CreateProjectInput } from "./api";
import { useSpace } from "./SpaceContext";
import { SpaceSettingsPage } from "./components/SpaceSettingsPage";
import { AgentSettingsPage } from "./components/AgentSettingsPage";
import { AppearancePage } from "./components/AppearancePage";
import { ArchiveSettingsPage } from "./components/ArchiveSettingsPage";
import { ChatArea } from "./components/ChatArea";
import { CompactBar } from "./components/CompactBar";
import { Composer } from "./components/Composer";
import { useConfirm } from "./components/ConfirmProvider";
import { FileTreePage } from "./components/FileTreePage";
import { NavSheet } from "./components/NavSheet";
import { ModelSettingsPage } from "./components/ModelSettingsPage";
import { NotificationSettingsPage } from "./components/NotificationSettingsPage";
import { ProjectDialog } from "./components/ProjectDialog";
import { RuntimePage } from "./components/RuntimePage";
import { Sidebar } from "./components/Sidebar";
import { SessionFilesPanel, SessionFilesSheet } from "./components/SessionFilesPanel";
import { SkillSettingsPage } from "./components/SkillSettingsPage";
import { Topbar } from "./components/Topbar";
import { FileRefProvider } from "./components/markdown/FileRefLink";
import { MarkdownImageProvider } from "./components/markdown/MarkdownImageRefs";
import { useU7Agent, type SendMessageOptions } from "./hooks/useU7Agent";
import { useElapsedMs } from "./hooks/useElapsedMs";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useMarkdownImageRawUrl } from "./hooks/useMarkdownImageRawUrl";
import { useRoute } from "./hooks/useRoute";
import { useSessionFilesPanelWidth } from "./hooks/useSessionFilesPanelWidth";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useViewportWidth } from "./hooks/useViewportWidth";
import { agentIconOf } from "./lib/agentIcon";
import { chatScope } from "./lib/chatScope";
import { cn } from "./lib/cn";
import { compactConfirmRequest } from "./lib/compaction";
import { confirmTargetUnchanged } from "./lib/confirmDialog";
import {
  fileRefRequestForSession,
  filesModeForTarget,
  filesModeScopeChanged,
  DEFAULT_FILES_MODE,
  type FilesMode,
} from "./lib/fileRefRequest";
import type { FileRefTarget } from "./lib/fileRef";
import { resolveSidebarPlacement } from "./lib/layout";
import {
  missingLinkNote,
  notificationHasFailure,
  notifyCannotEnable,
  notifyDeliverable,
  notifyUnavailableNote,
} from "./lib/notifications";
import { sessionFilesDefaultOpen, sessionFilesRoot } from "./lib/sessionFiles";
import { sessionEnvScope } from "./lib/sessionEnv";
import { servedAppBusyKind, servedAppStartConfirm, servedAppView } from "./lib/servedApp";
import { activityDisplay, retryRemainingMs } from "./lib/retryState";
import { RUN_RETRY_PROMPT } from "./lib/runRetry";
import {
  DEFAULT_MODELS_SUBSECTION,
  type ModelsSubsection,
  type SettingsSection,
  type SidebarMode,
} from "./lib/settingsNav";

export default function App() {
  const space = useSpace();
  // 確認と入力のダイアログ。文言は各 lib の純関数で組み立てる (docs/ui-layout.md)
  const confirm = useConfirm();
  // 画面は URL がただ 1 つの正。`/` はチャット、`/settings/<section>` は設定の各画面、
  // `/s/<id>` は通知のリンクの入口 (選択待ちの間だけ URL を保つ。lib/route.ts)
  const { route, navigate, consumePendingEntry, lastSettingsSection } = useRoute();
  const app = useU7Agent({
    pendingSessionId: route.view === "chat" ? route.pendingSessionId : undefined,
    onPendingSessionResolved: consumePendingEntry,
  });
  const markdownImageRawUrl = useMarkdownImageRawUrl(app.chat.runEndSeq);
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const compactMode = layout === "desktop" ? null : layout;
  const compact = compactMode !== null;
  // 左バーの置き方だけが変わる (中身はどちらも同じ Sidebar)。overlay は ☰ から開く
  const viewportWidth = useViewportWidth();
  const sidebarDocked = resolveSidebarPlacement(viewportWidth, layout) === "docked";
  // 左バーの幅は docked のシェル (grid の 1 列目) が使う。overlay のドロワーは従来どおり固定幅
  const sidebarWidth = useSidebarWidth();
  // 右パネルの幅は main 列の残りで決まる (docked は左バーの実幅を引く。overlay は main = viewport)
  const panelWidth = useSessionFilesPanelWidth({
    viewportWidth,
    mainWidth: sidebarDocked ? viewportWidth - sidebarWidth.width : viewportWidth,
  });
  const mainView = route.view;
  // 再試行待機の残り時間表示。受信後の経過だけを毎秒測る (retryReceivedAt が無ければ tick しない)
  const retryElapsed = useElapsedMs(app.chat.retryReceivedAt);
  // 状態行に出す活動の文言と由来。再試行の文言で上書きしている間は run の由来を渡さない
  const activity = activityDisplay(
    app.chat.activity,
    app.chat.activityState,
    app.chat.retry,
    retryRemainingMs(app.chat.retryRemainingMs, retryElapsed),
  );
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
  // 作業環境の環境変数タブの要求元。会話があれば sessionId、未作成なら作成先プロジェクトの projectId を使う
  const envScope = sessionEnvScope({
    sessionId: app.sessionId,
    projectId: app.sessionId === "" ? (app.selectedProjectId ?? "") : "",
  });
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // 作業フォルダの開閉は保存しない (desktop は右パネル、compact は全画面シートで state も分ける)。
  // 起動時は常に未所属の新規会話なので閉。既定を当てるのは利用者操作の新規会話の入口だけ
  const [sessionFilesOpen, setSessionFilesOpen] = useState(false);
  const [sessionFilesSheetOpen, setSessionFilesSheetOpen] = useState(false);
  // シートを閉じる契機の監視キー。route 全体は比べない (/s/<id> が / へ畳まれるだけでは閉じない)
  const [sheetScope, setSheetScope] = useState(() => ({ compact, view: mainView, root: filesRoot }));
  // 設定ページへの出入り / root の変更 / desktop への復帰でシートを閉じる。showModal() は子の Effect で
  // 親より先に走るため、Effect ではなく前の描画の値と比べる描画中の同期で閉じる
  if (sheetScope.compact !== compact || sheetScope.view !== mainView || sheetScope.root !== filesRoot) {
    setSheetScope({ compact, view: mainView, root: filesRoot });
    setSessionFilesSheetOpen(false);
  }
  // 面のモード (作業フォルダ / スキル)。要求の種別で切り替え、閉じる導線 / セッション切替 / チャット以外への
  // 移動 / compact ⇄ desktop の切替で既定 (作業フォルダ) へ戻す
  const [filesMode, setFilesMode] = useState<FilesMode>(DEFAULT_FILES_MODE);
  // モードを既定へ戻す契機の監視キー。root (cwd) だけでは同一プロジェクトのセッション切替 / 新規チャットを
  // 拾えないため、選択中セッションの識別子も見る (シートの閉じと同じ描画中の同期で反映する)
  const [filesModeScope, setFilesModeScope] = useState(() => ({ compact, view: mainView, sessionId: app.sessionId }));
  if (filesModeScopeChanged(filesModeScope, { compact, view: mainView, sessionId: app.sessionId })) {
    setFilesModeScope({ compact, view: mainView, sessionId: app.sessionId });
    setFilesMode(DEFAULT_FILES_MODE);
  }
  // 配信できない設定で通知を On にしようとしたか。押した後だけ出す注記の根拠で、会話を移ったら捨てる
  const [notifyAttempted, setNotifyAttempted] = useState(false);
  // 押して On にした回数 (ベルの演出の世代)。会話の切替 / リロードで値が On に上がるだけでは進めない
  const [notifyRing, setNotifyRing] = useState(0);
  const sidebarMode: SidebarMode = route.view === "settings" ? "settings" : "nav";
  // URL にセクションが無いときだけ「最後に開いていたセクション」を見せる (URL の指定を上書きしない)
  const settingsSection: SettingsSection = route.view === "settings" ? route.section : lastSettingsSection;
  const closeProjectDialog = useCallback(() => setProjectDialogOpen(false), []);
  const openNav = useCallback(() => setNavOpen(true), []);
  // 実際に閉じる (ドロワーを unmount する)。退場アニメは NavSheet が持ち、その完了 (dialog の close) から届く
  const closeNav = useCallback(() => setNavOpen(false), []);
  const backToChat = useCallback(() => navigate({ view: "chat" }), [navigate]);
  // ファイル参照から開いたときの起点要素。compact の sheet は閉じたときにここへ focus を戻す
  const fileRefOriginRef = useRef<HTMLElement | null>(null);
  const { requestFileRef } = app;
  const openFileRef = useCallback(
    (target: FileRefTarget, origin: HTMLElement | null) => {
      // 起点はクリック時に自分で持つ (document.activeElement がクリックした button を指すとは限らない)
      fileRefOriginRef.current = origin;
      // 面のモードを要求の種別へ切り替えてから開く (逆向きの参照も面が入れ替わって消費する)
      setFilesMode(filesModeForTarget(target));
      if (compact) setSessionFilesSheetOpen(true);
      else setSessionFilesOpen(true);
      requestFileRef(target);
    },
    [compact, requestFileRef],
  );
  const backToWorkFiles = useCallback(() => setFilesMode(DEFAULT_FILES_MODE), []);
  const toggleSessionFiles = useCallback(() => {
    // トグルからの開閉ではファイル参照へ focus を戻さない
    fileRefOriginRef.current = null;
    // 閉じる導線は面ごと既定 (作業フォルダ面) へ戻す (開き直してもスキル面を残さない)
    setFilesMode(DEFAULT_FILES_MODE);
    // 押した面 (layout で決まる) だけを反転する
    if (compact) setSessionFilesSheetOpen((open) => !open);
    else setSessionFilesOpen((open) => !open);
  }, [compact]);
  // 閉じる導線は押した面だけを閉じる。特にシートの close で desktop のパネルを閉じると、
  // compact を往復しただけで開閉が変わる (レイアウト切替は互いの state に影響しない)
  const closeSessionFiles = useCallback(() => {
    setSessionFilesOpen(false);
    setFilesMode(DEFAULT_FILES_MODE);
  }, []);
  const closeSessionFilesSheet = useCallback(() => {
    setSessionFilesSheetOpen(false);
    setFilesMode(DEFAULT_FILES_MODE);
  }, []);

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
    (text: string, options?: SendMessageOptions) => {
      void app.sendMessage(text, options);
    },
    [app],
  );

  const handleStop = useCallback(() => {
    void app.stopAgent();
  }, [app]);

  const handleRetry = useCallback(() => {
    // 失敗の復旧も通常の送信経路に載せる (BFF から prompt() を再発行しない)。固定文言だけを送り、
    // 編集中の添付は送らず消費もしない
    handleSend(RUN_RETRY_PROMPT, { includeAttachments: false });
  }, [handleSend]);

  const handleResendUnsent = useCallback(
    (runId: string) => {
      void app.resendUnsent(runId);
    },
    [app],
  );

  const handleDiscardUnsent = useCallback(
    (runId: string) => {
      void app.discardUnsent(runId);
    },
    [app],
  );

  // 確認を開いている間に会話が切り替わったかを、確定時に ref で見る (この時点の sessionId は古い)
  const sessionIdRef = useRef(app.sessionId);
  sessionIdRef.current = app.sessionId;

  const handleCompact = useCallback(() => {
    // 戻せない操作なので、押した時点で不可逆性と課金を確認する (状態行に注意書きを開く導線は置かない)
    const target = app.sessionId;
    void (async () => {
      if (!(await confirm(compactConfirmRequest()))) return;
      // 会話が変わっていたら、未確認の別の会話を圧縮しない
      if (!confirmTargetUnchanged(target, sessionIdRef.current)) return;
      void app.compactSession();
    })();
  }, [app, confirm]);

  const handleToggleNotify = useCallback(() => {
    // 送られない On を作らない。押しても切り替わらず、理由と導線をバーの下に出す
    if (notifyCannotEnable(app.notify, app.notifications.settings)) {
      setNotifyAttempted(true);
      return;
    }
    setNotifyAttempted(false);
    // ベルを鳴らすのは押して On にしたときだけ。Off への切替と、値が On へ上がるだけの経路
    // (会話の切替 / リロード / deep link の解決) では世代を進めない
    if (!app.notify) setNotifyRing((seq) => seq + 1);
    void app.toggleNotify();
  }, [app]);

  // 押した後の注記はその場のフィードバックなので、会話を移ったら捨てる (戻ってきたときに復活させない)
  useEffect(() => {
    setNotifyAttempted(false);
  }, [app.sessionId]);

  // 表示中のセッション。エージェント切替で引き継ぐ作業先 (所属) の解決にも使う
  const activeSession = app.sessions.find((item) => item.sessionId === app.sessionId);

  // サービスの状態と操作。バーの表示条件は lib/servedApp が決める (会話ごとの値なので facade が持つ)
  const serve = app.serve;
  const handleServeStart = useCallback(() => {
    const busy = servedAppBusyKind({
      selfStatus: app.chat.runStatus,
      sessionId: app.sessionId,
      projectId: activeSession?.projectId,
      sessions: app.sessions,
    });
    const request = servedAppStartConfirm(servedAppView(app.serve.status), busy);
    const target = app.sessionId;
    void (async () => {
      // 置き換えの確認を取ってから起動する (取り消したら何もしない)。表示した時点の状態で確認する
      if (request && !(await confirm(request))) return;
      // 会話が変わっていたら、未確認の別の会話のサービスを起動しない
      if (!confirmTargetUnchanged(target, sessionIdRef.current)) return;
      void app.serve.start();
    })();
  }, [app.chat.runStatus, app.sessionId, activeSession?.projectId, app.sessions, app.serve, confirm]);
  const serveProps = {
    port: app.health?.previewPort,
    status: serve.status,
    failed: serve.failed,
    starting: serve.starting,
    error: serve.error,
    onStart: handleServeStart,
    onStop: serve.stop,
    onCancel: serve.cancel,
  };

  // 利用者操作の新規会話の入口をここへ寄せる (サイドバー / ドロワー / エージェント切替 / プロジェクトの追加)。
  // 作成先はプロジェクトを指定する導線 (プロジェクト行の ⋯「このプロジェクトに新しい会話」/ 追加の成功後) が渡したときだけプロジェクトになり、
  // それ以外は未所属 (最後に開いたプロジェクトを引き継がない)。既定 (プロジェクト配下なら開) の適用はこの入口だけ
  const handleNewChat = useCallback(
    (agentId?: string, projectId?: string) => {
      const target = projectId ?? "";
      setSessionFilesOpen(sessionFilesDefaultOpen({ compact, projectId: target }));
      app.newChat(agentId, target);
    },
    [app, compact],
  );

  // セッション中のエージェントは作成時に固定される (定義は meta の promptSnapshot) ため、この入口は
  // 未作成チャットの選択だけ。作成先はそのチャットが持っている選択 (いまの作成先) をそのまま使う
  const handleAgentChange = useCallback(
    (agentId: string) => {
      handleNewChat(agentId, app.selectedProjectId);
    },
    [app.selectedProjectId, handleNewChat],
  );

  // プロジェクトの追加も「そのディレクトリで作業を始める」入口なので、成功後は ＋ と同じ新規会話へ入る。
  // 選ぶのは一覧への反映後 (先に選ぶと、一覧に無い id として未所属へ戻され得る)
  const handleCreateProject = useCallback(
    async (input: CreateProjectInput) => {
      const project = await app.createProject(input);
      handleNewChat(undefined, project.id);
      return project;
    },
    [app, handleNewChat],
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

  // モデルのタブ切替も URL へ集約する。既定タブはパスへ出さない (正準形は lib/route.ts が決める)
  const openModelsSubsection = useCallback(
    (subsection: ModelsSubsection) => {
      navigate(
        subsection === DEFAULT_MODELS_SUBSECTION
          ? { view: "settings", section: "models" }
          : { view: "settings", section: "models", modelsSubsection: subsection },
      );
    },
    [navigate],
  );

  // 会話の通知トグル。note は On で配信できない間は常に、Off では押した後だけ出す (Off へは常に戻せる)。
  // deliverable (色とラベルの根拠) と notifyCannotEnable (押下を止める根拠) を混ぜない
  const notifyToggle = {
    on: app.notify,
    ring: notifyRing,
    note: notifyUnavailableNote(app.notify, app.notifications.settings, notifyAttempted),
    deliverable: notifyDeliverable(app.notifications.settings),
    onToggle: handleToggleNotify,
    onOpenSettings: () => openSettingsSection("notifications"),
  };

  const navProps = {
    spaceName: space.selected.name,
    conversationOnly: space.selected.id !== "default",
    mode: sidebarMode,
    onSelectMode: selectMode,
    activeSettingsSection: settingsSection,
    // 設定ナビの ⚠。通知設定は facade が持つため、ページを開いていなくても反映される
    notificationsFailed: notificationHasFailure(app.notifications.settings),
    sessions: app.sessions,
    sessionId: app.sessionId,
    agents: app.agents,
    projects: app.projects,
    newChat: handleNewChat,
    selectSession: (sessionId: string) => {
      if (sessionId !== app.sessionId) void app.selectSession(sessionId);
    },
    renameSession: (sessionId: string) => {
      void app.renameSession(sessionId);
    },
    deleteSession: (sessionId: string) => {
      void app.deleteSession(sessionId);
    },
    deleteProject: (projectId: string) => {
      void app.deleteProject(projectId);
    },
    onNewProject: () => setProjectDialogOpen(true),
    onOpenSettingsSection: openSettingsSection,
  };

  // 表示方法だけを layout で分ける (desktop は右パネル、compact は全画面シート)。設定 → ファイルは
  // ワークスペース root 固定なので、作業フォルダとは別の入口にする
  const filesPanelOpen = !compact && filesRoot !== "" && sessionFilesOpen;
  const filesSheetOpen = compact && filesRoot !== "" && sessionFilesSheetOpen;
  // 未消費の要求は選択中セッションのときだけパネルへ渡す (セッションが変われば useSessions が破棄する)。
  // 面へ渡すのは 1 つの要求で、自分宛ての種別だけを適用する (面のモードは要求の種別で切り替える)
  const pendingFileRef = fileRefRequestForSession(app.fileRefRequest, app.sessionId);
  // ツリーの行のダウンロードの出し分け。取得前は空 = 導線を出し、実際の拒否はサーバーの check に任せる
  const excludeNames = app.archiveSettings.settings?.excludeNames ?? [];

  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = app.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || app.selectedAgent?.name;
  // 吹き出しの名前はセッションのスナップショット (resync が持つ)、アイコンはカタログから live 解決する。
  // 未作成チャットでは選択中のエージェントを出し、作成後に payload の値へ切り替わる
  const chatAgentName = app.chat.sessionAgentName || app.selectedAgent?.name;
  const chatAgentIcon = agentIconOf(app.agents, app.chat.sessionAgentId ?? app.agentId);
  const emptyPortrait = layout === "portrait" && app.chat.bubbles.length === 0;
  // 会話中のエージェントは作成時に固定され、選び直しても新しい会話になるだけなので、欄は読み取り専用のラベルにする。
  // 選べるのは未作成チャットだけで、そのときは選択中の値をプルダウンで出す
  const composerAgent = app.sessionId ? { name: barAgentName ?? "", icon: chatAgentIcon } : undefined;

  // 設定ページは main を丸ごと使う (チャットとは排他)。compact ではヘッダが CompactBar の代わりになり、
  // 狭い desktop では左バーが overlay になるため、どちらも nav の導線をページへ渡す
  const pageProps = { compact, onBack: backToChat, onOpenNav: sidebarDocked ? undefined : openNav };

  return (
    <div
      ref={sidebarWidth.shellRef}
      // 左バーの列幅。ドラッグ中は同じ変数を直接書き換える (hooks/useSidebarWidth)
      style={{ "--sidebar-width": `${sidebarWidth.width}px` } as CSSProperties}
      className={cn(
        "grid h-dvh min-h-0 bg-base text-ink",
        sidebarDocked ? "grid-cols-[var(--sidebar-width)_minmax(0,1fr)] grid-rows-1" : "grid-cols-1 grid-rows-1",
      )}
    >
      {sidebarDocked ? <Sidebar {...navProps} resize={sidebarWidth} /> : null}
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
                : cn(
                    "grid min-h-0 min-w-0 grid-cols-1 overflow-hidden",
                    emptyPortrait ? "chat-empty-portrait" : "grid-rows-[auto_minmax(0,1fr)_auto]",
                  )
            }
          >
            {compactMode ? (
              <CompactBar
                serve={serveProps}
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
                serve={serveProps}
                scope={scope}
                runtimeStatus={app.runtimeStatus}
                notify={notifyToggle}
                sessionFiles={filesRoot ? { open: filesPanelOpen, onToggle: toggleSessionFiles } : undefined}
                nav={sidebarDocked ? undefined : { onOpen: openNav }}
              />
            )}
            <FileRefProvider rootCwd={app.health?.cwd ?? ""} cwd={app.cwd} onOpen={openFileRef}>
              <MarkdownImageProvider rootCwd={app.health?.cwd ?? ""} cwd={app.cwd} rawUrl={markdownImageRawUrl}>
                <ChatArea
                  visible={mainView === "chat"}
                  centerEmpty={emptyPortrait}
                  bubbles={app.chat.bubbles}
                  dividers={app.chat.dividers}
                  compactions={app.chat.compactions}
                  activeContextStartId={app.chat.history.activeContextStartId}
                  historyHasMore={app.chat.history.hasMore}
                  historyLoading={app.chat.history.loading}
                  prependSeq={app.chat.prependSeq}
                  onLoadOlder={app.loadOlderHistory}
                  compact={compact}
                  scope={scope}
                  suggestions={app.selectedAgent?.suggestions}
                  agentName={chatAgentName}
                  agentIcon={chatAgentIcon}
                  rootCwd={app.health?.cwd ?? ""}
                  sessionId={app.sessionId}
                  sendSeq={app.chat.sendSeq}
                  onSuggestion={handleSend}
                  onResendUnsent={handleResendUnsent}
                  onDiscardUnsent={handleDiscardUnsent}
                  answerable={app.chat.runStatus === "running"}
                  onAnswerQuestion={app.answerQuestion}
                  currentAssistantId={app.chat.currentAssistantId}
                />
              </MarkdownImageProvider>
            </FileRefProvider>
            <Composer
              visible={mainView === "chat"}
              activity={activity.text}
              activityState={activity.state}
              runningSince={
                app.chat.runStatus === "running"
                  ? app.chat.runStartedAt
                  : app.chat.runStatus === "compacting"
                    ? app.chat.compactionStartedAt
                    : undefined
              }
              finishedRunDurationMs={app.chat.finishedRunDurationMs}
              runtimeReady={app.health?.ready !== false}
              sending={app.sending}
              stopVisible={app.stopVisible}
              queueDepth={app.chat.queueDepth}
              context={app.chat.context}
              settings={app.composerSettings}
              agents={app.agents}
              agentId={app.agentId}
              sessionAgent={composerAgent}
              mode={layout}
              attachments={app.attachments}
              rootCwd={app.health?.cwd ?? ""}
              skills={app.sessionSkills}
              onSend={handleSend}
              onStop={handleStop}
              onCompact={app.sessionId ? handleCompact : undefined}
              runStatus={app.chat.runStatus}
              runTools={app.chat.runTools}
              liveToolIds={app.chat.liveToolIds}
              sessionId={app.sessionId}
              runError={app.chat.runError}
              onRetry={handleRetry}
              onAttachFiles={app.attachFiles}
              onRemoveAttachment={app.removeAttachment}
              onChangeModel={app.changeModel}
              onChangeThinkingLevel={app.changeThinkingLevel}
              onReloadSkills={app.revalidateSessionSkills}
              onChangeAgent={handleAgentChange}
            />
            {emptyPortrait ? <div aria-hidden="true" className="min-h-0" /> : null}
          </div>
          {mainView === "settings" ? (
            settingsSection === "spaces" ? (
              <SpaceSettingsPage {...pageProps} />
            ) : settingsSection === "agents" ? (
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
              <SkillSettingsPage
                {...pageProps}
                catalog={app.catalog}
                refreshCatalog={refreshCatalog}
                filePreviewPort={app.health?.filePreviewPort}
              />
            ) : settingsSection === "files" ? (
              // root を選択中の session / project に追随させると、選択を変えると同じ画面が別の場所を指して分かりにくい。
              // 設定のファイルはワークスペース全体に固定し、セッションの作業フォルダはツリーから辿って開く
              <FileTreePage
                {...pageProps}
                cwd=""
                excludeNames={excludeNames}
                filePreviewPort={app.health?.filePreviewPort}
              />
            ) : settingsSection === "archive" ? (
              <ArchiveSettingsPage {...pageProps} archiveSettings={app.archiveSettings} />
            ) : settingsSection === "appearance" ? (
              <AppearancePage {...pageProps} />
            ) : settingsSection === "models" ? (
              // 最終使用の導出元は起動時から facade が持つ一覧。この画面だけに渡す (再取得はしない)
              <ModelSettingsPage
                {...pageProps}
                onRefreshHealth={app.refreshHealth}
                sessions={app.sessions}
                sessionsLoaded={app.sessionsLoaded}
                modelsSubsection={
                  route.view === "settings" && route.section === "models"
                    ? (route.modelsSubsection ?? DEFAULT_MODELS_SUBSECTION)
                    : DEFAULT_MODELS_SUBSECTION
                }
                onSelectModelsSubsection={openModelsSubsection}
              />
            ) : settingsSection === "runtime" ? (
              <RuntimePage
                {...pageProps}
                health={app.health}
                onRefreshHealth={app.refreshHealth}
                onOpenSession={(sessionId) => {
                  void app.selectSession(sessionId, undefined, { fallbackOnFailure: false }).then((result) => {
                    const note = missingLinkNote(true, result);
                    if (note) app.dispatch({ type: "setActivity", text: note });
                  });
                  backToChat();
                }}
              />
            ) : (
              <NotificationSettingsPage {...pageProps} notifications={app.notifications} />
            )
          ) : null}
        </div>
        {filesPanelOpen ? (
          <SessionFilesPanel
            key={filesRoot}
            root={filesRoot}
            envScope={envScope ?? {}}
            excludeNames={excludeNames}
            filePreviewPort={app.health?.filePreviewPort}
            runEndSeq={app.chat.runEndSeq}
            onClose={closeSessionFiles}
            openRequest={pendingFileRef}
            onHandled={app.ackFileRef}
            mode={filesMode}
            onBackToWork={backToWorkFiles}
            resize={panelWidth}
          />
        ) : null}
      </main>
      {filesSheetOpen ? (
        <SessionFilesSheet
          key={filesRoot}
          root={filesRoot}
          envScope={envScope ?? {}}
          excludeNames={excludeNames}
          filePreviewPort={app.health?.filePreviewPort}
          runEndSeq={app.chat.runEndSeq}
          onClose={closeSessionFilesSheet}
          openRequest={pendingFileRef}
          onHandled={app.ackFileRef}
          mode={filesMode}
          onBackToWork={backToWorkFiles}
          returnFocus={fileRefOriginRef.current}
        />
      ) : null}
      {/* overlay の左バーは docked の Sidebar と排他にする (docked へ戻ったフレームで両方を描かない)。
          閉じるのも NavSheet 側 (退場アニメの完了 → dialog の close) なので、App は閉じる要求を持たない */}
      {navOpen && !sidebarDocked ? <NavSheet {...navProps} onClose={closeNav} /> : null}
      {projectDialogOpen ? (
        <ProjectDialog compact={compact} onClose={closeProjectDialog} onCreate={handleCreateProject} />
      ) : null}
    </div>
  );
}
