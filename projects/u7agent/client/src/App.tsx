import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError, statFile } from "./api";
import { useSpace } from "./SpaceContext";
import { ActivityPage } from "./components/ActivityPage";
import { ChatArea } from "./components/ChatArea";
import { DiagnosticsContext } from "./DiagnosticsContext";
import { SingleColumnBar } from "./components/SingleColumnBar";
import { Composer } from "./components/Composer";
import { useConfirm } from "./components/ConfirmProvider";
import { NavSheet } from "./components/NavSheet";
import { ProjectDialog } from "./components/ProjectDialog";
import { SettingsScreen } from "./components/SettingsScreen";
import type { SettingsPageProps } from "./components/SettingsPageLayout";
import { Sidebar } from "./components/Sidebar";
import { SessionFilesPanel, SessionFilesSheet } from "./components/SessionFilesPanel";
import { SessionForkDialog } from "./components/SessionForkDialog";
import { SessionForkLinks } from "./components/SessionForkLinks";
import { SessionHandoffDialog } from "./components/SessionHandoffDialog";
import { SessionTitleDialog } from "./components/SessionTitleDialog";
import { SessionTitleNotice } from "./components/SessionTitleNotice";
import { Topbar } from "./components/Topbar";
import { FileRefProvider } from "./components/markdown/FileRefLink";
import { MarkdownImageProvider } from "./components/markdown/MarkdownImageRefs";
import { useU7Agent, type SendMessageOptions } from "./hooks/useU7Agent";
import { useElapsedMs } from "./hooks/useElapsedMs";
import { useExitPhase } from "./hooks/useExitPhase";
import { useLayoutMode } from "./hooks/useLayoutMode";
import { useMarkdownImageRawUrl } from "./hooks/useMarkdownImageRawUrl";
import { useRoute } from "./hooks/useRoute";
import { useSessionFilesPanelWidth } from "./hooks/useSessionFilesPanelWidth";
import { useSessionDialogs } from "./hooks/useSessionDialogs";
import { useSessionFilesFace } from "./hooks/useSessionFilesFace";
import { useSessionTitleNotice } from "./hooks/useSessionTitleNotice";
import { useSuggestionChip } from "./hooks/useSuggestionChip";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useVoiceInputAvailability } from "./hooks/useVoiceInputAvailability";
import { useViewportWidth } from "./hooks/useViewportWidth";
import { agentIconOf } from "./lib/agentIcon";
import { activityProgressCount } from "./lib/activity";
import { chatScope } from "./lib/chatScope";
import { cn } from "./lib/cn";
import { chatActionUnlessVoiceInput, type VoiceInputComposerPhase } from "./lib/voiceInput/composer";
import { compactConfirmRequest } from "./lib/compaction";
import { confirmTargetUnchanged } from "./lib/confirmDialog";
import { fileRefRequestForSession } from "./lib/fileRefRequest";
import type { FileRefTarget } from "./lib/fileRef";
import { classifyFileRefFailure, createFileRefOpener, fileRefCheckPath, type FileRefCheck } from "./lib/fileRefOpen";
import { resolveActivitySidebarPlacement, resolveSidebarPlacement } from "./lib/layout";
import { openOwnerSession } from "./lib/ownerLink";
import { queuedSendsOf } from "./lib/queueWait";
import { sessionPath, settingsTabRoute } from "./lib/route";
import {
  missingLinkNote,
  notificationHasFailure,
  notifyCannotEnable,
  notifyDeliverable,
  notifyUnavailableNote,
} from "./lib/notifications";
import { canShareSessionRoot, sessionFilesRoot } from "./lib/sessionFiles";
import { sessionEnvScope } from "./lib/sessionEnv";
import { sessionsInSpace } from "./lib/spaceSessions";
import { servedAppBusyKind, servedAppFocusRequest, servedAppStartConfirm, servedAppView } from "./lib/servedApp";
import { workdirBusyKind } from "./lib/sessionBusy";
import { shareRunBlockedReason } from "./lib/sharedContents";
import { handoffAgentChoices, sessionHandoffDialogText, type HandoffNote } from "./lib/sessionHandoff";
import { forkAgentChoices, forkRelations, sessionForkDialogText } from "./lib/sessionFork";
import { RUN_RETRY_PROMPT } from "./lib/runRetry";
import {
  DEFAULT_SHARING_SUBSECTION,
  type SettingsSection,
  type SettingsSubsection,
  type SettingsTabSection,
  type SidebarMode,
} from "./lib/settingsNav";
import { activityDisplay, retryRemainingMs } from "./lib/retryState";

