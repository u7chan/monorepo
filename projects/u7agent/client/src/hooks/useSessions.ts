import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { Dispatch, RefObject } from "react";
import {
  ApiError,
  createSession,
  deleteSession as apiDeleteSession,
  getSession,
  listSessions,
  updateSessionNotify,
  updateSessionSettings,
} from "../api";
import { adoptKnownAgentId } from "../lib/agentSelection";
import { createFileRefRequests } from "../lib/fileRefRequest";
import type { AgentDef, EventEntry, Health, ModelRef, SessionPayload, SessionSummary, ThinkingLevel } from "../types";
import type { ChatAction } from "./chatReducer";
import { createRequestGate } from "./requestGate";
import { createNotifyCarry, toggleNotify as applyNotifyToggle } from "./notifyToggle";
import { createSessionCreation } from "./sessionCreation";
import { applySessionEvent } from "./sessionStream";
import { applySettingsChange, type SettingsSelection } from "./settingsChange";
import { nextAfterFailure } from "./sessionFallback";
import { useSessionEvents } from "./useSessionEvents";
import { runtimeStatusForError, type RuntimeStatus } from "./runtimeStatus";

const SESSION_KEY = "u7agent-session";
const alwaysCurrent = () => true;

/** 開けなかった理由。サーバーの 409 は「どのファイルが壊れているか」を含む */
function sessionOpenFailureText(error: unknown): string {
  return error instanceof ApiError ? error.message : "セッションを開けませんでした";
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UseSessionsParams = {
  dispatch: Dispatch<ChatAction>;
  agentId: string;
  agents: AgentDef[];
  setAgentId: (id: string) => void;
  selectProject: (id: string) => void;
  /** state の反映を待たず読む (ensureSession が送信時に参照) */
  selectedProjectIdRef: RefObject<string>;
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

/**
 * 通知のリンク (`/s/<id>`) の入口。sessionId だけでなく、一覧の要求より前の選択世代も持つ
 * (待機中にユーザーが別の会話を選んでいたら、その選択を奪わないため)。
 */
export type PendingEntry = {
  sessionId: string;
  selection: number;
};

export function useSessions({
  dispatch,
  agentId,
  agents,
  setAgentId,
  selectProject,
  selectedProjectIdRef,
  refreshHealth,
  setRuntimeStatus,
}: UseSessionsParams) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem(SESSION_KEY) || "");
  const [cwd, setCwd] = useState<string>("");
  const [settingsChanging, setSettingsChanging] = useState(false);
  const [preselection, setPreselection] = useState<SettingsSelection>({});
  const [epoch, setEpoch] = useState(0);

  const lastSeqRef = useRef(0);
  /** SSE の世代。payload (snapshot / resync) から更新する */
  const generationRef = useRef("");
  /** newChat / selectSession で選択が変わった世代 (作成待ちの応答で選択を奪わないため) */
  const selectionSeqRef = useRef(0);
  const [sessionCreation] = useState(() => createSessionCreation<string>());
  // ファイル参照の要求。seq の単調増加と pending を store が持ち、破棄は選択が変わる各経路で行う
  const [fileRefRequests] = useState(createFileRefRequests);
  const fileRefRequest = useSyncExternalStore(fileRefRequests.subscribe, fileRefRequests.snapshot);
  // sessionIdRef / sessionsRef は選択・一覧の最新値。await を挟む処理と SSE の適用が state を待たずに読む
  const sessionIdRef = useRef(sessionId);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const preselectionRef = useRef<SettingsSelection>(preselection);
  preselectionRef.current = preselection;
  // 新規チャットの通知の先行選択。セッション未作成の間だけ持ち、作成の要求時に読む
  const [notifyCarry] = useState(createNotifyCarry);
  const notifyPending = useSyncExternalStore(notifyCarry.subscribe, notifyCarry.snapshot);

  const [beginSessionsRequest] = useState(createRequestGate);
  const refreshSessions = useCallback(
    async (isCurrent = alwaysCurrent): Promise<SessionSummary[]> => {
      const canApply = beginSessionsRequest(isCurrent);
      try {
        const { sessions: list } = await listSessions();
        if (!canApply()) return list;
        sessionsRef.current = list;
        setSessions(list);
        return list;
      } catch {
        // サーバーが一時的に届かないときは前回のリストを保持
        return sessionsRef.current;
      }
    },
    [beginSessionsRequest],
  );

  const applySnapshot = useCallback(
    (payload: SessionPayload) => {
      lastSeqRef.current = payload.lastSeq || 0;
      generationRef.current = payload.eventGeneration || "";
      // 表示する cwd は payload.cwd (root 相対) だけを正とする。health.cwd は root の絶対パスで、
      // ファイル画面の tree root (= GET /api/files の path) とは単位が違う
      setCwd(payload.cwd || "");
      dispatch({ type: "resync", payload });
    },
    [dispatch],
  );

  const applySelectedSession = useCallback(
    (payload: SessionPayload) => {
      // 切替待機中に旧セッションの本文から作られた要求を、確定時にも落とす (開始時の破棄だけでは残る)
      if (sessionIdRef.current !== payload.sessionId) fileRefRequests.clear();
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      localStorage.setItem(SESSION_KEY, payload.sessionId);
      // 復元したセッションの agent はカタログに無いことがある (削除済み / ID 変更)。
      // 選択に残すと次のセッション作成が 400 になるので、既知のときだけ採用する
      const snapshotAgentId = adoptKnownAgentId(agents, payload.agent?.id, agentId);
      if (snapshotAgentId !== agentId) setAgentId(snapshotAgentId);
      applySnapshot(payload);
      setEpoch((e) => e + 1); // lastSeq を更新してから SSE を張り直す
    },
    [agentId, agents, applySnapshot, fileRefRequests, setAgentId],
  );

  const applyNotify = useCallback((id: string, notify: boolean): void => {
    // await を挟む処理 (連打の 2 回目) が古い値を読まないよう、ref と state を同時に更新する
    sessionsRef.current = sessionsRef.current.map((item) => (item.sessionId === id ? { ...item, notify } : item));
    setSessions((prev) => prev.map((item) => (item.sessionId === id ? { ...item, notify } : item)));
  }, []);

  const selectSession = useCallback(
    async (id: string, isCurrent = alwaysCurrent): Promise<void> => {
      // getSession の待機中にセッション作成が返っても、この選択を奪わせない
      const selection = (selectionSeqRef.current += 1);
      // 選択が変わったら旧セッションの要求を持ち越さない (同じ ID に戻っても復活させない)
      fileRefRequests.clear();
      // 破損などで開けないセッションが複数あると、代わりの候補が互いを指して往復し続ける。
      // この連鎖で試した id を覚え、一覧を 1 周したら未作成チャットへ落とす
      const failed = new Set<string>();
      let pending: string | undefined = id;
      while (pending) {
        failed.add(pending);
        try {
          const payload = await getSession(pending);
          if (!isCurrent()) return;
          // 待機中に別の会話が選ばれたら、古い応答でその選択を奪わない (適用するのは最後の選択だけ)
          if (selectionSeqRef.current !== selection) return;
          applySelectedSession(payload);
          void refreshHealth(isCurrent);
          return;
        } catch (error) {
          if (!isCurrent()) return;
          // 待機中に別の会話が選ばれていたら、この失敗でその表示を壊さない
          if (selectionSeqRef.current !== selection) return;
          localStorage.removeItem(SESSION_KEY);
          sessionIdRef.current = "";
          setSessionId("");
          const next = nextAfterFailure(sessionsRef.current, failed);
          if (next.kind === "newChat") {
            newChatRef.current();
            // 開けなかった理由を状態行へ出す (サーバーの 409 は壊れているファイルを含む)
            dispatch({ type: "setActivity", text: sessionOpenFailureText(error) });
            return;
          }
          pending = next.sessionId;
        }
      }
    },
    [applySelectedSession, dispatch, fileRefRequests, refreshHealth],
  );

  const newChat = useCallback(
    (nextAgentId?: string, nextProjectId?: string): void => {
      // 未作成チャットで選んだ agent は、最初の送信で作るセッションの初期値になる
      if (nextAgentId) setAgentId(nextAgentId);
      // 作成先を先に移し、その後の表示と送信先を一致させる
      if (nextProjectId !== undefined) selectProject(nextProjectId);
      selectionSeqRef.current += 1;
      fileRefRequests.clear();
      // 進行中の作成を持ち越さない (新しい会話が前のセッションを掴まないようにする)
      sessionCreation.clear();
      localStorage.removeItem(SESSION_KEY);
      sessionIdRef.current = "";
      lastSeqRef.current = 0;
      setSessionId("");
      // 未作成チャットの作業場所は選択中プロジェクト。前のセッションの cwd を持ち越さない
      setCwd("");
      dispatch({ type: "newChat" });
    },
    [dispatch, fileRefRequests, selectProject, setAgentId, sessionCreation],
  );

  // selectSession ↔ newChat の相互参照用
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;

  const requestFileRef = useCallback(
    (path: string) => {
      fileRefRequests.request(sessionIdRef.current, path);
    },
    [fileRefRequests],
  );

  const ackFileRef = useCallback(
    (seq: number) => {
      fileRefRequests.ack(seq);
    },
    [fileRefRequests],
  );

  const ensureSession = useCallback(async (): Promise<string> => {
    const existing = sessionIdRef.current;
    if (existing) return existing;
    // 同時アップロード / 送信でセッションを二重に作らない (作成中の Promise を共有する)
    return sessionCreation.start(async () => {
      const selection = selectionSeqRef.current;
      // 作成前の選択をリクエストへ乗せ、初期値の解決はサーバーに任せる。未所属 ("") はキーを送らず root に任せる
      const projectId = selectedProjectIdRef.current;
      // 新規チャットの通知トグルは作成要求の時点で読み切る (応答待ちの切替はこの作成に反映しない)
      const notify = notifyCarry.snapshot();
      const session = await createSession(agentId || undefined, {
        ...preselectionRef.current,
        notify,
        ...(projectId ? { projectId } : {}),
      });
      setPreselection({});
      // 先行選択は作成の成否と選択の変更に関わらず消費する (次の新規チャットへ持ち越さない)
      notifyCarry.consume();
      // 応答中にユーザーが別のチャットへ切り替えていたら、その選択を奪わず送信先だけを返す
      if (selectionSeqRef.current !== selection) return session.sessionId;
      applySelectedSession(session);
      await refreshSessions();
      void refreshHealth();
      return session.sessionId;
    });
  }, [
    agentId,
    applySelectedSession,
    notifyCarry,
    refreshHealth,
    refreshSessions,
    selectedProjectIdRef,
    sessionCreation,
  ]);

  const changeSessionSettings = useCallback(
    async (selection: SettingsSelection): Promise<void> => {
      const id = sessionIdRef.current;
      if (!id) {
        setPreselection((prev) => ({ ...prev, ...selection }));
        return;
      }
      setSettingsChanging(true);
      try {
        await applySettingsChange(id, selection, {
          // 各 await の後に「まだ同じチャットか」を確認し、切替済みの古い応答は適用しない
          isCurrentSession: () => sessionIdRef.current === id,
          request: updateSessionSettings,
          recover: getSession,
          applyPayload: applySnapshot,
          onSuccess: () => {
            dispatch({ type: "setActivity", text: "設定を変更しました" });
          },
          onError: (error) => {
            if (error instanceof ApiError && error.status === 409) {
              dispatch({ type: "setActivity", text: error.message });
              return;
            }
            const status = runtimeStatusForError(error);
            setRuntimeStatus(status);
            dispatch({ type: "setActivity", text: status.detail || status.text });
          },
        });
      } finally {
        setSettingsChanging(false);
      }
    },
    [applySnapshot, dispatch, setRuntimeStatus],
  );

  const changeModel = useCallback(
    (model: ModelRef): void => {
      void changeSessionSettings({ model });
    },
    [changeSessionSettings],
  );

  const changeThinkingLevel = useCallback(
    (thinkingLevel: ThinkingLevel): void => {
      void changeSessionSettings({ thinkingLevel });
    },
    [changeSessionSettings],
  );

  /** 選択中の会話の通知の値。一覧 (4 秒のポーリングと変更直後の反映) を正とし、新規チャットは先行選択を使う */
  const notify = sessionId ? sessions.find((item) => item.sessionId === sessionId)?.notify === true : notifyPending;

  const toggleNotify = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    const current = id
      ? sessionsRef.current.find((item) => item.sessionId === id)?.notify === true
      : notifyCarry.snapshot();
    await applyNotifyToggle(id, current, {
      setPending: () => notifyCarry.toggle(),
      apply: applyNotify,
      request: updateSessionNotify,
      onError: (error) => {
        // 実行の成否とは別の操作なので、接続状態 (runtimeStatus) ではなく状態行へ理由を出す
        dispatch({ type: "setActivity", text: `通知を切り替えられませんでした。${messageFor(error)}` });
      },
    });
  }, [applyNotify, dispatch, notifyCarry]);

  const onEvent = useCallback(
    (entry: EventEntry) => {
      applySessionEvent(entry, { lastSeqRef, dispatch, applySnapshot, refreshSessions, setRuntimeStatus });
    },
    [applySnapshot, dispatch, refreshSessions, setRuntimeStatus],
  );

  const onClosed = useCallback(() => {
    void refreshHealth();
    void refreshSessions().then((list) => {
      const current = sessionIdRef.current;
      if (list.some((item) => item.sessionId === current)) {
        setEpoch((e) => e + 1);
        return;
      }
      // セッションが消えている (サーバー再起動・別経路の削除)。再接続せず表示を移す
      const next = list[0];
      if (next) void selectSession(next.sessionId);
      else newChatRef.current();
    });
  }, [refreshHealth, refreshSessions, selectSession]);

  useSessionEvents({ sessionId, epoch, lastSeqRef, generationRef, onEvent, onClosed });

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      if (
        !window.confirm(
          "このセッションの履歴を削除しますか？（作業フォルダのファイルは残ります）実行中の処理は停止されます。",
        )
      )
        return;
      try {
        await apiDeleteSession(id);
      } catch (error) {
        console.error(error);
      }
      const list = await refreshSessions();
      if (id === sessionIdRef.current) {
        const next = list[0];
        if (next) await selectSession(next.sessionId);
        else newChatRef.current();
      }
    },
    [refreshSessions, selectSession],
  );

  const reselectIfMissing = useCallback(
    async (list: SessionSummary[]): Promise<void> => {
      const current = sessionIdRef.current;
      if (!current || list.some((item) => item.sessionId === current)) return;
      const next = list[0];
      if (next) await selectSession(next.sessionId);
      else newChatRef.current();
    },
    [selectSession],
  );

  const restoreSession = useCallback(
    async (list: SessionSummary[], isCurrent = alwaysCurrent, pending?: PendingEntry): Promise<void> => {
      const stored = localStorage.getItem(SESSION_KEY) || "";
      // 通知のディープリンク (`/s/<id>`) は保存済みの復元より優先する
      const requested = pending ? list.find((item) => item.sessionId === pending.sessionId) : undefined;
      const target = requested ?? list.find((item) => item.sessionId === stored) ?? list[0];
      if (!isCurrent()) return;
      // 一覧のロード待ちの間にユーザーが会話を選んでいたら、その選択を奪わない
      if (pending && selectionSeqRef.current !== pending.selection) return;
      if (target) await selectSession(target.sessionId, isCurrent);
      else newChatRef.current();
      // 見つからない / 削除済みのリンクは、既定の会話へ移った後に理由を出す (resync が活動表示を消すため)
      if (pending && !requested) {
        dispatch({ type: "setActivity", text: "リンク先の会話が見つかりませんでした。" });
      }
    },
    [dispatch, selectSession],
  );

  return {
    sessions,
    sessionId,
    sessionIdRef,
    /** 選択の世代。await を挟む処理 (起動時の復元) が「待機中の選択」を判定する */
    selectionSeqRef,
    cwd,
    fileRefRequest,
    requestFileRef,
    ackFileRef,
    preselection,
    settingsChanging,
    notify,
    refreshSessions,
    selectSession,
    newChat,
    ensureSession,
    deleteSession,
    reselectIfMissing,
    restoreSession,
    changeSessionSettings,
    changeModel,
    changeThinkingLevel,
    toggleNotify,
  };
}
