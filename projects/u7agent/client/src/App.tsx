import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, statFile, type CreateProjectInput } from "./api";
import { useSpace } from "./SpaceContext";
import { SpaceSettingsPage } from "./components/SpaceSettingsPage";
import { AgentSettingsPage } from "./components/AgentSettingsPage";
import { AppearancePage } from "./components/AppearancePage";
import { ChatArea } from "./components/ChatArea";
import { DiagnosticsContext } from "./DiagnosticsContext";
import { SingleColumnBar } from "./components/SingleColumnBar";
import { Composer } from "./components/Composer";
import { useConfirm } from "./components/ConfirmProvider";
import { ContentSettingsPage } from "./components/ContentSettingsPage";
import { FileTreePage } from "./components/FileTreePage";
import { NavSheet } from "./components/NavSheet";
import { ModelSettingsPage } from "./components/ModelSettingsPage";
import { NotificationSettingsPage } from "./components/NotificationSettingsPage";
import { ProjectDialog } from "./components/ProjectDialog";
import { RuntimePage } from "./components/RuntimePage";
import { Sidebar } from "./components/Sidebar";
import { SessionFilesPanel, SessionFilesSheet } from "./components/SessionFilesPanel";
import { SessionMoveDialog } from "./components/SessionMoveDialog";
import { SkillSettingsPage } from "./components/SkillSettingsPage";
import { Topbar } from "./components/Topbar";
import { WebSearchSettingsPage } from "./components/WebSearchSettingsPage";
import { FileRefProvider } from "./components/markdown/FileRefLink";
import { MarkdownImageProvider } from "./components/markdown/MarkdownImageRefs";
import { useU7Agent, type SendMessageOptions } from "./hooks/useU7Agent";
import { useElapsedMs } from "./hooks/useElapsedMs";
import { useExitPhase } from "./hooks/useExitPhase";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useLiveToolCall } from "./hooks/useLiveToolCall";
import { useMarkdownImageRawUrl } from "./hooks/useMarkdownImageRawUrl";
import { useRoute } from "./hooks/useRoute";
import { useSessionFilesPanelWidth } from "./hooks/useSessionFilesPanelWidth";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useViewportWidth } from "./hooks/useViewportWidth";
import { agentIconOf } from "./lib/agentIcon";
import { chatScope } from "./lib/chatScope";
import { nextSheetView, type SheetView } from "./lib/sheetView";
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
import { classifyFileRefFailure, createFileRefOpener, fileRefCheckPath, type FileRefCheck } from "./lib/fileRefOpen";
import { resolveSidebarPlacement } from "./lib/layout";
import { openOwnerSession } from "./lib/ownerLink";
import { sessionPath } from "./lib/route";
import {
  missingLinkNote,
  notificationHasFailure,
  notifyCannotEnable,
  notifyDeliverable,
  notifyUnavailableNote,
} from "./lib/notifications";
import { sessionFilesDefaultOpen, sessionFilesRoot } from "./lib/sessionFiles";
import { sessionEnvScope } from "./lib/sessionEnv";
import { servedAppBusyKind, servedAppFocusRequest, servedAppStartConfirm, servedAppView } from "./lib/servedApp";
import { sessionMoveDialogText } from "./lib/sidebarRowMenu";
import { moveDestinationSpaces } from "./lib/spaceSelection";
import { activityDisplay, retryRemainingMs } from "./lib/retryState";
import { RUN_RETRY_PROMPT } from "./lib/runRetry";
import {
  DEFAULT_CONTENT_SUBSECTION,
  DEFAULT_FILES_SUBSECTION,
  DEFAULT_MODELS_SUBSECTION,
  DEFAULT_RUNTIME_SUBSECTION,
  type ContentSubsection,
  type FilesSubsection,
  type ModelsSubsection,
  type RuntimeSubsection,
  type SettingsSection,
  type SidebarMode,
} from "./lib/settingsNav";
import { suggestionScopeChange, type SuggestionScope } from "./lib/suggestion";
import type { AgentSuggestion } from "./types";

