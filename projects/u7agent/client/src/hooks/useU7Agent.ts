import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { getHealth, postMessage, stopSession, uploadSessionFile } from "../api";
import { attachmentRejection, attachmentsForSession, type Attachment } from "../lib/attachments";
import { deriveComposerSettings } from "../lib/composerSettings";
import type { SessionSummary } from "../types";
import { chatReducer, initialChatState } from "./chatReducer";
import { runtimeStatusForError } from "./runtimeStatus";
import { sendChatMessage, stopRun } from "./sessionActions";
import type { SettingsSelection } from "./settingsChange";
import { useNotifications } from "./useNotifications";
import { useProjects } from "./useProjects";
import { useRuntimeCatalog } from "./useRuntimeCatalog";
import { useSessionSkills } from "./useSessionSkills";
import { useSessions, type PendingEntry } from "./useSessions";

/** 実装は ../lib/composerSettings。既存の import 先を保つ互換 export */
export { ALL_THINKING_LEVELS, effortLabel, type ComposerSettings } from "../lib/composerSettings";
export type { Attachment } from "../lib/attachments";
export type { SettingsSelection };

/**
 * 画面 (App) から見た facade。実装は責務ごとに分ける: health / catalog は useRuntimeCatalog、
 * project 一覧・選択は useProjects、session の一覧・lifecycle・SSE は useSessions、
 * 送信 / 停止の手順は sessionActions、Model / Effort の導出は lib/composerSettings。
 */
function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UseU7AgentOptions = {
  /** `/s/<id>` の選択待ちの入口。一覧のロード後にこの会話を選ぶ (localStorage の復元より優先) */
  pendingSessionId?: string;
  /** 入口を消費した。URL を `/` へ畳ませる (選択が確定してから呼ばれる) */
  onPendingSessionResolved?: () => void;
};

