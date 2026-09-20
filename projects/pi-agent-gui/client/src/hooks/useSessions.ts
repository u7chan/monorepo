import { useCallback, useRef, useState } from "react";
import type { Dispatch, RefObject } from "react";
import {
  ApiError,
  createSession,
  deleteSession as apiDeleteSession,
  getSession,
  listSessions,
  updateSessionSettings,
} from "../api";
import type { EventEntry, Health, ModelRef, SessionPayload, SessionSummary, ThinkingLevel } from "../types";
import type { ChatAction } from "./chatReducer";
import { createRequestGate } from "./requestGate";
import { applySessionEvent } from "./sessionStream";
import { applySettingsChange, type SettingsSelection } from "./settingsChange";
import { useSessionEvents } from "./useSessionEvents";
import { runtimeStatusForError, type RuntimeStatus } from "./runtimeStatus";

const SESSION_KEY = "pi-agent-session";
const alwaysCurrent = () => true;

export type UseSessionsParams = {
  dispatch: Dispatch<ChatAction>;
  agentId: string;
  setAgentId: (id: string) => void;
  selectProject: (id: string) => void;
  /** state の反映を待たず読む (ensureSession が送信時に参照) */
  selectedProjectIdRef: RefObject<string>;
  refreshHealth: (isCurrent?: () => boolean) => Promise<Health | null>;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

export function useSessions({
  dispatch,
  agentId,
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
  /** 作成中のセッション。同時アップロード / 送信で二重作成しないために共有する */
  const ensureInFlightRef = useRef<Promise<string> | null>(null);
  // sessionIdRef / sessionsRef は選択・一覧の最新値。await を挟む処理と SSE の適用が state を待たずに読む
  const sessionIdRef = useRef(sessionId);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const preselectionRef = useRef<SettingsSelection>(preselection);
  preselectionRef.current = preselection;

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
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      localStorage.setItem(SESSION_KEY, payload.sessionId);
      setAgentId(payload.agent?.id || agentId);
      applySnapshot(payload);
      setEpoch((e) => e + 1); // lastSeq を更新してから SSE を張り直す
    },
    [agentId, applySnapshot, setAgentId],
  );

  const selectSession = useCallback(
    async (id: string, isCurrent = alwaysCurrent): Promise<void> => {
      // getSession の待機中にセッション作成が返っても、この選択を奪わせない
      selectionSeqRef.current += 1;
      try {
        const payload = await getSession(id);
        if (!isCurrent()) return;
        applySelectedSession(payload);
        void refreshHealth(isCurrent);
      } catch {
        if (!isCurrent()) return;
        localStorage.removeItem(SESSION_KEY);
        sessionIdRef.current = "";
        setSessionId("");
        const fallback = sessionsRef.current.find((item) => item.sessionId !== id);
        if (fallback) return selectSession(fallback.sessionId, isCurrent);
        return newChatRef.current();
      }
    },
    [applySelectedSession, refreshHealth],
  );

  const newChat = useCallback(
    (nextAgentId?: string, nextProjectId?: string): void => {
      // 未作成チャットで選んだ agent は、最初の送信で作るセッションの初期値になる
      if (nextAgentId) setAgentId(nextAgentId);
      // 作成先を先に移し、その後の表示と送信先を一致させる
      if (nextProjectId !== undefined) selectProject(nextProjectId);
      selectionSeqRef.current += 1;
      localStorage.removeItem(SESSION_KEY);
      sessionIdRef.current = "";
      lastSeqRef.current = 0;
      setSessionId("");
      // 未作成チャットの作業場所は選択中プロジェクト。前のセッションの cwd を持ち越さない
      setCwd("");
      dispatch({ type: "newChat" });
    },
    [dispatch, selectProject, setAgentId],
  );

  // selectSession ↔ newChat の相互参照用
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;

  const ensureSession = useCallback(async (): Promise<string> => {
    const existing = sessionIdRef.current;
    if (existing) return existing;
    // 同時アップロード / 送信でセッションを二重に作らない (作成中の Promise を共有する)
    const inflight = ensureInFlightRef.current;
    if (inflight) return inflight;
    const promise = (async () => {
      const selection = selectionSeqRef.current;
      // 作成前の選択をリクエストへ乗せ、初期値の解決はサーバーに任せる。未所属 ("") はキーを送らず root に任せる
      const projectId = selectedProjectIdRef.current;
      const session = await createSession(agentId || undefined, {
        ...preselectionRef.current,
        ...(projectId ? { projectId } : {}),
      });
      setPreselection({});
      // 応答中にユーザーが別のチャットへ切り替えていたら、その選択を奪わず送信先だけを返す
      if (selectionSeqRef.current !== selection) return session.sessionId;
      applySelectedSession(session);
      await refreshSessions();
      void refreshHealth();
      return session.sessionId;
    })();
    ensureInFlightRef.current = promise;
    try {
      return await promise;
    } finally {
      if (ensureInFlightRef.current === promise) ensureInFlightRef.current = null;
    }
  }, [agentId, applySelectedSession, refreshHealth, refreshSessions, selectedProjectIdRef]);

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
    async (list: SessionSummary[], isCurrent = alwaysCurrent): Promise<void> => {
      const stored = localStorage.getItem(SESSION_KEY) || "";
      const target = list.find((item) => item.sessionId === stored) || list[0];
      if (!isCurrent()) return;
      if (target) await selectSession(target.sessionId, isCurrent);
      else newChatRef.current();
    },
    [selectSession],
  );

  return {
    sessions,
    sessionId,
    sessionIdRef,
    cwd,
    preselection,
    settingsChanging,
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
  };
}
