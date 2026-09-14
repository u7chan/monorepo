import type { Dispatch, RefObject } from "react";
import type { EventEntry, SessionPayload, SessionSummary } from "../types";
import type { ChatAction } from "./chatReducer";
import { runtimeStatusForError, type RuntimeStatus } from "./runtimeStatus";

export type SessionStreamDeps = {
  /** 再接続時の after= に使う最終 seq。イベントの適用より先に進める */
  lastSeqRef: RefObject<number>;
  dispatch: Dispatch<ChatAction>;
  applySnapshot: (payload: SessionPayload) => void;
  refreshSessions: () => Promise<SessionSummary[]>;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

/** セッションの SSE イベントを chat 状態へ適用する */
export function applySessionEvent(entry: EventEntry, deps: SessionStreamDeps): void {
  const { lastSeqRef, dispatch, applySnapshot, refreshSessions, setRuntimeStatus } = deps;
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
    case "usage":
      dispatch({
        type: "usage",
        usage: entry.data.usage,
        metrics: entry.data.metrics,
        context: entry.data.context,
      });
      return;
    case "compaction":
      dispatch({ type: "compaction", compaction: entry.data.compaction, count: entry.data.count });
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
        context: entry.data.context,
      });
      if (entry.data.status === "error" && entry.data.error) {
        setRuntimeStatus(runtimeStatusForError(new Error(entry.data.error)));
      }
      void refreshSessions();
      return;
  }
}
