import type { Dispatch, RefObject } from "react";
import type { Health, PostMessageResult, RunStatus, SessionSummary, StopResult } from "../types";
import type { ChatAction } from "./chatReducer";
import { runtimeStatusForError, type RuntimeStatus } from "./runtimeStatus";

export type SendChatMessageDeps = {
  health: Health | null;
  busy: boolean;
  /** render 時の state は古くなるため、await を挟んだ後の判定に使う */
  sessionIdRef: RefObject<string>;
  ensureSession: () => Promise<string>;
  refreshSessions: () => Promise<SessionSummary[]>;
  post: (sessionId: string, text: string) => Promise<PostMessageResult>;
  dispatch: Dispatch<ChatAction>;
  setSending: (value: boolean) => void;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

export async function sendChatMessage(text: string, deps: SendChatMessageDeps): Promise<void> {
  if (!text || deps.busy) return;
  const { sessionIdRef, ensureSession, refreshSessions, post, dispatch, setSending, setRuntimeStatus } = deps;
  setSending(true);
  try {
    if (deps.health && !deps.health.ready) {
      throw new Error(deps.health.error || "APIキーまたは認証設定を確認してください");
    }
    // 送信先は ensureSession の戻り値で受ける。ensureSession は refreshSessions を await するため、
    // その間に選択が切り替わると sessionIdRef を読み直した先が空になり、入力が黙って消える
    const targetId = await ensureSession();
    // 切替後は表示と別セッションになる。入力もセッションも捨てずに送信だけ続け、
    // 現在の表示のバブル / 実行状態は触らない (一覧は post 後の refreshSessions が更新する)
    const sameChat = sessionIdRef.current === targetId;
    if (sameChat) dispatch({ type: "localUser", text, at: Date.now() });

    const result = await post(targetId, text);
    if (sameChat) {
      if (result.queued) {
        dispatch({
          type: "setRun",
          runStatus: "running",
          queueDepth: result.queueDepth,
          activity: `実行中のため待機キューに追加しました（${result.queueDepth}件目）`,
        });
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
}

export type StopRunDeps = {
  sessionIdRef: RefObject<string>;
  stop: (sessionId: string) => Promise<StopResult>;
  dispatch: Dispatch<ChatAction>;
};

export async function stopRun({ sessionIdRef, stop, dispatch }: StopRunDeps): Promise<void> {
  const id = sessionIdRef.current;
  if (!id) return;
  try {
    const result = await stop(id);
    dispatch({
      type: "setRun",
      runStatus: (result.status || "idle") as RunStatus,
      queueDepth: 0,
      activity: "停止要求を送信しました",
    });
  } catch (error) {
    console.error(error);
  }
}
