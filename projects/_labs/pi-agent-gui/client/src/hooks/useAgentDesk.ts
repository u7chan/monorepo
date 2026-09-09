import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  createSession,
  deleteSession as apiDeleteSession,
  getCatalog,
  getHealth,
  getSession,
  listSessions,
  postMessage,
  stopSession,
} from "../api";
import type {
  AgentDef,
  Catalog,
  EventEntry,
  Health,
  RunStatus,
  SessionPayload,
  SessionSummary,
} from "../types";
import { chatReducer, initialChatState } from "./chatReducer";
import { useSessionEvents } from "./useSessionEvents";

const SESSION_KEY = "pi-agent-session";
const AGENT_KEY = "pi-agent-agent";

export type RuntimeStatus = { text: string; error: boolean };

export function useAgentDesk() {
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({ agents: [], skills: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem(SESSION_KEY) || "");
  const [agentId, setAgentIdState] = useState<string>(() => localStorage.getItem(AGENT_KEY) || "");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({ text: "起動中", error: false });
  const [cwd, setCwd] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const lastSeqRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const sessionsRef = useRef<SessionSummary[]>([]);

  const setAgentId = useCallback((id: string) => {
    setAgentIdState(id);
    localStorage.setItem(AGENT_KEY, id);
  }, []);

  /** 旧 renderAgentPicker の要諦: 選択中エージェントが無ければ先頭にフォールバック */
  const normalizeAgentId = useCallback((next: Catalog): string => {
    const valid = next.agents.some((agent) => agent.id === agentId);
    const id = valid ? agentId : next.agents[0]?.id || "";
    localStorage.setItem(AGENT_KEY, id);
    setAgentIdState(id);
    return id;
  }, [agentId]);

  const loadCatalog = useCallback(async (): Promise<Catalog> => {
    const next = await getCatalog();
    setCatalog(next);
    normalizeAgentId(next);
    return next;
  }, [normalizeAgentId]);

  const refreshSessions = useCallback(async (): Promise<SessionSummary[]> => {
    try {
      const { sessions: list } = await listSessions();
      sessionsRef.current = list;
      setSessions(list);
      return list;
    } catch {
      // サーバーが一時的に届かないときは前回のリストを保持
      return sessionsRef.current;
    }
  }, []);

  const applySnapshot = useCallback((payload: SessionPayload) => {
    lastSeqRef.current = payload.lastSeq || 0;
    setCwd((prev) => payload.cwd || prev);
    if (payload.model) setRuntimeStatus({ text: payload.model, error: false });
    dispatch({ type: "resync", payload });
  }, []);

  const selectSession = useCallback(async (id: string): Promise<void> => {
    try {
      const payload = await getSession(id);
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      const nextAgentId = payload.agent?.id || agentId;
      localStorage.setItem(SESSION_KEY, payload.sessionId);
      localStorage.setItem(AGENT_KEY, nextAgentId);
      setAgentIdState(nextAgentId);
      applySnapshot(payload);
      setEpoch((e) => e + 1); // SSE を (lastSeq 更新後に) 張り直す
    } catch {
      localStorage.removeItem(SESSION_KEY);
      sessionIdRef.current = "";
      setSessionId("");
      const fallback = sessionsRef.current.find((item) => item.sessionId !== id);
      if (fallback) return selectSession(fallback.sessionId);
      return newChatRef.current();
    }
  }, [agentId, applySnapshot]);

  const newChat = useCallback(async (nextAgentId?: string): Promise<void> => {
    const target = nextAgentId || agentId;
    const session = await createSession(target || undefined);
    await refreshSessions();
    await selectSession(session.sessionId);
  }, [agentId, refreshSessions, selectSession]);

  // selectSession ↔ newChat の相互参照用
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;

  // --- SSE イベント処理 ---

  const onEvent = useCallback((entry: EventEntry) => {
    if (Number.isFinite(entry.seq)) lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
    switch (entry.type) {
      case "resync":
        applySnapshot(entry.data);
        return;
      case "run_start":
        dispatch({ type: "runStart", prompt: entry.data.prompt });
        return;
      case "text":
        dispatch({ type: "text", delta: entry.data.delta });
        return;
      case "tool_start":
        dispatch({ type: "toolStart", id: entry.data.id, name: entry.data.name, args: entry.data.args });
        return;
      case "tool_end":
        dispatch({ type: "toolEnd", id: entry.data.id, isError: entry.data.isError, output: entry.data.output });
        return;
      case "status":
        dispatch({ type: "status", text: entry.data.text });
        return;
      case "queued":
        dispatch({ type: "queued", position: entry.data.position, queueDepth: entry.data.queueDepth });
        void refreshSessions();
        return;
      case "queue_cleared":
        dispatch({ type: "queueCleared" });
        return;
      case "run_end":
        dispatch({
          type: "runEnd",
          status: entry.data.status,
          queueDepth: entry.data.queueDepth,
          error: entry.data.error,
        });
        void refreshSessions();
        return;
    }
  }, [applySnapshot, refreshSessions]);

  const onClosed = useCallback(() => {
    // 旧 connectEvents の onerror (CLOSED) 相当: 一覧を更新して再接続 or 次のセッションへ
    void refreshSessions().then((list) => {
      const current = sessionIdRef.current;
      if (list.some((item) => item.sessionId === current)) {
        setEpoch((e) => e + 1);
      } else {
        const next = list[0];
        if (next) void selectSession(next.sessionId);
        else void newChatRef.current();
      }
    });
  }, [refreshSessions, selectSession]);

  useSessionEvents({ sessionId, epoch, lastSeqRef, onEvent, onClosed });

  // --- アクション ---

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    if (!text || sending) return;
    setSending(true);
    try {
      if (!sessionIdRef.current) {
        await newChatRef.current();
      }
      const id = sessionIdRef.current;
      if (!id) return;
      dispatch({ type: "localUser", text });

      // 202 即時返却。実行はバックグラウンドで続き、イベントは SSE で届く
      const result = await postMessage(id, text);
      if (result.queued) {
        dispatch({ type: "setRun", runStatus: "running", queueDepth: result.queueDepth, activity: `実行中のため待機キューに追加しました（${result.queueDepth}件目）` });
      } else {
        dispatch({ type: "setRun", runStatus: "running", queueDepth: 0, activity: "実行を開始しました" });
      }
      void refreshSessions();
    } catch (error) {
      dispatch({ type: "setActivity", text: error instanceof Error ? error.message : String(error) });
      setRuntimeStatus({ text: "エラー", error: true });
    } finally {
      setSending(false);
    }
  }, [sending, refreshSessions]);

  const stopAgent = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const result = await stopSession(id);
      dispatch({ type: "setRun", runStatus: (result.status || "idle") as RunStatus, queueDepth: 0, activity: "停止要求を送信しました" });
    } catch (error) {
      console.error(error);
    }
  }, []);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    if (!window.confirm("このセッションを削除しますか？実行中の処理は停止されます。")) return;
    try {
      await apiDeleteSession(id);
    } catch (error) {
      console.error(error);
    }
    const list = await refreshSessions();
    if (id === sessionIdRef.current) {
      const next = list[0];
      if (next) await selectSession(next.sessionId);
      else await newChatRef.current();
    }
  }, [refreshSessions, selectSession]);

  // --- 起動とポーリング ---

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        setHealth(h);
        setCwd(h.cwd || "");
        if (h.ready) {
          setRuntimeStatus({ text: h.model || "接続中", error: false });
        } else {
          setRuntimeStatus({ text: "pi 未接続", error: true });
          dispatch({ type: "setActivity", text: h.error || "APIキーまたは pi の認証を確認してください" });
        }
        await loadCatalog();
        if (cancelled) return;
        const list = await refreshSessions();
        if (cancelled) return;
        const stored = localStorage.getItem(SESSION_KEY) || "";
        const target = list.find((item) => item.sessionId === stored) || list[0];
        if (target) await selectSession(target.sessionId);
        else if (h.ready) await newChatRef.current();
      } catch (error) {
        if (cancelled) return;
        setRuntimeStatus({ text: "サーバー未接続", error: true });
        dispatch({ type: "setActivity", text: error instanceof Error ? error.message : String(error) });
      }
    };
    void boot();
    const timer = window.setInterval(() => void refreshSessions(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAgent: AgentDef | undefined = catalog.agents.find((agent) => agent.id === agentId);
  const stopVisible = chat.runStatus === "running" || chat.queueDepth > 0;

  return {
    chat,
    dispatch,
    health,
    catalog,
    sessions,
    sessionId,
    agentId,
    setAgentId,
    runtimeStatus,
    cwd,
    sending,
    selectedAgent,
    stopVisible,
    loadCatalog,
    refreshSessions,
    selectSession,
    newChat,
    sendMessage,
    stopAgent,
    deleteSession,
  };
}

export type AgentDesk = ReturnType<typeof useAgentDesk>;