export function useU7Agent({ pendingSessionId, onPendingSessionResolved }: UseU7AgentOptions = {}) {
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 追加 / 削除 / 完了を同期的に読む (同時に選んだファイルの件数検査をすり抜けないため)
  const attachmentsRef = useRef<Attachment[]>(attachments);
  const attachmentSeqRef = useRef(0);

  const commitAttachments = useCallback((update: (prev: Attachment[]) => Attachment[]) => {
    const next = update(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const {
    health,
    catalog,
    agents,
    runtimeStatus,
    setRuntimeStatus,
    agentId,
    setAgentId,
    selectedAgent,
    loadCatalog,
    refreshHealth,
    applyHealth,
  } = useRuntimeCatalog({ dispatch });
  const {
    projects,
    selectedProjectId,
    selectedProjectIdRef,
    selectedProject,
    selectProject,
    refreshProjects,
    createProject,
    deleteProject: removeProject,
  } = useProjects();
  // 通知設定はナビの ⚠ にも使うため、設定ページを開いていなくても facade が読み込む
  const notifications = useNotifications();
  const {
    sessions,
    sessionId,
    sessionIdRef,
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
    changeModel,
    changeThinkingLevel,
    toggleNotify,
  } = useSessions({
    dispatch,
    agentId,
    agents,
    setAgentId,
    selectProject,
    selectedProjectIdRef,
    refreshHealth,
    setRuntimeStatus,
  });

  const stopVisible = chat.runStatus === "running" || chat.queueDepth > 0;

  // セッションのスキル一覧 (`/skill:` の入力補助)。新規チャットは選択中のプロジェクト / エージェントで
  // プレビューし、カタログ (エージェント定義) の読み込みまでは取得先が確定しない
  const { state: sessionSkills, reload: reloadSessionSkills } = useSessionSkills({
    sessionId,
    projectId: selectedProjectId,
    agentId,
    enabled: Boolean(sessionId) || Boolean(selectedAgent),
  });

  /** 1 ファイル = 1 チップ。作成 (セッション確定) 後にアップロードし、失敗もチップで見せる */
  const uploadOne = useCallback(
    async (file: File): Promise<void> => {
      const id = String((attachmentSeqRef.current += 1));
      let targetId: string;
      try {
        targetId = await ensureSession();
      } catch (error) {
        commitAttachments((prev) => [
          ...prev,
          {
            id,
            sessionId: sessionIdRef.current,
            name: file.name,
            size: file.size,
            status: "error",
            error: messageFor(error),
          },
        ]);
        return;
      }
      const rejection = attachmentRejection(file, attachmentsRef.current.length);
      if (rejection) {
        commitAttachments((prev) => [
          ...prev,
          { id, sessionId: targetId, name: file.name, size: file.size, status: "error", error: rejection },
        ]);
        return;
      }
      commitAttachments((prev) => [
        ...prev,
        { id, sessionId: targetId, name: file.name, size: file.size, status: "uploading" },
      ]);
      try {
        const uploaded = await uploadSessionFile(targetId, file);
        commitAttachments((update) =>
          update.map((item) => (item.id === id ? { ...item, status: "done", path: uploaded.path } : item)),
        );
      } catch (error) {
        commitAttachments((update) =>
          update.map((item) => (item.id === id ? { ...item, status: "error", error: messageFor(error) } : item)),
        );
      }
    },
    [commitAttachments, ensureSession, sessionIdRef],
  );

  /** 選択 / D&D で受け取ったファイルを追加する。検査は 1 ファイルずつ行う */
  const attachFiles = useCallback(
    (files: File[]): void => {
      for (const file of files) void uploadOne(file);
    },
    [uploadOne],
  );

  const removeAttachment = useCallback(
    (id: string): void => {
      commitAttachments((prev) => prev.filter((item) => item.id !== id));
    },
    [commitAttachments],
  );

  // セッション切替でチップを残さない (アップロード済みのファイルは作業フォルダに残す)
  useEffect(() => {
    commitAttachments((prev) => {
      const kept = prev.filter((item) => item.sessionId === sessionIdRef.current);
      return kept.length === prev.length ? prev : kept;
    });
  }, [sessionId, commitAttachments, sessionIdRef]);

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      // 切替直後は古いセッションのチップが state に残っているため、描画と同じ規則で絞ってから送る
      const pending = attachmentsForSession(attachmentsRef.current, sessionIdRef.current);
      // アップロード中 / 失敗のチップがある間は送らない (Composer でも止める)
      if (pending.some((item) => item.status !== "done")) return;
      const paths = pending.map((item) => item.path).filter((path): path is string => Boolean(path));
      const sentIds = pending.map((item) => item.id);
      await sendChatMessage(text, {
        health,
        busy: sending || settingsChanging,
        sessionIdRef,
        ensureSession,
        refreshSessions,
        post: postMessage,
        attachments: paths,
        // 送れたときだけチップを消す (失敗したファイルは作業フォルダに残るが、送信前に消さない)
        onSent: () => commitAttachments((prev) => prev.filter((item) => !sentIds.includes(item.id))),
        dispatch,
        setSending,
        setRuntimeStatus,
      });
    },
    [
      commitAttachments,
      dispatch,
      ensureSession,
      health,
      refreshSessions,
      sending,
      sessionIdRef,
      settingsChanging,
      setRuntimeStatus,
    ],
  );

  const stopAgent = useCallback(async (): Promise<void> => {
    await stopRun({ sessionIdRef, stop: stopSession, dispatch });
  }, [dispatch, sessionIdRef]);

  const deleteProject = useCallback(
    async (projectId: string): Promise<void> => {
      const project = projects.find((item) => item.id === projectId);
      const count = sessions.filter((item) => item.projectId === projectId).length;
      const head = project ? `「${project.name}」の登録を解除します。` : "";
      if (!window.confirm(`${head}配下の ${count} 件のセッションを停止します（履歴とファイルは残ります）。`)) {
        return;
      }
      if (!(await removeProject(projectId))) return;
      // サーバーは配下セッションまで停止・破棄する。一覧が取れなければ再選択は次の一覧 (ポーリング / SSE) に任せる
      const list = await refreshSessions();
      if (list) await reselectIfMissing(list);
    },
    [projects, refreshSessions, removeProject, reselectIfMissing, sessions],
  );

  /**
   * まだ解決していない入口 (`/s/<id>`)。一覧の取得に成功した時点で 1 度だけ解決する。
   * 起動時の取得が失敗しても、次に届いた一覧 (4 秒のポーリング) で解決できるよう URL は保つ。
   */
  const pendingEntryRef = useRef<PendingEntry | null>(null);
  const resolvePendingEntry = useEffectEvent(async (list: SessionSummary[], isCurrent: () => boolean) => {
    const pending = pendingEntryRef.current;
    if (!pending) return;
    // 先に消す (ポーリングと起動処理が同じ一覧で二重に解決しないように)
    pendingEntryRef.current = null;
    await restoreSession(list, isCurrent, pending);
    if (!isCurrent()) return;
    // 選択が確定してから入口を畳む (URL は選択を待つ間だけ保つ。見つからないときも既定の会話へ移ってから)
    onPendingSessionResolved?.();
  });

  const boot = useEffectEvent(async (isCurrent: () => boolean) => {
    try {
      const h = await getHealth();
      if (!isCurrent()) return;
      applyHealth(h);
      await loadCatalog(isCurrent);
      if (!isCurrent()) return;
      // プロジェクトを先に取る。配下セッションを持たない一覧で描画すると、起動直後に Chats へ一瞬出る
      await refreshProjects(isCurrent);
      if (!isCurrent()) return;
      // 保留の入口は、一覧の要求より前の選択世代と比べる (待機中にユーザーが選んだら、その選択を奪わない)
      pendingEntryRef.current = pendingSessionId
        ? { sessionId: pendingSessionId, selection: selectionSeqRef.current }
        : null;
      const list = await refreshSessions(isCurrent);
      if (!isCurrent()) return;
      if (pendingSessionId) {
        // 一覧が取れなかったときは入口を解決しない (空の成功として畳まず、届いた一覧で解決する)
        if (list) await resolvePendingEntry(list, isCurrent);
        return;
      }
      // 一覧が取れなかったときは復元先が分からないので、未作成チャットのままにする (従来どおり)
      await restoreSession(list ?? [], isCurrent);
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
    const isCurrent = () => !cancelled;
    const timer = window.setInterval(() => {
      void refreshSessions(isCurrent).then((list) => {
        // 一覧が届いたら、起動時に取得できなかった入口をここで解決する
        if (list) void resolvePendingEntry(list, isCurrent);
      });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshSessions]);

  const composerSettings = deriveComposerSettings({
    health,
    selectedAgent,
    sessionId,
    preselection,
    chat,
    sending,
    settingsChanging,
    stopVisible,
  });

  return {
    chat,
    dispatch,
    health,
    catalog,
    agents,
    sessions,
    projects,
    selectedProject,
    selectedProjectId,
    sessionId,
    agentId,
    setAgentId,
    runtimeStatus,
    cwd,
    fileRefRequest,
    requestFileRef,
    ackFileRef,
    sending,
    settingsChanging,
    preselection,
    composerSettings,
    selectedAgent,
    stopVisible,
    sessionSkills,
    reloadSessionSkills,
    notifications,
    notify,
    toggleNotify,
    attachments: attachmentsForSession(attachments, sessionId),
    loadCatalog,
    refreshSessions,
    refreshProjects,
    selectSession,
    selectProject,
    newChat,
    sendMessage,
    attachFiles,
    removeAttachment,
    stopAgent,
    deleteSession,
    createProject,
    deleteProject,
    changeModel,
    changeThinkingLevel,
  };
}

export type U7Agent = ReturnType<typeof useU7Agent>;
