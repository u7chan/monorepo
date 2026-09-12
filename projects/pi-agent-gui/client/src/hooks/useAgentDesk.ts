import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import {
  ApiError,
  createSession,
  deleteSession as apiDeleteSession,
  getCatalog,
  getHealth,
  getSession,
  listSessions,
  postMessage,
  stopSession,
  updateSessionSettings,
} from "../api";
import type {
  AgentDef,
  Catalog,
  EventEntry,
  Health,
  ModelOption,
  ModelRef,
  RunStatus,
  SessionPayload,
  SessionSummary,
  ThinkingLevel,
} from "../types";
import { chatReducer, initialChatState } from "./chatReducer";
import { modelDisplayOf } from "./modelDisplay";
import { applySettingsChange, type SettingsSelection } from "./settingsChange";
import { useSessionEvents } from "./useSessionEvents";
import { createRequestGate } from "./requestGate";

const SESSION_KEY = "pi-agent-session";
const AGENT_KEY = "pi-agent-agent";
const alwaysCurrent = () => true;

/** Effort の全段階 (モデルを解決できないときの案内表示に使う) */
export const ALL_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

export function effortLabel(level: string): string {
  return EFFORT_LABELS[level as ThinkingLevel] ?? level;
}

/** 未作成チャットでは初期値になる */
export type { SettingsSelection };

/** 入力欄付近の Model / Effort ピッカーに渡す状態 */
export type ComposerSettings = {
  modelOptions: ModelOption[];
  /** 現在の値 (チャット実効値 or 作成前の選択値) */
  model?: string;
  thinkingLevel?: string;
  supportsThinking: boolean;
  thinkingLevels: ThinkingLevel[];
  /** 保存済み/既定モデルが候補に無いときの警告 */
  modelWarning?: string;
  /** Effort 候補をモデル能力から引けないときの案内 */
  effortNotice?: string;
  /** 生成中・キュー待ち・設定変更通信中は Model / Effort を無効化する */
  disabled: boolean;
  /** 設定変更通信中は送信も待たせる */
  changing: boolean;
  /** 有効なモデルが無いため送信しても作成できないときの理由 */
  sendBlockedReason?: string;
};

