import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import type { EventEntry, SSEEventType } from "../types";
import { isSseSilent, nextRetryDelayMs, SSE_SILENCE_CHECK_MS } from "./sessionStream";

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
  "ping",
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
  // 接続は epoch / sessionId の変更でも作り直すため、無音の判定とバックオフは effect の外に置く
  const lastActivityRef = useRef(0);
  const retryCountRef = useRef(0);
  const retrySessionRef = useRef(sessionId);

  useEffect(() => {
    if (!sessionId) return;
    if (retrySessionRef.current !== sessionId) {
      retrySessionRef.current = sessionId;
      retryCountRef.current = 0;
    }
    lastActivityRef.current = Date.now();
    const query = new URLSearchParams({
      after: String(lastSeqRef.current),
      ...(generationRef.current ? { generation: generationRef.current } : {}),
    });
    const source = new EventSource(`/api/sessions/${sessionId}/events?${query.toString()}`);

    let retryTimer: number | undefined;
    let retryScheduled = false;
    // 502 のような致命的応答ではその場で CLOSED になり、復帰まで HTTP 往復速度で叩き続けてしまう
    const scheduleReconnect = () => {
      if (retryScheduled) return;
      retryScheduled = true;
      const delay = nextRetryDelayMs(retryCountRef.current);
      retryCountRef.current += 1;
      retryTimer = window.setTimeout(() => handleClosed(), delay);
    };

    const silenceTimer = window.setInterval(() => {
      if (!isSseSilent(lastActivityRef.current, Date.now())) return;
      // 半開の接続はブラウザも閉じないため、こちらから切って既存の復帰経路 (onClosed) に乗せる
      window.clearInterval(silenceTimer);
      source.close();
      scheduleReconnect();
    }, SSE_SILENCE_CHECK_MS);

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        // 何か届いた時点で生存。バックオフを戻して次の無音判定に備える
        lastActivityRef.current = Date.now();
        retryCountRef.current = 0;
        // ping は生存確認だけ。状態へは流さない
        if (type === "ping") return;
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
      scheduleReconnect();
    };

    return () => {
      window.clearInterval(silenceTimer);
      window.clearTimeout(retryTimer);
      source.close();
    };
  }, [sessionId, epoch, lastSeqRef, generationRef]);
}
