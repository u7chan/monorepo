import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_SESSION_TITLE_NOTICE_TRACKER,
  nextSessionTitleNotice,
  sessionTitleAttemptKey,
  type SessionTitleNoticeState,
  type SessionTitleNoticeTracker,
} from "../lib/sessionTitleNotice";
import type { SessionTitleSummary } from "../types";

export type { SessionTitleNoticeState } from "../lib/sessionTitleNotice";

/**
 * 開いている会話の AI 要約が成功 / 失敗した瞬間だけ、チャット上に 1 回のお知らせを出す。開いた時点で
 * 既に終わっている試行は出さず (履歴を遡るたびに再表示しない)、done / failed への遷移だけを拾う。
 */
export function useSessionTitleNotice({
  sessionId,
  title,
  titleSummary,
}: {
  sessionId: string;
  title: string;
  titleSummary?: SessionTitleSummary;
}): { notice: SessionTitleNoticeState | null; dismiss: () => void } {
  const [notice, setNotice] = useState<SessionTitleNoticeState | null>(null);
  const trackerRef = useRef<SessionTitleNoticeTracker>(INITIAL_SESSION_TITLE_NOTICE_TRACKER);
  const key = sessionTitleAttemptKey(titleSummary);

  useEffect(() => {
    const result = nextSessionTitleNotice(trackerRef.current, { sessionId, title, titleSummary });
    trackerRef.current = result.tracker;
    if (result.reset) setNotice(null);
    else if (result.notice) setNotice(result.notice);
  }, [sessionId, key, title, titleSummary]);

  const dismiss = useCallback(() => {
    if (notice) trackerRef.current = { ...trackerRef.current, dismissedKey: notice.key };
    setNotice(null);
  }, [notice]);

  return { notice, dismiss };
}