/** ヘッダーの接続状態。モデルは含めない (会話モデルの表示は ModelDisplay が持つ) */
export type RuntimeStatus = {
  text: string;
  error: boolean;
  detail?: string;
  authRequired?: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeStatusForError(error: unknown): RuntimeStatus {
  const detail = errorText(error);
  const authRequired =
    (error instanceof ApiError && error.status === 503) ||
    /APIキー|No API key found|Provider is not configured|No model selected/i.test(detail);
  return {
    text: authRequired ? "APIキー未設定" : "エラー",
    error: true,
    detail,
    authRequired,
  };
}

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
  /** PATCH /settings の通信中 */
  const [settingsChanging, setSettingsChanging] = useState(false);
  /** 未作成チャットの作成前選択 (作成時に使ってクリアする) */
  const [preselection, setPreselection] = useState<SettingsSelection>({});
  const [epoch, setEpoch] = useState(0);

  const lastSeqRef = useRef(0);
  /** newChat / selectSession で選択が変わった世代 (作成待ちの応答で選択を奪わないため) */
  const selectionSeqRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const preselectionRef = useRef<SettingsSelection>(preselection);
  preselectionRef.current = preselection;

  const setAgentId = useCallback((id: string) => {
    setAgentIdState(id);
    localStorage.setItem(AGENT_KEY, id);
  }, []);

  /** 選択中エージェントが無ければ先頭にフォールバックする */
  const normalizeAgentId = useCallback((next: Catalog): string => {
    const valid = next.agents.some((agent) => agent.id === agentId);
    const id = valid ? agentId : next.agents[0]?.id || "";
    localStorage.setItem(AGENT_KEY, id);
    setAgentIdState(id);
    return id;
  }, [agentId]);

  const loadCatalog = useCallback(async (isCurrent = alwaysCurrent): Promise<Catalog> => {
    const next = await getCatalog();
    if (!isCurrent()) return next;
    setCatalog(next);
    normalizeAgentId(next);
    return next;
  }, [normalizeAgentId]);

  const [beginSessionsRequest] = useState(createRequestGate);
  const refreshSessions = useCallback(async (isCurrent = alwaysCurrent): Promise<SessionSummary[]> => {
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
  }, [beginSessionsRequest]);

  const applyHealth = useCallback((next: Health) => {
    setHealth(next);
    setCwd(next.cwd || "");
    if (next.ready) {
      // 明示された既定モデルが使えなくても候補はある。別モデルへ黙って切り替えず入力欄で選ばせる。
      if (next.defaultModelError) {
        setRuntimeStatus({ text: "モデル未選択", error: true, detail: next.defaultModelError });
      } else {
        // health.model はアプリ既定であり、選択中セッションの実効モデルとは限らない。
        // ヘッダーのモデルは会話側から導出し、ここでは接続状態だけを更新する。
        setRuntimeStatus({ text: "接続中", error: false });
      }
      return;
    }

    const authRequired = next.errorCode === "authentication_required";
    const detail = next.error || next.availabilityError || "APIキーまたは認証設定を確認してください";
    setRuntimeStatus({
      text: authRequired ? "APIキー未設定" : "ランタイム未接続",
      error: true,
      detail,
      authRequired,
    });
    dispatch({ type: "setActivity", text: detail });
  }, []);

  const refreshHealth = useCallback(async (isCurrent = alwaysCurrent): Promise<Health | null> => {
    try {
      const next = await getHealth();
      if (!isCurrent()) return null;
      applyHealth(next);
      return next;
    } catch {
      return null;
    }
  }, [applyHealth]);

  const applySnapshot = useCallback((payload: SessionPayload) => {
    lastSeqRef.current = payload.lastSeq || 0;
    setCwd((prev) => payload.cwd || prev);
    // 会話の実効モデルは chat.sessionModel (resync) に入る。ここで runtimeStatus に書くと
    // health の再取得で上書きされるため、ヘッダーは chat 側から導出する。
    dispatch({ type: "resync", payload });
  }, []);

  /** 選択中セッションの表示を payload で置き換える (selectSession / ensureSession 共通) */
  const applySelectedSession = useCallback((payload: SessionPayload) => {
    sessionIdRef.current = payload.sessionId;
    setSessionId(payload.sessionId);
    const nextAgentId = payload.agent?.id || agentId;
    localStorage.setItem(SESSION_KEY, payload.sessionId);
    localStorage.setItem(AGENT_KEY, nextAgentId);
    setAgentIdState(nextAgentId);
    applySnapshot(payload);
    setEpoch((e) => e + 1); // lastSeq を更新してから SSE を張り直す
  }, [agentId, applySnapshot]);

  const selectSession = useCallback(async (id: string, isCurrent = alwaysCurrent): Promise<void> => {
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
  }, [applySelectedSession, refreshHealth]);

  /**
   * 未作成の新規チャットへ戻す。セッションは最初の送信時に ensureSession() が作るため、
   * 送信前に POST /api/sessions を呼ばず、一覧にも空の行を残さない。
   */
  const newChat = useCallback((nextAgentId?: string): void => {
    // エージェントを指定されたときだけ表示を切り替える (未作成チャットで選択した agent が最初の送信に使われる)
    if (nextAgentId) setAgentId(nextAgentId);
    selectionSeqRef.current += 1;
    localStorage.removeItem(SESSION_KEY);
    sessionIdRef.current = "";
    lastSeqRef.current = 0;
    setSessionId("");
    dispatch({ type: "newChat" });
  }, [setAgentId]);

  /** 未作成チャットの最初の送信時だけセッションを作り、送信先の sessionId を返す */
  const ensureSession = useCallback(async (): Promise<string> => {
    const existing = sessionIdRef.current;
    if (existing) return existing;
    const selection = selectionSeqRef.current;
    // 作成前の選択をリクエストへ乗せ、初期値の解決はサーバーに任せる
    const session = await createSession(agentId || undefined, preselectionRef.current);
    setPreselection({});
    // 応答中にユーザーが別のチャットへ切り替えていたら、その選択を奪わず送信先だけを返す
    if (selectionSeqRef.current !== selection) return session.sessionId;
    applySelectedSession(session);
    await refreshSessions();
    void refreshHealth();
    return session.sessionId;
  }, [agentId, applySelectedSession, refreshHealth, refreshSessions]);

  /** チャット単位の Model / Effort 変更。未作成なら作成前の選択として保持する */
  const changeSessionSettings = useCallback(async (selection: SettingsSelection): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) {
      setPreselection((prev) => ({ ...prev, ...selection }));
      return;
    }
    setSettingsChanging(true);
    try {
      await applySettingsChange(id, selection, {
        // 各 await の後に「まだ同じチャットか」を確認し、切替済みの古い応答は適用しない。
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
  }, [applySnapshot]);

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
        dispatch({ type: "runStart", prompt: entry.data.prompt, at: entry.at });
        return;
      case "text":
        dispatch({ type: "text", delta: entry.data.delta, at: entry.at });
        return;
      case "tool_start":
        dispatch({ type: "toolStart", id: entry.data.id, name: entry.data.name, args: entry.data.args, at: entry.at });
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
        if (entry.data.status === "error" && entry.data.error) {
          setRuntimeStatus(runtimeStatusForError(new Error(entry.data.error)));
        }
        void refreshSessions();
        return;
    }
  }, [applySnapshot, refreshSessions]);

  const onClosed = useCallback(() => {
    // SSE が CLOSED になったとき: 一覧を更新し、まだあれば再接続、無ければ次のセッションへ
    void refreshHealth();
    void refreshSessions().then((list) => {
      const current = sessionIdRef.current;
      if (list.some((item) => item.sessionId === current)) {
        setEpoch((e) => e + 1);
      } else {
        const next = list[0];
        if (next) void selectSession(next.sessionId);
        else newChatRef.current();
      }
    });
  }, [refreshHealth, refreshSessions, selectSession]);

  useSessionEvents({ sessionId, epoch, lastSeqRef, onEvent, onClosed });

  // --- アクション ---

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    if (!text || sending || settingsChanging) return;
    setSending(true);
    try {
      if (health && !health.ready) {
        throw new Error(health.error || "APIキーまたは認証設定を確認してください");
      }
      // 送信先は ensureSession の戻り値で受ける。ensureSession は refreshSessions を await するため、
      // その間に切り替えられると sessionIdRef を読み直した先が空になり、入力が黙って消える。
      const targetId = await ensureSession();
      // 切替後は表示と別セッションになる。入力もセッションも捨てずに送信だけ続け、
      // 現在の表示のバブル / 実行状態は触らない (一覧は postMessage 後の refreshSessions が更新する)。
      const sameChat = sessionIdRef.current === targetId;
      if (sameChat) dispatch({ type: "localUser", text, at: Date.now() });

      // 202 即時返却。実行はバックグラウンドで続き、イベントは SSE で届く
      const result = await postMessage(targetId, text);
      if (sameChat) {
        if (result.queued) {
          dispatch({ type: "setRun", runStatus: "running", queueDepth: result.queueDepth, activity: `実行中のため待機キューに追加しました（${result.queueDepth}件目）` });
        } else {
          dispatch({ type: "setRun", runStatus: "running", queueDepth: 0, activity: "実行を開始しました" });
        }
      }
      void refreshSessions();
    } catch (error) {
      const status = runtimeStatusForError(error);
      dispatch({ type: "setActivity", text: status.detail || status.text });
      setRuntimeStatus(status);
    } finally {
      setSending(false);
    }
  }, [health, sending, settingsChanging, ensureSession, refreshSessions]);

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
      else newChatRef.current();
    }
  }, [refreshSessions, selectSession]);

  // --- 起動とポーリング ---

  const boot = useEffectEvent(async (isCurrent: () => boolean) => {
    try {
      const h = await getHealth();
      if (!isCurrent()) return;
      applyHealth(h);
      await loadCatalog(isCurrent);
      if (!isCurrent()) return;
      const list = await refreshSessions(isCurrent);
      if (!isCurrent()) return;
      const stored = localStorage.getItem(SESSION_KEY) || "";
      const target = list.find((item) => item.sessionId === stored) || list[0];
      // 復元先が無ければ未作成チャットのまま。セッションは最初の送信時に作る (起動時に空の行を増やさない)。
      if (target) await selectSession(target.sessionId, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      const status = runtimeStatusForError(error);
      setRuntimeStatus({ ...status, text: status.authRequired ? status.text : "サーバー未接続" });
      dispatch({ type: "setActivity", text: status.detail || status.text });
    }
  });

  useEffect(() => {
    let cancelled = false;
    void boot(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => void refreshSessions(() => !cancelled), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshSessions]);

  const selectedAgent: AgentDef | undefined = catalog.agents.find((agent) => agent.id === agentId);
  const stopVisible = chat.runStatus === "running" || chat.queueDepth > 0;

  // --- 入力欄の Model / Effort ピッカー ---

  const modelOptions = health?.modelOptions ?? [];
  const modelLabelOf = (ref?: ModelRef): string | undefined =>
    ref ? `${ref.provider}/${ref.id}` : undefined;
  const findOption = (label?: string): ModelOption | undefined =>
    label ? modelOptions.find((option) => `${option.provider}/${option.id}` === label) : undefined;

  const inSession = Boolean(sessionId);
  // ヘッダーに出すモデルは、選択中なら会話の実効値だけを使い、未作成のチャットに限りアプリ既定を「既定」と明示する。
  const modelDisplay = modelDisplayOf({
    inSession,
    sessionModel: chat.sessionModel,
    defaultModel: health?.model,
  });
  // 未作成のチャットはサーバーと同じ優先順位 (作成前の選択 → 定義 → アプリ既定) で表示する
  const pendingModel = modelLabelOf(preselection.model) ??
    modelLabelOf(selectedAgent?.model) ??
    health?.model;
  const pendingThinkingLevel = preselection.thinkingLevel ??
    selectedAgent?.thinkingLevel ??
    health?.defaultThinkingLevel;

  const effectiveModel = inSession ? chat.sessionModel : pendingModel;
  const effectiveThinkingLevel = inSession ? chat.sessionThinkingLevel : pendingThinkingLevel;
  const effectiveOption = findOption(effectiveModel);
  const supportsThinking = inSession ? chat.supportsThinking : effectiveOption?.supportsThinking ?? true;
  const thinkingLevels = inSession
    ? chat.availableThinkingLevels
    : effectiveOption?.thinkingLevels ?? ALL_THINKING_LEVELS;

  const composerSettings: ComposerSettings = {
    modelOptions,
    model: effectiveModel,
    thinkingLevel: effectiveThinkingLevel,
    supportsThinking,
    thinkingLevels,
    modelWarning:
      effectiveModel && !effectiveOption
        ? `${effectiveModel} は現在利用できません。別のモデルを選択してください。`
        : undefined,
    effortNotice: effectiveOption ? undefined : "使用モデルに応じて補正されます",
    disabled: stopVisible || sending || settingsChanging,
    changing: settingsChanging,
    sendBlockedReason:
      !inSession && !effectiveModel && health?.defaultModelError
        ? health.defaultModelError
        : undefined,
  };

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
    modelDisplay,
    cwd,
    sending,
    settingsChanging,
    preselection,
    composerSettings,
    selectedAgent,
    stopVisible,
    loadCatalog,
    refreshSessions,
    selectSession,
    newChat,
    sendMessage,
    stopAgent,
    deleteSession,
    changeModel,
    changeThinkingLevel,
  };
}

export type AgentDesk = ReturnType<typeof useAgentDesk>;
