import { useEffect, useRef, type RefObject } from "react";
import type { EventEntry, SSEEventType } from "../types";

const EVENT_TYPES: SSEEventType[] = [
  "run_start",
  "text",
  "tool_start",
  "tool_end",
  "status",
  "queued",
  "queue_cleared",
  "run_end",
  "resync",
];

export type UseSessionEventsParams = {
  sessionId: string | null;
  /** 強制再接続用カウンタ (同一セッションでの再接続時に increment) */
  epoch: number;
  /** 再接続時に after= に使う最終 seq。イベント処理側が更新する */
  lastSeqRef: RefObject<number>;
  onEvent: (entry: EventEntry) => void;
  /** readyState が CLOSED になった (セッション消失・サーバー再起動など) */
  onClosed: () => void;
};

/** /api/sessions/:id/events への SSE 接続。旧 app.js の connectEvents 相当 */
export function useSessionEvents({ sessionId, epoch, lastSeqRef, onEvent, onClosed }: UseSessionEventsParams): void {
  // コールバックは最新のものを参照する (effect の再接続は sessionId 変化時のみ)
  const onEventRef = useRef(onEvent);
  const onClosedRef = useRef(onClosed);
  onEventRef.current = onEvent;
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`/api/sessions/${sessionId}/events?after=${lastSeqRef.current}`);

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const messageEvent = event as MessageEvent<string | undefined>;
        let data: object | null = null;
        try {
          data = messageEvent.data ? (JSON.parse(messageEvent.data) as object) : null;
        } catch (error) {
          console.error("Invalid SSE event", error);
          return;
        }
        if (data === null) data = {};
        const seq = Number(messageEvent.lastEventId);
        // type と data の相関はランタイムで正しいが、表現上ここでのみ単一キャストする
        onEventRef.current({
          seq: Number.isFinite(seq) ? seq : lastSeqRef.current,
          type,
          data,
          at: Date.now(),
        } as EventEntry);
      });
    }

    source.onerror = () => {
      // readyState CONNECTING: ブラウザが Last-Event-ID 付きでリトライする
      if (source.readyState !== EventSource.CLOSED) return;
      onClosedRef.current();
    };

    return () => {
      source.close();
    };
  }, [sessionId, epoch, lastSeqRef]);
}