export type AppProps = {
  /**
   * スペース切替をまたいで届いた引き継ぎの警告 (履歴の片付けが残った)。移動先の App は入口の解決が
   * 終わってから状態行へ出し、出したことを `onHandoffNoteShown` で知らせる。
   */
  handoffNote?: HandoffNote | null;
  /** 引き継ぎの警告をスペース切替をまたいで渡す (移動先の App が表示する) */
  onHandoffNote?: (note: HandoffNote) => void;
  /** 警告を状態行へ出し終えた (親は保持をやめる) */
  onHandoffNoteShown?: () => void;
};

export default function App({ handoffNote = null, onHandoffNote, onHandoffNoteShown }: AppProps = {}) {
  const space = useSpace();
  // 確認と入力のダイアログ。文言は各 lib の純関数で組み立てる (docs/ui-layout.md)
  const confirm = useConfirm();
  // 画面 (view) は URL がただ 1 つの正。`/` はチャット (会話を指定しない)、`/settings/<section>` は設定の各画面。
  // 会話の選択は app.sessionId が正で、`/s/<id>` はそれを映す鏡 (URL へ書く条件は lib/route.ts の sessionPath)
  const { route, navigate, syncSessionPath, lastSettingsSection } = useRoute(space.selected.id);
  const app = useU7Agent({ pendingSessionId: route.view === "chat" ? route.sessionId : undefined });
  // 確定した選択を URL へ映す唯一の Effect。書く条件 (設定の表示中 / 未解決の入口が未選択のまま) は
  // lib/route.ts の純関数が持ち、依存は primitive だけにする (route 全体を依存にすると新 object の
  // set でループする)
  const urlSessionId = route.view === "chat" ? route.sessionId : undefined;
  useEffect(() => {
    syncSessionPath(sessionPath(route.view, app.sessionId, app.entryResolved));
  }, [route.view, urlSessionId, app.sessionId, app.entryResolved, syncSessionPath]);
  const markdownImageRawUrl = useMarkdownImageRawUrl(app.chat.runEndSeq);
  // 入力欄のマイクの可用性。起動時に 1 回取得し、キーの保存 / 削除で取り直す
  const voiceInputAvailability = useVoiceInputAvailability();
  // 音声の操作中の phase。入力欄の送信は Composer が自分で止め、再実行 / 未送信の再送をここで止める
  const [voiceInputPhase, setVoiceInputPhase] = useState<VoiceInputComposerPhase>("idle");
  // desktop shell は幅と高さの両方が要る (lib/layout.ts)。足りない側で portrait / landscape を選ぶ
  const layout = useLayoutMode();
  const singleColumnMode = layout === "desktop" ? null : layout;
  const singleColumn = singleColumnMode !== null;
  // 左バーの置き方だけが変わる (中身はどちらも同じ Sidebar)。overlay は ☰ から開く
  const viewportWidth = useViewportWidth();
  // 実行状況は Issue / docs の 901px 以上で docked にする (チャットの 1200px 判定は変えない)。
  // overlay の帯 (641–900px と singleColumn) はモバイルヘッダなので、タップ領域を 44px 以上にする
  const activityPlacement = resolveActivitySidebarPlacement(viewportWidth, layout);
  const activityDocked = route.view === "activity" && activityPlacement === "docked";
  const compactTapTargets = activityPlacement === "overlay";
  const sidebarDocked = resolveSidebarPlacement(viewportWidth, layout) === "docked" || activityDocked;
  // 左バーの幅は docked のシェル (grid の 1 列目) が使う。overlay のドロワーは従来どおり固定幅
  const sidebarWidth = useSidebarWidth();
  // 右パネルの幅は main 列の残りで決まる (docked は左バーの実幅を引く。overlay は main = viewport)
  const panelWidth = useSessionFilesPanelWidth({
    viewportWidth,
    mainWidth: sidebarDocked ? viewportWidth - sidebarWidth.width : viewportWidth,
  });
  const mainView = route.view;
  // 一覧の state は全スペースで 1 本。サイドバー・モデルの最終使用・選択の移り先は、従来どおり
  // 現在のスペースだけを見る (現在スペースの一覧の意味を変えない)
  const spaceSessions = useMemo(
    () => sessionsInSpace(app.sessions, space.selected.id),
    [app.sessions, space.selected.id],
  );
  // 実行状況の入口に出す件数。全スペースの進行中で、未取得・取得失敗を 0 件と誤表示しない
  const activityCount = useMemo(() => activityProgressCount(app.sessions), [app.sessions]);
  const activityEntry = {
    active: route.view === "activity",
    count: app.sessionsFetch.loaded ? activityCount : undefined,
    stale: app.sessionsFetch.failed,
    compact: compactTapTargets,
    onOpen: () => navigate({ view: "activity" }),
  };
  // 再試行待機の残り時間表示。受信後の経過だけを毎秒測る (retryReceivedAt が無ければ tick しない)
  const retryElapsed = useElapsedMs(app.chat.retryReceivedAt);
  // 状態行に出す活動の文言と由来。再試行の文言で上書きしている間は run の由来を渡さない
  const activity = activityDisplay(
    app.chat.activity,
    app.chat.activityState,
    app.chat.retry,
    retryRemainingMs(app.chat.retryRemainingMs, retryElapsed),
  );
  // 待機中の送信。件数・順位・取り消しの正はこの配列 (ブロックは composer の直上)
  const queuedSends = useMemo(() => queuedSendsOf(app.chat.bubbles), [app.chat.bubbles]);
  // 作業先 (バーのチップ / 空状態の見出し)。未作成チャットは作成先、セッションはその所属が作業先になる
  const scope = chatScope({
    cwd: app.cwd,
    sessionId: app.sessionId,
    selectedProjectId: app.selectedProjectId,
    projects: app.projects,
    sessions: spaceSessions,
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
  // 入力欄のチップ (定型プロンプト / 引き継ぎの案内) と、選択を捨てる契機。下書きなので Composer ではなくここが持つ
  const suggestionChip = useSuggestionChip({
    agentId: app.selectedAgent?.id,
    selectionSeq: app.selectionSeqRef.current,
    sessionId: app.sessionId,
    handoff: app.chat.handoff,
  });
  const [navOpen, setNavOpen] = useState(false);
  // 作業フォルダの面 (desktop の右パネル / singleColumn の全画面シート) と、面ローカルの状態。
  // 閉じる契機の監視キーと、モードを既定へ戻す契機も面の側が持つ
  const filesFace = useSessionFilesFace({
    singleColumn,
    view: mainView,
    sessionId: app.sessionId,
    root: filesRoot,
    panelRef: panelWidth.mainRef,
    requestFileRef: app.requestFileRef,
  });
  // 配信できない設定で通知を On にしようとしたか。押した後だけ出す注記の根拠で、会話を移ったら捨てる
  const [notifyAttempted, setNotifyAttempted] = useState(false);
  // 押して On にした回数 (ベルの演出の世代)。会話の切替 / リロードで値が On に上がるだけでは進めない
  const [notifyRing, setNotifyRing] = useState(0);
  const sidebarMode: SidebarMode = route.view === "settings" ? "settings" : "nav";
  // URL にセクションが無いときだけ「最後に開いていたセクション」を見せる (URL の指定を上書きしない)
  const settingsSection: SettingsSection = route.view === "settings" ? route.section : lastSettingsSection;
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
    openFileRefTarget: filesFace.openTarget,
    sessionIdRef: app.sessionIdRef,
    fileRefSwitchSeq: app.fileRefSwitchSeq,
  });
  fileRefDepsRef.current = {
    checkFileRef,
    openFileRefTarget: filesFace.openTarget,
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
      filesFace.originRef.current = origin;
      return fileRefOpener.open(target);
    },
    [fileRefOpener, filesFace.originRef],
  );
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
      // モーダルが開いている間はその面が Escape を受ける (順序は 詳細 → ドロワー → チャット。
      // 設定の一覧 ⇄ 詳細はページが capture で受けるので、ここまで届かない)
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
  // 入力欄は定型プロンプトを結合する前の本文も渡す (一覧タイトルを固定文で埋めないため)
  const handleComposerSend = useCallback(
    (text: string, titleSource?: string) => {
      handleSend(text, titleSource === undefined ? undefined : { titleSource });
    },
    [handleSend],
  );

  const handleStop = useCallback(() => {
    void app.stopAgent();
  }, [app]);

  const handleRetry = useCallback(() => {
    // 録音の確定待ちに再実行を挟むと、確定テキストの入る先の会話が変わる
    chatActionUnlessVoiceInput(voiceInputPhase, () => {
      // 失敗の復旧も通常の送信経路に載せる (BFF から prompt() を再発行しない)。固定文言だけを送り、
      // 編集中の添付は送らず消費もしない
      handleSend(RUN_RETRY_PROMPT, { includeAttachments: false });
    });
  }, [handleSend, voiceInputPhase]);

  const handleResendUnsent = useCallback(
    (sendId: string) => {
      // 音声の操作中は会話を進めない（確定待ちのあとに別のターンが走らないようにする）
      chatActionUnlessVoiceInput(voiceInputPhase, () => void app.resendUnsent(sendId));
    },
    [app, voiceInputPhase],
  );

  const handleDiscardUnsent = useCallback(
    (sendId: string) => {
      void app.discardUnsent(sendId);
    },
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
  const activeSession = spaceSessions.find((item) => item.sessionId === app.sessionId);
  // 分岐元 / 分岐先のリンク。子一覧の API は足さず、同じスペースの一覧から parentSessionId で引く
  const forkLinkRelations = useMemo(
    () =>
      forkRelations(spaceSessions, {
        sessionId: app.sessionId,
        ...(activeSession?.parentSessionId ? { parentSessionId: activeSession.parentSessionId } : {}),
      }),
    [activeSession?.parentSessionId, app.sessionId, spaceSessions],
  );
  // 作業フォルダ自身の共有は非プロジェクト会話だけ (projectSession が明示的な false のときだけ出す)
  const sessionRootShareEnabled = canShareSessionRoot({
    sessionId: app.sessionId,
    projectSession: activeSession?.projectSession,
  });
  // 共有は「公開元の会話」か「同じ作業フォルダを共有する会話」が実行中なら押せない
  // (プロジェクト会話は cwd を共有するので兄弟会話も見る。判定の集合は lib/sessionBusy が正)
  const shareBlockedReason = shareRunBlockedReason(
    workdirBusyKind({
      selfStatus: app.chat.runStatus,
      sessionId: app.sessionId,
      projectId: activeSession?.projectId,
      sessions: spaceSessions,
    }),
  );

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
      sessions: spaceSessions,
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
  }, [app.chat.runStatus, app.sessionId, activeSession?.projectId, spaceSessions, app.serve, confirm]);
  const serveProps = {
    port: app.health?.previewPort,
    serviceOrigin: app.health?.serviceOrigin,
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
      filesFace.openForNewChat(target);
      app.newChat(agentId, target);
    },
    [app, filesFace.openForNewChat],
  );

  // セッション中のエージェントは作成時に固定される (定義は meta の promptSnapshot) ため、この入口は
  // 未作成チャットの選択だけ。作成先はそのチャットが持っている選択 (いまの作成先) をそのまま使う
  const handleAgentChange = useCallback(
    (agentId: string) => {
      handleNewChat(agentId, app.selectedProjectId);
    },
    [app.selectedProjectId, handleNewChat],
  );

  // 専用ダイアログ (プロジェクト / AI要約 / 分岐 / 引き継ぎ) の対象と、退場してから画面を移す順序
  const dialogs = useSessionDialogs({
    app,
    space,
    navigate,
    view: route.view,
    sessions: spaceSessions,
    backToChat,
    newChat: handleNewChat,
    onHandoffNote,
  });

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

  // 設定のタブ切替も URL へ集約する (既定タブはパスへ出さない)
  const openSettingsTab = useCallback(
    <S extends SettingsTabSection>(section: S, subsection: SettingsSubsection<S>) => {
      navigate(settingsTabRoute(section, subsection));
    },
    [navigate],
  );

  // 共有ダイアログの結果から 設定 → 共有 へ移る。ダイアログ自身は閉じるので、ここでは
  // singleColumn のシートだけを閉じる (設定面を modal が覆ったままにしない)
  const openSharingSettingsFromDialog = useCallback(() => {
    filesFace.closeSheet();
    openSettingsTab("sharing", DEFAULT_SHARING_SUBSECTION);
  }, [filesFace.closeSheet, openSettingsTab]);

  /**
   * 設定面のリンク（共有物の公開元 / ランタイムの起動元）から会話へ移る。所属が別スペースなら
   * 会話を URL に載せてから切り替える (切替は App ごと作り直すため順序を入れ替えない)。
   */
  const openSettingsSession = useCallback(
    (sessionId: string, spaceId?: string) => {
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
      });
    },
    [app, backToChat, navigate, space],
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

  // 移動先の App へ渡された引き継ぎの警告。入口 (`/s/<id>`) の解決が終わってから出す
  // (先に出すと、payload を適用する `resync` の初期化で消える)。解決までに別の会話へ移っていたら
  // 出さずに捨てる (関係ない会話の状態行に残さない)
  useEffect(() => {
    if (!handoffNote || !app.entryResolved) return;
    // 未選択 (= 開けずに新規チャットへ移った) か、対象の会話を開けていれば出す
    if (app.sessionId === "" || app.sessionId === handoffNote.sessionId) {
      app.dispatch({ type: "setActivity", text: handoffNote.text });
    }
    onHandoffNoteShown?.();
  }, [app.dispatch, app.entryResolved, app.sessionId, handoffNote, onHandoffNoteShown]);

  const navProps = {
    spaceName: space.selected.name,
    pinError: app.pinnedError,
    commitHash: app.health?.versions?.commitHash,
    conversationOnly: space.selected.id !== "default",
    activity: activityEntry,
    mode: sidebarMode,
    onSelectMode: selectMode,
    activeSettingsSection: settingsSection,
    // 設定ナビの ⚠。通知設定は facade が持つため、ページを開いていなくても反映される
    notificationsFailed: notificationHasFailure(app.notifications.settings),
    sessions: spaceSessions,
    sessionId: app.sessionId,
    agents: app.agents,
    projects: app.projects,
    // 実行状況からサイドバーの会話を選んだときは、選択だけで終わらせずチャットへ戻る (設定と違い
    // 会話の行が見えているため、選んでも画面が変わらないと操作が伝わらない)
    newChat: (agentId?: string, projectId?: string) => {
      handleNewChat(agentId, projectId);
      if (route.view !== "chat") navigate({ view: "chat" });
    },
    selectSession: (sessionId: string) => {
      if (sessionId !== app.sessionId) void app.selectSession(sessionId);
      if (route.view !== "chat") navigate({ view: "chat", sessionId });
    },
    renameSession: (sessionId: string) => {
      void app.renameSession(sessionId);
    },
    deleteSession: (sessionId: string) => {
      void app.deleteSession(sessionId);
    },
    forkSession: dialogs.openFork,
    clearHistory: (sessionId: string) => {
      void app.clearHistory(sessionId);
    },
    handoffSession: dialogs.openHandoff,
    togglePinned: (sessionId: string) => app.togglePinned(sessionId),
    onOpenTitleSummary: dialogs.openTitleSummary,
    deleteProject: (projectId: string) => {
      void app.deleteProject(projectId);
    },
    onNewProject: dialogs.openProject,
    onOpenSettingsSection: openSettingsSection,
  };

  // 設定 / 実行状況の退場 phase。閉じた後も退場アニメの間だけ mount を延ばし、CSS の再生と state の寿命を
  // 合わせる (hooks/useExitPhase)。作業フォルダの面の phase は filesFace が持つ
  const settingsViewRef = useRef<HTMLDivElement | null>(null);
  const activityViewRef = useRef<HTMLDivElement | null>(null);
  const settingsPhase = useExitPhase(mainView === "settings", settingsViewRef);
  // 実行状況も同じマスへ重ねる。退場アニメの間は mount を保ち、隠れた側は inert にする
  const activityPhase = useExitPhase(mainView === "activity", activityViewRef);
  // 画面を開いたときに一覧を取り直す (同じ一覧 state と取得制御を共有する。専用の state は作らない)
  const activityOpen = mainView === "activity";
  useEffect(() => {
    if (activityOpen) void app.refreshSessions();
  }, [activityOpen, app.refreshSessions]);
  // 未消費の要求は選択中セッションのときだけパネルへ渡す (セッションが変われば useSessions が破棄する)。
  // 面へ渡すのは 1 つの要求で、自分宛ての種別だけを適用する (面のモードは要求の種別で切り替える)
  const pendingFileRef = fileRefRequestForSession(app.fileRefRequest, app.sessionId);
  // ツリーの行のダウンロードの出し分け。取得前は空 = 導線を出し、実際の拒否はサーバーの check に任せる
  const excludeNames = app.archiveSettings.settings?.excludeNames ?? [];

  // 会話が無いときだけ「新しい会話」と言い切る (一覧が未取得でも sessionId は確定している)
  const barTitle = app.sessionId ? activeSession?.title || "無題のセッション" : "新しい会話";
  const barAgentName = activeSession?.agentName || app.selectedAgent?.name;
  // 会話の AI 要約が終わった瞬間だけ、チャット上に 1 回だけ知らせる (常設のバッジは置かない)
  const { notice: sessionTitleNotice, dismiss: dismissSessionTitleNotice } = useSessionTitleNotice({
    sessionId: app.sessionId,
    title: app.chat.title,
    titleSummary: app.chat.titleSummary,
  });
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
  const pageProps: SettingsPageProps = {
    singleColumn,
    onBack: backToChat,
    onOpenNav: sidebarDocked ? undefined : openNav,
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
        data-open={filesFace.panelPhase === "open"}
        data-closing={filesFace.panelPhase === "closing"}
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
            <div>
              {singleColumnMode ? (
                <SingleColumnBar
                  serve={serveProps}
                  mode={singleColumnMode}
                  title={barTitle}
                  agentName={barAgentName}
                  scope={scope}
                  runtimeStatus={app.runtimeStatus}
                  notify={notifyToggle}
                  sessionFiles={filesRoot ? { open: filesFace.sheetOpen, onToggle: filesFace.toggle } : undefined}
                  activity={activityEntry}
                  onOpenNav={openNav}
                />
              ) : (
                <Topbar
                  serve={serveProps}
                  scope={scope}
                  runtimeStatus={app.runtimeStatus}
                  notify={notifyToggle}
                  sessionFiles={filesRoot ? { open: filesFace.panelOpen, onToggle: filesFace.toggle } : undefined}
                  nav={sidebarDocked ? undefined : { onOpen: openNav }}
                  activity={sidebarDocked ? undefined : activityEntry}
                />
              )}
              {app.sessionId ? (
                <SessionForkLinks
                  relations={forkLinkRelations}
                  onOpen={(sessionId) => {
                    if (sessionId !== app.sessionId) void app.selectSession(sessionId);
                    if (route.view !== "chat") navigate({ view: "chat", sessionId });
                  }}
                />
              ) : null}
              {sessionTitleNotice ? (
                <div className="px-6 pb-3 singleColumn:px-3">
                  <SessionTitleNotice
                    notice={sessionTitleNotice}
                    onOpen={() => dialogs.openTitleSummary(app.sessionId)}
                    onDismiss={dismissSessionTitleNotice}
                  />
                </div>
              ) : null}
            </div>
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
                  prompts={app.selectedAgent?.prompts}
                  agentName={chatAgentName}
                  agentIcon={chatAgentIcon}
                  modelOptions={app.health?.modelOptions}
                  rootCwd={app.health?.cwd ?? ""}
                  cwd={app.cwd}
                  rawUrl={markdownImageRawUrl}
                  sessionId={app.sessionId}
                  sendSeq={app.chat.sendSeq}
                  onSuggestion={suggestionChip.select}
                  onResendUnsent={handleResendUnsent}
                  onDiscardUnsent={handleDiscardUnsent}
                  answerable={app.chat.runStatus === "running"}
                  onAnswerQuestion={app.answerQuestion}
                  networkAccess={app.chat.networkAccess}
                  onApproveNetworkAccess={app.approveNetworkAccess}
                  currentAssistantId={app.chat.currentAssistantId}
                  startingRunId={app.chat.startingRunId}
                  onStartFlashEnd={handleStartFlashEnd}
                />
              </MarkdownImageProvider>
            </FileRefProvider>
            <Composer
              visible={mainView === "chat"}
              voiceInputAvailable={voiceInputAvailability.shown}
              voiceInputModel={voiceInputAvailability.model}
              voiceInputScope={app.sessionId}
              onVoiceInputPhaseChange={setVoiceInputPhase}
              activity={activity.text}
              activityState={activity.state}
              thinkingText={app.chat.thinkingText}
              notice={app.chat.notice}
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
              suggestion={suggestionChip.active}
              rootCwd={app.health?.cwd ?? ""}
              skills={app.sessionSkills}
              onSend={handleComposerSend}
              onStop={handleStop}
              onCompact={app.sessionId ? handleCompact : undefined}
              runStatus={app.chat.runStatus}
              runError={app.chat.runError}
              onRetry={handleRetry}
              onAttachFiles={app.attachFiles}
              onRemoveAttachment={app.removeAttachment}
              onClearSuggestion={suggestionChip.clear}
              onChangeModel={app.changeModel}
              onChangeThinkingLevel={app.changeThinkingLevel}
              onReloadSkills={app.revalidateSessionSkills}
              onChangeAgent={handleAgentChange}
              queuedSends={queuedSends}
              onCancelQueued={app.cancelQueued}
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
              <SettingsScreen
                section={settingsSection}
                route={route}
                page={pageProps}
                app={app}
                sessions={spaceSessions}
                refreshCatalog={refreshCatalog}
                excludeNames={excludeNames}
                onOpenTab={openSettingsTab}
                onOpenSession={openSettingsSession}
                onSelectSpace={openChatWithoutSession}
                onVoiceInputKeyChanged={voiceInputAvailability.reload}
              />
            </div>
          ) : null}
          {activityPhase !== "closed" ? (
            <div
              ref={activityViewRef}
              data-closing={activityPhase === "closing"}
              inert={activityPhase === "closing"}
              className="activity-view col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-1"
            >
              <ActivityPage
                sessions={app.sessions}
                projects={app.projects}
                spaces={space.spaces}
                fetch={app.sessionsFetch}
                onReload={app.reloadSessions}
                onBack={backToChat}
                onOpenNav={sidebarDocked ? undefined : openNav}
                compact={compactTapTargets}
                previewPort={app.health?.previewPort}
                serviceOrigin={app.health?.serviceOrigin}
                hostname={location.hostname}
              />
            </div>
          ) : null}
        </div>
        {filesFace.panelPhase !== "closed" ? (
          <SessionFilesPanel
            key={filesRoot}
            phase={filesFace.panelPhase}
            root={filesRoot}
            rootCwd={app.health?.cwd}
            envScope={envScope ?? {}}
            excludeNames={excludeNames}
            filePreviewPort={app.health?.filePreviewPort}
            filePreviewOrigin={app.health?.filePreviewOrigin}
            runEndSeq={app.chat.runEndSeq}
            shareBlockedReason={shareBlockedReason}
            onOpenSharingSettings={openSharingSettingsFromDialog}
            onClose={filesFace.closePanel}
            openRequest={pendingFileRef}
            onHandled={app.ackFileRef}
            mode={filesFace.mode}
            onBackToWork={filesFace.backToWork}
            sessionTitle={activeSession?.title}
            canShareSessionRoot={sessionRootShareEnabled}
            projectSession={activeSession?.projectSession}
            resize={panelWidth}
          />
        ) : null}
      </main>
      {filesFace.sheetPhase !== "closed" ? (
        <SessionFilesSheet
          key={filesFace.sheetView.root}
          dialogRef={filesFace.sheetRef}
          phase={filesFace.sheetPhase}
          root={filesFace.sheetView.root}
          rootCwd={app.health?.cwd}
          envScope={envScope ?? {}}
          excludeNames={excludeNames}
          filePreviewPort={app.health?.filePreviewPort}
          filePreviewOrigin={app.health?.filePreviewOrigin}
          runEndSeq={app.chat.runEndSeq}
          shareBlockedReason={shareBlockedReason}
          onOpenSharingSettings={openSharingSettingsFromDialog}
          onClose={filesFace.closeSheet}
          openRequest={pendingFileRef}
          onHandled={app.ackFileRef}
          mode={filesFace.sheetView.mode}
          onBackToWork={filesFace.backToWork}
          sessionTitle={activeSession?.title}
          canShareSessionRoot={sessionRootShareEnabled}
          projectSession={activeSession?.projectSession}
          returnFocus={filesFace.originRef.current}
        />
      ) : null}
      {/* overlay の左バーは docked の Sidebar と排他にする (docked へ戻ったフレームで両方を描かない)。
          閉じるのも NavSheet 側 (退場アニメの完了 → dialog の close) なので、App は閉じる要求を持たない */}
      {navOpen && !sidebarDocked ? <NavSheet {...navProps} onClose={closeNav} /> : null}
      {dialogs.projectOpen ? (
        <ProjectDialog singleColumn={singleColumn} onClose={dialogs.closeProject} onCreate={dialogs.createProject} />
      ) : null}
      {dialogs.titleSummaryTarget ? (
        <SessionTitleDialog
          sessionId={dialogs.titleSummaryTarget.sessionId}
          title={
            dialogs.titleSummaryTarget.sessionId === app.sessionId
              ? app.chat.title || dialogs.titleSummaryTarget.title
              : dialogs.titleSummaryTarget.title
          }
          titleSummary={
            dialogs.titleSummaryTarget.sessionId === app.sessionId
              ? (app.chat.titleSummary ?? dialogs.titleSummaryTarget.titleSummary)
              : dialogs.titleSummaryTarget.titleSummary
          }
          onClose={dialogs.closeTitleSummary}
          onOpenSettings={() => {
            dialogs.closeTitleSummary();
            openSettingsSection("session-title");
          }}
          onUpdated={() => void app.refreshSessions()}
        />
      ) : null}
      {dialogs.forkTarget ? (
        <SessionForkDialog
          singleColumn={singleColumn}
          text={sessionForkDialogText(dialogs.forkTarget.title)}
          agents={forkAgentChoices(app.agents, dialogs.forkTarget.agentId, dialogs.forkTarget.agentName)}
          blockedNote={dialogs.forkTarget.blockedNote}
          onClose={dialogs.closeFork}
          onFork={dialogs.handleFork}
        />
      ) : null}
      {dialogs.handoffTarget ? (
        <SessionHandoffDialog
          singleColumn={singleColumn}
          text={sessionHandoffDialogText(dialogs.handoffTarget.title, dialogs.handoffTarget.projectSession)}
          agents={handoffAgentChoices(app.agents, dialogs.handoffTarget.agentId, dialogs.handoffTarget.agentName)}
          spaces={space.spaces}
          currentSpaceId={space.selected.id}
          projectSession={dialogs.handoffTarget.projectSession}
          memoDisabledReason={dialogs.handoffTarget.memoDisabledReason}
          blockedNote={dialogs.handoffTarget.blockedNote}
          onClose={dialogs.closeHandoff}
          onHandoff={dialogs.handleHandoff}
        />
      ) : null}
    </div>
  );

  return <DiagnosticsContext.Provider value={app.diagnostics}>{shell}</DiagnosticsContext.Provider>;
}
