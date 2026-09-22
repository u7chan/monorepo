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

/** サーバーの heartbeat (15 秒) が 2 回分届かない長さを無音とみなす */
export const SSE_SILENCE_TIMEOUT_MS = 30_000;

/** 無音の確認周期。heartbeat 間隔より短くしないと検知が遅れる */
export const SSE_SILENCE_CHECK_MS = 5_000;

const SSE_RETRY_BASE_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;

/**
 * 無音 (heartbeat もイベントも届かない) を切断とみなす。dev の Vite プロキシは upstream が落ちても
 * FIN を返さないため、EventSource の error だけでは半開の接続を検知できない。
 */
export function isSseSilent(lastActivityAt: number, now: number): boolean {
  return now - lastActivityAt >= SSE_SILENCE_TIMEOUT_MS;
}

/** 失敗が続くほど再接続の間隔を伸ばす。停止中に health / 一覧 / SSE を叩き続けないための上限つき */
export function nextRetryDelayMs(retryCount: number): number {
  return Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_BASE_MS * 2 ** retryCount);
}

export function applySessionEvent(entry: EventEntry, deps: SessionStreamDeps): void {
  const { lastSeqRef, dispatch, applySnapshot, refreshSessions, setRuntimeStatus } = deps;
  if (Number.isFinite(entry.seq)) lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
  switch (entry.type) {
    case "resync":
      applySnapshot(entry.data);
      return;
    case "run_start":
      dispatch({ type: "runStart", prompt: entry.data.prompt, at: entry.at, startedAt: entry.data.startedAt });
      return;
    case "text":
      dispatch({ type: "text", delta: entry.data.delta, at: entry.at });
      return;
    case "tool_start":
      dispatch({
        type: "toolStart",
        id: entry.data.id,
        name: entry.data.name,
        args: entry.data.args,
        skill: entry.data.skill,
        at: entry.at,
      });
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
