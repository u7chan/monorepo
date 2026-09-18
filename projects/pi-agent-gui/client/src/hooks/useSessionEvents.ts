import { useEffect, useEffectEvent, type RefObject } from "react";
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
  "usage",
  "compaction",
  "resync",
];

export type UseSessionEventsParams = {
  sessionId: string | null;
  epoch: number;
  lastSeqRef: RefObject<number>;
  /** SSE の世代。payload から受け取る。seq は再起動で 0 に戻るため、カーソル整合の判定に使う */
  generationRef: RefObject<string>;
  onEvent: (entry: EventEntry) => void;
  onClosed: () => void;
};

export function useSessionEvents({
  sessionId,
  epoch,
  lastSeqRef,
  generationRef,
  onEvent,
  onClosed,
}: UseSessionEventsParams): void {
  // 常に最新の処理を呼ぶが、コールバックの変更では再接続させない。
  const handleEvent = useEffectEvent(onEvent);
  const handleClosed = useEffectEvent(onClosed);

  useEffect(() => {
    if (!sessionId) return;
    const query = new URLSearchParams({
      after: String(lastSeqRef.current),
      ...(generationRef.current ? { generation: generationRef.current } : {}),
    });
    const source = new EventSource(`/api/sessions/${sessionId}/events?${query.toString()}`);

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
        // id は `<generation>:<seq>`。世代はサーバーが持ち、クライアントは seq だけを使う
        const lastEventId = messageEvent.lastEventId ?? "";
        const seq = Number(
          lastEventId.includes(":") ? lastEventId.slice(lastEventId.lastIndexOf(":") + 1) : lastEventId,
        );
        // type と data の相関はランタイムでは正しいので、ここだけ単一キャストする
        handleEvent({
          seq: Number.isFinite(seq) ? seq : lastSeqRef.current,
          type,
          data,
          at: Date.now(),
        } as EventEntry);
      });
    }

    source.onerror = () => {
      // CONNECTING の間はブラウザが Last-Event-ID 付きでリトライする
      if (source.readyState !== EventSource.CLOSED) return;
      handleClosed();
    };

    return () => {
      source.close();
    };
  }, [sessionId, epoch, lastSeqRef, generationRef]);
}
