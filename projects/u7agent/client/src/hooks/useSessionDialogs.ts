import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateProjectInput } from "../api/sessions";
import type { SpaceContextValue } from "../SpaceContext";
import { missingLinkNote } from "../lib/notifications";
import { openOwnerSession } from "../lib/ownerLink";
import { ownerLinkSpace } from "../lib/spaceSelection";
import { forkBlockedReason, forkOpenDecision, type SessionForkRequest } from "../lib/sessionFork";
import {
  handoffBlockedReason,
  handoffCleanupNote,
  handoffMemoDisabledReason,
  type HandoffNote,
} from "../lib/sessionHandoff";
import type { SessionHandoffRequest } from "../components/SessionHandoffDialog";
import type { Route } from "../lib/route";
import type { U7Agent } from "./useU7Agent";
import type { SessionSummary } from "../types";

/** 引き継ぎの対象 (会話 id と、ダイアログに出す値)。開いている間は専用ダイアログがエージェント / スペース / メモを選ぶ */
export type SessionHandoffTarget = {
  sessionId: string;
  title: string;
  agentId: string;
  agentName: string;
  projectSession: boolean;
  memoDisabledReason: string;
  blockedNote: string;
};

/** 分岐の対象 (会話 id と、ダイアログに出す値)。ダイアログはエージェントだけを選び、スペース・作業フォルダ・添付は親から決まる */
export type SessionForkTarget = {
  sessionId: string;
  title: string;
  agentId: string;
  agentName: string;
  blockedNote: string;
};

export type UseSessionDialogsParams = {
  app: U7Agent;
  space: SpaceContextValue;
  navigate: (route: Route) => void;
  /** 現在の画面。分岐した子を開くときにチャット以外からなら URL も移す */
  view: Route["view"];
  /** 現在のスペースの会話一覧。対象の無効理由は開いた時点のこの一覧から導く */
  sessions: SessionSummary[];
  /** 設定 ⇄ チャットの往復と同じ経路。ダイアログの後に会話へ戻るときに使う */
  backToChat: () => void;
  /** 新規会話の入口 (プロジェクトの追加後はそのプロジェクトで始める) */
  newChat: (agentId?: string, projectId?: string) => void;
  /** 引き継ぎの警告を、スペース切替をまたいで渡す (移動先の App が表示する) */
  onHandoffNote?: (note: HandoffNote) => void;
};

export type SessionDialogs = {
  projectOpen: boolean;
  openProject: () => void;
  closeProject: () => void;
  /** 失敗は throw してフォームに出す。成功後はダイアログの退場を待って、そのプロジェクトの新規会話へ入る */
  createProject: (input: CreateProjectInput) => Promise<unknown>;
  /** AI要約のダイアログの対象。会話の削除 / スペース切替で消えたら閉じる */
  titleSummaryTarget: SessionSummary | undefined;
  openTitleSummary: (sessionId: string) => void;
  closeTitleSummary: () => void;
  forkTarget: SessionForkTarget | null;
  openFork: (sessionId: string) => void;
  closeFork: () => void;
  handleFork: (request: SessionForkRequest) => Promise<void>;
  handoffTarget: SessionHandoffTarget | null;
  openHandoff: (sessionId: string) => void;
  closeHandoff: () => void;
  handleHandoff: (request: SessionHandoffRequest) => Promise<void>;
};

/**
 * 専用ダイアログ (プロジェクト / AI要約 / 分岐 / 引き継ぎ) の対象と、退場してから画面を移す順序。
 * 対象は開いた時点の一覧から導き、操作の結果で画面を移すのは退場アニメの後 (退場中に切り替えると面ごと消える)。
 * ダイアログを閉じる導線はすべて `runAfterClose` を通す。
 */