export default function App() {
  const space = useSpace();
  // 確認と入力のダイアログ。文言は各 lib の純関数で組み立てる (docs/ui-layout.md)
  const confirm = useConfirm();
  // 画面 (view) は URL がただ 1 つの正。`/` はチャット (会話を指定しない)、`/settings/<section>` は設定の各画面。
  // 会話の選択は app.sessionId が正で、`/s/<id>` はそれを映す鏡 (URL へ書く条件は lib/route.ts の sessionPath)
  const { route, navigate, syncSessionPath, lastSettingsSection } = useRoute();
  const app = useU7Agent({ pendingSessionId: route.view === "chat" ? route.sessionId : undefined });
  // 確定した選択を URL へ映す唯一の Effect。書く条件 (設定の表示中 / 未解決の入口が未選択のまま) は
  // lib/route.ts の純関数が持ち、依存は primitive だけにする (route 全体を依存にすると新 object の
  // set でループする)
  const urlSessionId = route.view === "chat" ? route.sessionId : undefined;
  useEffect(() => {
    syncSessionPath(sessionPath(route.view, urlSessionId, app.sessionId, app.entryResolved));
  }, [route.view, urlSessionId, app.sessionId, app.entryResolved, syncSessionPath]);
  const markdownImageRawUrl = useMarkdownImageRawUrl(app.chat.runEndSeq);
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const singleColumnMode = layout === "desktop" ? null : layout;
  const singleColumn = singleColumnMode !== null;
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
  // 入力欄の上に浮かぶライブ表示。箱が浮いている間はチャットの下端にも余白を確保するため、
  // 両方を持つここで導出して渡す (段と行の決め方は hooks/useLiveToolCall)
  const liveTools = useLiveToolCall({
    runTools: app.chat.runTools,
    runStatus: app.chat.runStatus,
    liveToolIds: app.chat.liveToolIds,
    sessionId: app.sessionId,
  });
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
  // 選択中の定型プロンプト。入力欄の下書きなので Composer ではなく状態を持つ App が持ち、送信は handleSend に寄せる
  const [suggestion, setSuggestion] = useState<AgentSuggestion | null>(null);
  // 選択を捨てる契機の監視キー。持ち越すと、別の会話・別のエージェントの提案が入力欄に残る (添付と同じ契約)。
  // スペースの切替は App ごと作り直すため、ここでは見ない。会話 id だけの変化 (添付が暗黙に作った会話) では
  // 捨てないので、判定は lib/suggestion.ts の純関数が持つ
  const [suggestionScope, setSuggestionScope] = useState<SuggestionScope>(() => ({
    agentId: app.selectedAgent?.id,
    selectionSeq: app.selectionSeqRef.current,
    sessionId: app.sessionId,
  }));
  const nextSuggestionScope: SuggestionScope = {
    agentId: app.selectedAgent?.id,
    selectionSeq: app.selectionSeqRef.current,
    sessionId: app.sessionId,
  };
  if (suggestionScopeChange(suggestionScope, nextSuggestionScope) === "drop") {
    setSuggestionScope(nextSuggestionScope);
    setSuggestion(null);
  } else if (suggestionScope.sessionId !== nextSuggestionScope.sessionId) {
    // 添付が会話を暗黙に作っただけ。チップは同じ下書きの続きとして、その会話へ移す
    setSuggestionScope(nextSuggestionScope);
  }
  // 押すたびに新しい値を渡す (同じチップを押し直しても、入力欄へフォーカスを戻す合図にする)
  const selectSuggestion = useCallback((next: AgentSuggestion) => setSuggestion({ ...next }), []);
  const clearSuggestion = useCallback(() => setSuggestion(null), []);
  // 引っ越しの対象 (会話 id と、確認に出すタイトル)。開いている間は専用ダイアログが移動先を選ぶ
  const [moveTarget, setMoveTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  // 作業フォルダの開閉は保存しない (desktop は右パネル、singleColumn は全画面シートで state も分ける)。
  // 起動時は閉 (会話 URL を開いてもパネルは勝手に開かない)。既定を当てるのは利用者操作の新規会話の入口だけ
  const [sessionFilesOpen, setSessionFilesOpen] = useState(false);
  const [sessionFilesSheetOpen, setSessionFilesSheetOpen] = useState(false);
  // シートを閉じる契機の監視キー。route 全体は比べない (会話 URL の置換だけでは閉じない)
  const [sheetScope, setSheetScope] = useState(() => ({ singleColumn, view: mainView, root: filesRoot }));
  // 設定ページへの出入り / root の変更 / desktop への復帰でシートを閉じる。showModal() は子の Effect で
  // 親より先に走るため、Effect ではなく前の描画の値と比べる描画中の同期で閉じる
  const sheetScopeChanged =
    sheetScope.singleColumn !== singleColumn || sheetScope.view !== mainView || sheetScope.root !== filesRoot;
  if (sheetScopeChanged) {
    setSheetScope({ singleColumn, view: mainView, root: filesRoot });
    setSessionFilesSheetOpen(false);
  }
  // 面のモード (作業フォルダ / スキル)。要求の種別で切り替え、閉じる導線 / セッション切替 / チャット以外への
  // 移動 / singleColumn ⇄ desktop の切替で既定 (作業フォルダ) へ戻す
  const [filesMode, setFilesMode] = useState<FilesMode>(DEFAULT_FILES_MODE);
  // モードを既定へ戻す契機の監視キー。root (cwd) だけでは同一プロジェクトのセッション切替 / 新規チャットを
  // 拾えないため、選択中セッションの識別子も見る (シートの閉じと同じ描画中の同期で反映する)
  const [filesModeScope, setFilesModeScope] = useState(() => ({
    singleColumn,
    view: mainView,
    sessionId: app.sessionId,
  }));
  if (filesModeScopeChanged(filesModeScope, { singleColumn, view: mainView, sessionId: app.sessionId })) {
    setFilesModeScope({ singleColumn, view: mainView, sessionId: app.sessionId });
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
  const closeMoveDialog = useCallback(() => setMoveTarget(null), []);
  const openNav = useCallback(() => setNavOpen(true), []);
  // 実際に閉じる (ドロワーを unmount する)。退場アニメは NavSheet が持ち、その完了 (dialog の close) から届く
  const closeNav = useCallback(() => setNavOpen(false), []);
  // 設定 ⇄ チャットの往復はメモリ (app.sessionId) だけが持つ会話を、戻るときに URL へ載せ直す。
  // 設定の表示中は URL を書かないので、戻る導線はすべてここを通す
  const backToChat = useCallback(() => {
    const sessionId = app.sessionId;
    navigate(sessionId ? { view: "chat", sessionId } : { view: "chat" });
  }, [app.sessionId, navigate]);
  // スペースの切替は App ごと作り直すため、URL に会話を残すと新しいスペースで「見つかりません」になる。
  // 会話を持たない chat へ戻してから選ばせる (戻るボタンの backToChat とは目的が違う)
  const openChatWithoutSession = useCallback(() => navigate({ view: "chat" }), [navigate]);
  // ファイル参照から開いたときの起点要素。singleColumn の sheet は閉じたときにここへ focus を戻す
  const fileRefOriginRef = useRef<HTMLElement | null>(null);
  const { requestFileRef } = app;
  /** 実在を確認できた参照だけを開く (面のモード切替 / パネル / 要求の登録) */
  const openFileRefTarget = useCallback(
    (target: FileRefTarget) => {
      // 面のモードを要求の種別へ切り替えてから開く (逆向きの参照も面が入れ替わって消費する)
      setFilesMode(filesModeForTarget(target));
      if (singleColumn) setSessionFilesSheetOpen(true);
      else setSessionFilesOpen(true);
      requestFileRef(target);
    },
    [singleColumn, requestFileRef],
  );
  /** 参照の実在確認。通常ファイルとしての 200 だけを成功とし、それ以外は status で分類する */
  const checkFileRef = useCallback(
    async (target: FileRefTarget): Promise<FileRefCheck> => {
      try {
        await statFile(fileRefCheckPath(target, app.cwd));
        return "exists";
      } catch (error) {
        // 通信失敗 (status を持たない) は 0 のまま確認不能へ寄せる
        return classifyFileRefFailure(error instanceof ApiError ? error.status : 0);
      }
    },
    [app.cwd],
  );
  // opener は App の存続期間で 1 つに固定する (作り直すとクリック世代がリセットされ、後着の結果を捨てられない)。
  // 依存は毎回の描画で上書きする ref 経由で読む (確認と面の開き方は layout や cwd で変わる)
  const fileRefDepsRef = useRef({
    checkFileRef,
    openFileRefTarget,
    sessionIdRef: app.sessionIdRef,
    fileRefSwitchSeq: app.fileRefSwitchSeq,
  });
  fileRefDepsRef.current = {
    checkFileRef,
    openFileRefTarget,
    sessionIdRef: app.sessionIdRef,
    fileRefSwitchSeq: app.fileRefSwitchSeq,
  };
  const [fileRefOpener] = useState(() =>
    createFileRefOpener({
      check: (target) => fileRefDepsRef.current.checkFileRef(target),
      open: (target) => fileRefDepsRef.current.openFileRefTarget(target),
      // 選択の ID と切替世代を控える。世代で判定するのは、切替をまたいで同じ ID へ戻っても失効を
      // 巻き戻さないため (ID の一致比較では A→B→A で復活する)
      selection: () => ({
        sessionId: fileRefDepsRef.current.sessionIdRef.current,
        switchSeq: fileRefDepsRef.current.fileRefSwitchSeq(),
      }),
    }),
  );
  const openFileRef = useCallback(
    (target: FileRefTarget, origin: HTMLElement | null) => {
      // 起点はクリック時に自分で持つ (document.activeElement がクリックした button を指すとは限らない)
      fileRefOriginRef.current = origin;
      return fileRefOpener.open(target);
    },
    [fileRefOpener],
  );
  const backToWorkFiles = useCallback(() => setFilesMode(DEFAULT_FILES_MODE), []);
  const toggleSessionFiles = useCallback(() => {
    // トグルからの開閉ではファイル参照へ focus を戻さない
    fileRefOriginRef.current = null;
    // 閉じる導線は面ごと既定 (作業フォルダ面) へ戻す (開き直してもスキル面を残さない)
    setFilesMode(DEFAULT_FILES_MODE);
    // 押した面 (layout で決まる) だけを反転する
    if (singleColumn) setSessionFilesSheetOpen((open) => !open);
    else setSessionFilesOpen((open) => !open);
  }, [singleColumn]);
  // 閉じる導線は押した面だけを閉じる。特にシートの close で desktop のパネルを閉じると、
  // singleColumn を往復しただけで開閉が変わる (レイアウト切替は互いの state に影響しない)
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
      // モーダルが開いている間はその面が Escape を受ける (順序は 詳細シート → ドロワー → チャット)。
      // 退場中は焦点が body へ外れて各面の stopPropagation を通らないため、ここでも見る
      if (document.querySelector("dialog[open]")) return;
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

  const handleCancelQueued = useCallback(
    // MessageView が応答までボタンを無効化するため、完了を待てるよう Promise を返す
    (runId: string) => app.cancelQueued(runId),
    [app],
  );

  // 開始の Flash の終端は DOM 側 (animationend) が持つ。callback の参照を固定し、描画のたびに
  // MessageView 側の effect が張り直されて演出の終端が延びないようにする
  const handleStartFlashEnd = useCallback(() => app.dispatch({ type: "startFlashEnd" }), [app.dispatch]);

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
  // desktop の「サービス」リンクへ焦点を移す 1 ショット要求。立つのはこのタブの起動が成功したときだけ
  const [serveFocusRequest, setServeFocusRequest] = useState(false);
  const ackServeFocus = useCallback(() => setServeFocusRequest(false), []);
  // 要求を消費できるのは desktop のグループだけ。singleColumn へ移ったら描画中に捨てる
  // (残すと desktop へ戻ったときに古い要求で焦点が飛ぶ)
  if (singleColumn && serveFocusRequest) setServeFocusRequest(false);
  // 起動の応答を待っている間にレイアウトは変わり得る。焦点要求の判定は await の後で最新の値から読む
  const singleColumnRef = useRef(singleColumn);
  singleColumnRef.current = singleColumn;
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
      const applied = await app.serve.start();
      // 焦点を移すかの判断はここだけ (ポーリングで観測した外部起動では呼ばない)。
      // 成功時点のレイアウトと焦点で決める (押した時点の値で決めると、待っている間の切替を見落とす)
      const focusRequested = servedAppFocusRequest({
        applied: applied !== undefined,
        singleColumn: singleColumnRef.current,
        focusOnBody: document.activeElement === document.body,
      });
      if (focusRequested) setServeFocusRequest(true);
    })();
  }, [app.chat.runStatus, app.sessionId, activeSession?.projectId, app.sessions, app.serve, confirm]);
  const serveProps = {
    port: app.health?.previewPort,
    status: serve.status,
    failed: serve.failed,
    starting: serve.starting,
    error: serve.error,
    row: serve.row,
    onOpenRow: serve.openRow,
    onDismissRow: serve.dismissRow,
    focusRequest: serveFocusRequest,
    onFocusHandled: ackServeFocus,
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
      setSessionFilesOpen(sessionFilesDefaultOpen({ singleColumn, projectId: target }));
      app.newChat(agentId, target);
    },
    [app, singleColumn],
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

  // Sidebar の「設定」は onSelectMode("settings") を呼ぶため、モード切替も URL へ集約する。
  // チャットへ戻るのは backToChat と同じ経路 (現在の会話を載せて戻る)
  const selectMode = useCallback(
    (mode: SidebarMode) => {
      if (mode === "settings") {
        navigate({ view: "settings", section: lastSettingsSection });
        return;
      }
      backToChat();
    },
    [backToChat, navigate, lastSettingsSection],
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

  // コンテンツ生成のタブ切替も URL へ集約する (既定タブはパスへ出さない)
  const openContentSubsection = useCallback(
    (subsection: ContentSubsection) => {
      navigate(
        subsection === DEFAULT_CONTENT_SUBSECTION
          ? { view: "settings", section: "content" }
          : { view: "settings", section: "content", contentSubsection: subsection },
      );
    },
    [navigate],
  );

  // ファイルのタブ切替も URL へ集約する (既定タブはパスへ出さない)
  const openFilesSubsection = useCallback(
    (subsection: FilesSubsection) => {
      navigate(
        subsection === DEFAULT_FILES_SUBSECTION
          ? { view: "settings", section: "files" }
          : { view: "settings", section: "files", filesSubsection: subsection },
      );
    },
    [navigate],
  );

  // ランタイムのタブ切替も同じく URL へ集約する
  const openRuntimeSubsection = useCallback(
    (subsection: RuntimeSubsection) => {
      navigate(
        subsection === DEFAULT_RUNTIME_SUBSECTION
          ? { view: "settings", section: "runtime" }
          : { view: "settings", section: "runtime", runtimeSubsection: subsection },
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
    pinError: app.pinnedError,
    commitHash: app.health?.versions?.commitHash,
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
    moveSession: (sessionId: string) => {
      // タイトルは開いた時点の一覧から控える (移動後は一覧から消えるため)
      setMoveTarget({ sessionId, title: app.sessions.find((item) => item.sessionId === sessionId)?.title ?? "" });
    },
    togglePinned: (sessionId: string) => app.togglePinned(sessionId),
    deleteProject: (projectId: string) => {
      void app.deleteProject(projectId);
    },
    onNewProject: () => setProjectDialogOpen(true),
    onOpenSettingsSection: openSettingsSection,
  };

  // 表示方法だけを layout で分ける (desktop は右パネル、singleColumn は全画面シート)。設定 → ファイルは
  // ワークスペース root 固定なので、作業フォルダとは別の入口にする
  const filesPanelOpen = !singleColumn && filesRoot !== "" && sessionFilesOpen;
  const filesSheetOpen = singleColumn && filesRoot !== "" && sessionFilesSheetOpen;
  // 開閉の phase。閉じた後も退場アニメの間だけ mount を延ばし、CSS の再生と state の寿命を合わせる
  // (hooks/useExitPhase)。シートは dialog 自身がアニメを持つので、その ref も App が持つ
  const filesSheetRef = useRef<HTMLDialogElement | null>(null);
  const settingsViewRef = useRef<HTMLDivElement | null>(null);
  const filesPanelPhase = useExitPhase(filesPanelOpen, panelWidth.mainRef);
  const filesSheetPhase = useExitPhase(filesSheetOpen, filesSheetRef);
  const settingsPhase = useExitPhase(mainView === "settings", settingsViewRef);
  // 退場中はシートの見え方を固定する。key (root) が動くと dialog が作り直され、退場アニメが途中で切れる
  // (終了待ちの listener が外れた要素に残り、スライド中に中身も入れ替わる)。追従させる条件は lib/sheetView.ts
  const [sheetView, setSheetView] = useState<SheetView>(() => ({ root: filesRoot, mode: filesMode }));
  const nextView = nextSheetView(sheetView, { root: filesRoot, mode: filesMode }, filesSheetOpen, sheetScopeChanged);
  if (nextView !== null) setSheetView(nextView);
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

  // 設定ページは main を丸ごと使う (チャットとは排他)。singleColumn ではヘッダが SingleColumnBar の代わりになり、
  // 狭い desktop では左バーが overlay になるため、どちらも nav の導線をページへ渡す
  const pageProps = { singleColumn, onBack: backToChat, onOpenNav: sidebarDocked ? undefined : openNav };

  // 設定のセクション → 画面。case の書き忘れは default の `satisfies never` が型エラーにする
  // (client の tsconfig は noImplicitReturns が無いので、union を足しただけでは気付けない)
  const settingsScreen = () => {
    switch (settingsSection) {
      case "spaces":
        return <SpaceSettingsPage {...pageProps} onSelectSpace={openChatWithoutSession} />;
      case "agents":
        return (
          <AgentSettingsPage
            {...pageProps}
            catalog={app.catalog}
            agentId={app.agentId}
            refreshCatalog={refreshCatalog}
            applyAgentOrder={app.applyAgentOrder}
            modelOptions={app.health?.modelOptions ?? []}
            defaultModel={app.health?.model}
            defaultThinkingLevel={app.health?.defaultThinkingLevel}
          />
        );
      case "skills":
        return (
          <SkillSettingsPage
            {...pageProps}
            catalog={app.catalog}
            refreshCatalog={refreshCatalog}
            filePreviewPort={app.health?.filePreviewPort}
          />
        );
      case "files":
        // root を選択中の session / project に追随させると、選択を変えると同じ画面が別の場所を指して分かりにくい。
        // 設定のファイルはワークスペース全体に固定し、セッションの作業フォルダはツリーから辿って開く
        return (
          <FileTreePage
            {...pageProps}
            cwd=""
            rootCwd={app.health?.cwd}
            excludeNames={excludeNames}
            filePreviewPort={app.health?.filePreviewPort}
            archiveSettings={app.archiveSettings}
            filesSubsection={
              route.view === "settings" && route.section === "files"
                ? (route.filesSubsection ?? DEFAULT_FILES_SUBSECTION)
                : DEFAULT_FILES_SUBSECTION
            }
            onSelectFilesSubsection={openFilesSubsection}
          />
        );
      case "appearance":
        return <AppearancePage {...pageProps} />;
      case "models":
        // 最終使用の導出元は起動時から facade が持つ一覧。この画面だけに渡す (再取得はしない)
        return (
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
        );
      case "content":
        return (
          <ContentSettingsPage
            {...pageProps}
            contentSubsection={
              route.view === "settings" && route.section === "content"
                ? (route.contentSubsection ?? DEFAULT_CONTENT_SUBSECTION)
                : DEFAULT_CONTENT_SUBSECTION
            }
            onSelectContentSubsection={openContentSubsection}
          />
        );
      case "web-search":
        return <WebSearchSettingsPage {...pageProps} refreshCatalog={refreshCatalog} />;
      case "runtime":
        return (
          <RuntimePage
            {...pageProps}
            runtimeSubsection={
              route.view === "settings" && route.section === "runtime"
                ? (route.runtimeSubsection ?? DEFAULT_RUNTIME_SUBSECTION)
                : DEFAULT_RUNTIME_SUBSECTION
            }
            onSelectRuntimeSubsection={openRuntimeSubsection}
            health={app.health}
            onRefreshHealth={app.refreshHealth}
            sessions={app.sessions}
            openSessionId={app.sessionId}
            onOpenSession={(sessionId, spaceId) =>
              openOwnerSession(sessionId, spaceId, {
                spaces: space.spaces,
                currentSpaceId: space.selected.id,
                navigate,
                selectSpace: space.select,
                openInPlace: (id) => {
                  void app.selectSession(id, undefined, { fallbackOnFailure: false }).then((result) => {
                    const note = missingLinkNote(true, result);
                    if (note) app.dispatch({ type: "setActivity", text: note });
                  });
                  backToChat();
                },
              })
            }
          />
        );
      case "notifications":
        return <NotificationSettingsPage {...pageProps} notifications={app.notifications} />;
      default: {
        // 保存値も URL も SETTINGS_SECTIONS の既知の値だけを渡すため到達しない。
        // 空の設定画面を出すより、気付ける形で落とす
        settingsSection satisfies never;
        throw new Error(`未知の設定セクション: ${settingsSection}`);
      }
    }
  };

  // 診断の操作は設定 → ランタイムの診断タブのカードが使う。facade はここで 1 つだけ作るため、文脈で配る
  const shell = (
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
        // 開閉の列幅は .session-files-columns が持つ。ドラッグ中の幅はそのまま変数を書き換える
        data-open={filesPanelPhase === "open"}
        data-closing={filesPanelPhase === "closing"}
        className="session-files-columns grid min-h-0 min-w-0 grid-rows-1 overflow-hidden"
      >
        <div className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden">
          {/* 設定ページを開いている間もチャットは mount したまま (実行中のラン・SSE・入力中の下書き・
              スクロール位置を unmount で失わないため)。display は切らず、opacity と visibility だけを動かす。
              両方を 1 マスへ明示的に重ねる: display を切らないので auto 配置だと後から出た方が暗黙の 2 行目に
              落ち、隠れている側が場所を取り続ける (visibility はレイアウトを残す) */}
          <div
            data-visible={mainView === "chat"}
            // visibility: hidden は子の visibility: visible で上書きできるため、隠れている間は
            // 丸ごと inert にする (でなければ、非表示のチャットの中の操作要素が Tab で拾われる)
            inert={mainView !== "chat"}
            className={cn(
              "chat-view col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-1 overflow-hidden",
              emptyPortrait ? "chat-empty-portrait" : "grid-rows-[auto_minmax(0,1fr)_auto]",
            )}
          >
            {singleColumnMode ? (
              <SingleColumnBar
                serve={serveProps}
                mode={singleColumnMode}
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
                  singleColumn={singleColumn}
                  scope={scope}
                  suggestions={app.selectedAgent?.suggestions}
                  agentName={chatAgentName}
                  agentIcon={chatAgentIcon}
                  rootCwd={app.health?.cwd ?? ""}
                  cwd={app.cwd}
                  rawUrl={markdownImageRawUrl}
                  sessionId={app.sessionId}
                  sendSeq={app.chat.sendSeq}
                  onSuggestion={selectSuggestion}
                  onResendUnsent={handleResendUnsent}
                  onDiscardUnsent={handleDiscardUnsent}
                  onCancelQueued={handleCancelQueued}
                  answerable={app.chat.runStatus === "running"}
                  onAnswerQuestion={app.answerQuestion}
                  currentAssistantId={app.chat.currentAssistantId}
                  startingRunId={app.chat.startingRunId}
                  onStartFlashEnd={handleStartFlashEnd}
                  liveToolsPhase={liveTools.phase}
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
              runTools={app.chat.runTools}
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
              suggestion={suggestion}
              rootCwd={app.health?.cwd ?? ""}
              skills={app.sessionSkills}
              onSend={handleSend}
              onStop={handleStop}
              onCompact={app.sessionId ? handleCompact : undefined}
              runStatus={app.chat.runStatus}
              liveTools={liveTools}
              runError={app.chat.runError}
              onRetry={handleRetry}
              onAttachFiles={app.attachFiles}
              onRemoveAttachment={app.removeAttachment}
              onClearSuggestion={clearSuggestion}
              onChangeModel={app.changeModel}
              onChangeThinkingLevel={app.changeThinkingLevel}
              onReloadSkills={app.revalidateSessionSkills}
              onChangeAgent={handleAgentChange}
            />
            {emptyPortrait ? <div aria-hidden="true" className="min-h-0" /> : null}
          </div>
          {settingsPhase !== "closed" ? (
            // 設定ページはチャットと同じマスに重ねる。退場 phase の間は mount を保ち (inert で操作と読み上げから
            // 外す)、入るときは自身のアニメ、出るときはチャットのフェードアウトと同時に消える
            <div
              ref={settingsViewRef}
              data-closing={settingsPhase === "closing"}
              inert={settingsPhase === "closing"}
              className="settings-view col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-1"
            >
              {settingsScreen()}
            </div>
          ) : null}
        </div>
        {filesPanelPhase !== "closed" ? (
          <SessionFilesPanel
            key={filesRoot}
            phase={filesPanelPhase}
            root={filesRoot}
            rootCwd={app.health?.cwd}
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
      {filesSheetPhase !== "closed" ? (
        <SessionFilesSheet
          key={sheetView.root}
          dialogRef={filesSheetRef}
          phase={filesSheetPhase}
          root={sheetView.root}
          rootCwd={app.health?.cwd}
          envScope={envScope ?? {}}
          excludeNames={excludeNames}
          filePreviewPort={app.health?.filePreviewPort}
          runEndSeq={app.chat.runEndSeq}
          onClose={closeSessionFilesSheet}
          openRequest={pendingFileRef}
          onHandled={app.ackFileRef}
          mode={sheetView.mode}
          onBackToWork={backToWorkFiles}
          returnFocus={fileRefOriginRef.current}
        />
      ) : null}
      {/* overlay の左バーは docked の Sidebar と排他にする (docked へ戻ったフレームで両方を描かない)。
          閉じるのも NavSheet 側 (退場アニメの完了 → dialog の close) なので、App は閉じる要求を持たない */}
      {navOpen && !sidebarDocked ? <NavSheet {...navProps} onClose={closeNav} /> : null}
      {projectDialogOpen ? (
        <ProjectDialog singleColumn={singleColumn} onClose={closeProjectDialog} onCreate={handleCreateProject} />
      ) : null}
      {moveTarget ? (
        <SessionMoveDialog
          singleColumn={singleColumn}
          text={sessionMoveDialogText(moveTarget.title)}
          destinations={moveDestinationSpaces(space.spaces, space.selected.id)}
          onClose={closeMoveDialog}
          onMove={(targetSpaceId) => app.moveSession(moveTarget.sessionId, targetSpaceId)}
        />
      ) : null}
    </div>
  );

  return <DiagnosticsContext.Provider value={app.diagnostics}>{shell}</DiagnosticsContext.Provider>;
}
