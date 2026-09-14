import { useCallback, useEffect, useEffectEvent, useReducer, useState } from "react";
import { getHealth, postMessage, stopSession } from "../api";
import { deriveComposerSettings } from "../lib/composerSettings";
import { chatReducer, initialChatState } from "./chatReducer";
import { runtimeStatusForError } from "./runtimeStatus";
import { sendChatMessage, stopRun } from "./sessionActions";
import type { SettingsSelection } from "./settingsChange";
import { useProjects } from "./useProjects";
import { useRuntimeCatalog } from "./useRuntimeCatalog";
import { useSessions } from "./useSessions";

/** 実装は ../lib/composerSettings。既存の import 先を保つ互換 export */
export { ALL_THINKING_LEVELS, effortLabel, type ComposerSettings } from "../lib/composerSettings";
export type { SettingsSelection };

/**
 * 画面 (App) から見た facade。実装は責務ごとに分ける: health / catalog は useRuntimeCatalog、
 * project 一覧・選択は useProjects、session の一覧・lifecycle・SSE は useSessions、
 * 送信 / 停止の手順は sessionActions、Model / Effort の導出は lib/composerSettings。
 */
export function useAgentDesk() {
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [sending, setSending] = useState(false);

  const {
    health,
    catalog,
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
  const {
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
    changeModel,
    changeThinkingLevel,
  } = useSessions({
    dispatch,
    agentId,
    setAgentId,
    selectProject,
    selectedProjectIdRef,
    refreshHealth,
    setRuntimeStatus,
  });

  const stopVisible = chat.runStatus === "running" || chat.queueDepth > 0;

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      await sendChatMessage(text, {
        health,
        busy: sending || settingsChanging,
        sessionIdRef,
        ensureSession,
        refreshSessions,
        post: postMessage,
        dispatch,
        setSending,
        setRuntimeStatus,
      });
    },
    [
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
      const head = project ? `「${project.name}」を削除します。` : "";
      if (!window.confirm(`${head}配下の ${count} 件のセッションを停止して削除します。ディレクトリは残ります。`)) {
        return;
      }
      if (!(await removeProject(projectId))) return;
      // サーバーは配下セッションまで停止・破棄する
      await reselectIfMissing(await refreshSessions());
    },
    [projects, refreshSessions, removeProject, reselectIfMissing, sessions],
  );

  // --- 起動とポーリング ---

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
      const list = await refreshSessions(isCurrent);
      if (!isCurrent()) return;
      await restoreSession(list, isCurrent);
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
    sessions,
    projects,
    selectedProject,
    selectedProjectId,
    sessionId,
    agentId,
    setAgentId,
    runtimeStatus,
    cwd,
    sending,
    settingsChanging,
    preselection,
    composerSettings,
    selectedAgent,
    stopVisible,
    loadCatalog,
    refreshSessions,
    refreshProjects,
    selectSession,
    selectProject,
    newChat,
    sendMessage,
    stopAgent,
    deleteSession,
    createProject,
    deleteProject,
    changeModel,
    changeThinkingLevel,
  };
}

export type AgentDesk = ReturnType<typeof useAgentDesk>;