export function useSessionDialogs({
  app,
  space,
  navigate,
  view,
  sessions,
  backToChat,
  newChat,
  onHandoffNote,
}: UseSessionDialogsParams): SessionDialogs {
  const [projectOpen, setProjectOpen] = useState(false);
  const [titleSummaryTargetId, setTitleSummaryTargetId] = useState<string | null>(null);
  const [forkTarget, setForkTarget] = useState<SessionForkTarget | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<SessionHandoffTarget | null>(null);
  // 操作に成功した後の画面移動。控えるのは操作の完了時で、実行するのは閉じる導線から
  const afterDialogCloseRef = useRef<(() => void) | null>(null);
  const runAfterClose = useCallback((close: () => void) => {
    const after = afterDialogCloseRef.current;
    afterDialogCloseRef.current = null;
    close();
    after?.();
  }, []);

  const openProject = useCallback(() => setProjectOpen(true), []);
  const closeProject = useCallback(() => runAfterClose(() => setProjectOpen(false)), [runAfterClose]);
  const createProject = useCallback(
    async (input: CreateProjectInput) => {
      const project = await app.createProject(input);
      // 新しい会話へ入るのは、追加のダイアログが閉じ切ってから (退場の後ろへ回す)
      afterDialogCloseRef.current = () => newChat(undefined, project.id);
      return project;
    },
    [app, newChat],
  );

  const openTitleSummary = useCallback((sessionId: string) => setTitleSummaryTargetId(sessionId), []);
  const closeTitleSummary = useCallback(() => setTitleSummaryTargetId(null), []);
  const titleSummaryTarget = titleSummaryTargetId
    ? sessions.find((item) => item.sessionId === titleSummaryTargetId)
    : undefined;
  // 会話の削除 / スペース切替で対象が消えたらダイアログを閉じる
  useEffect(() => {
    if (titleSummaryTargetId && !titleSummaryTarget) setTitleSummaryTargetId(null);
  }, [titleSummaryTarget, titleSummaryTargetId]);

  const openFork = useCallback(
    (sessionId: string) => {
      const item = sessions.find((entry) => entry.sessionId === sessionId);
      setForkTarget({
        sessionId,
        title: item?.title ?? "",
        agentId: item?.agentId ?? "",
        agentName: item?.agentName ?? "",
        blockedNote: item ? forkBlockedReason(item) : "会話が見つかりません",
      });
    },
    [sessions],
  );
  const closeFork = useCallback(() => runAfterClose(() => setForkTarget(null)), [runAfterClose]);

  /**
   * 分岐の実行。子は同じスペースにできるため、成功したら子を開く (URL は選択に追従する)。
   * 要求を出した後に利用者が別の会話を選んでいたら、遅れて届いた応答でその選択を巻き戻さない。
   */
  const handleFork = useCallback(
    async (request: SessionForkRequest) => {
      const sessionId = forkTarget?.sessionId;
      if (!sessionId) return;
      const selection = app.selectionSeqRef.current;
      const child = await app.forkSession(sessionId, request);
      if (forkOpenDecision(selection, app.selectionSeqRef.current) === "keep") return;
      // 子を開くのは分岐のダイアログが閉じ切ってから (退場の後ろへ回す)
      afterDialogCloseRef.current = () => {
        void app.selectSession(child.sessionId);
        if (view !== "chat") navigate({ view: "chat", sessionId: child.sessionId });
      };
    },
    [app, forkTarget, navigate, view],
  );

  const openHandoff = useCallback(
    (sessionId: string) => {
      const item = sessions.find((entry) => entry.sessionId === sessionId);
      setHandoffTarget({
        sessionId,
        title: item?.title ?? "",
        agentId: item?.agentId ?? "",
        agentName: item?.agentName ?? "",
        projectSession: item?.projectSession === true,
        memoDisabledReason: handoffMemoDisabledReason(item?.messageCount ?? 0),
        blockedNote: item ? handoffBlockedReason(item) : "会話が見つかりません",
      });
    },
    [sessions],
  );
  const closeHandoff = useCallback(() => runAfterClose(() => setHandoffTarget(null)), [runAfterClose]);

  /**
   * 引き継ぎの実行。成功したら移動先のスペースへ切り替えて、引き継ぎ後の会話を開き直す。
   * 切替は設定 → ランタイムの起動元リンクと同じ経路 (`openOwnerSession`) を使い、
   * 同じスペースなら切り替えずに開き直す。履歴は同じ id のまま入れ替わるため、開き直しでは
   * 旧バブルを捨てる (`discardHistory`)。
   */
  const handleHandoff = useCallback(
    async (request: SessionHandoffRequest) => {
      const sessionId = handoffTarget?.sessionId;
      if (!sessionId) return;
      const result = await app.handoffSession(sessionId, request);
      const note = handoffCleanupNote(result, sessionId);
      // 別スペースへ切り替えると配下の App は作り直される。この App の状態行へ出しても消えるため、
      // 結果を親 (SpacesApp) へ渡し、移動先の App が入口の解決の後に出す
      const switching = ownerLinkSpace(result.spaceId, space.selected.id, space.spaces) !== undefined;
      // 別スペースへの切替は SpacesApp の配下を作り直すため、退場の後ろへ回す (先に切り替えると面が消える)。
      // 警告は切替と同じ描画で渡す (先に渡すと移動元の App が消費し、移動先に出ない)
      afterDialogCloseRef.current = () => {
        if (note && switching) onHandoffNote?.(note);
        openOwnerSession(sessionId, result.spaceId, {
          spaces: space.spaces,
          currentSpaceId: space.selected.id,
          navigate,
          selectSpace: space.select,
          openInPlace: (id) => {
            // 開き直しで履歴を読み直す。片付けが残った応答では、開けなかったときもその警告を優先して出す
            void app.selectSession(id, undefined, { fallbackOnFailure: false, discardHistory: true }).then((opened) => {
              const text = note?.text ?? missingLinkNote(true, opened);
              if (text) app.dispatch({ type: "setActivity", text });
            });
            backToChat();
          },
        });
      };
    },
    [app, backToChat, handoffTarget, navigate, onHandoffNote, space],
  );

  return {
    projectOpen,
    openProject,
    closeProject,
    createProject,
    titleSummaryTarget,
    openTitleSummary,
    closeTitleSummary,
    forkTarget,
    openFork,
    closeFork,
    handleFork,
    handoffTarget,
    openHandoff,
    closeHandoff,
    handleHandoff,
  };
}
