/**
 * チャット上の AI 要約のお知らせを出すかどうかの遷移。React の外の純関数にして、
 * 「開いた時点で終わっている試行は出さない」「pending → done / failed だけ出す」をテストで固定する。
 */
import { sessionTitleNoticeText, type SessionTitleTone } from "./sessionTitleStatus";
import type { SessionTitleSummary } from "../types";

export type SessionTitleNoticeState = {
  key: string;
  heading: string;
  detail: string;
  tone: SessionTitleTone;
};

export type SessionTitleNoticeTracker = {
  /** null はまだ会話を開いていない (初回 mount) */
  sessionId: string | null;
  seenKey: string;
  dismissedKey: string;
};

export const INITIAL_SESSION_TITLE_NOTICE_TRACKER: SessionTitleNoticeTracker = {
  sessionId: null,
  seenKey: "",
  dismissedKey: "",
};

export function sessionTitleAttemptKey(summary: SessionTitleSummary | undefined): string {
  const attempt = summary?.attempt;
  return attempt ? `${attempt.at}:${attempt.state}` : "";
}

/**
 * 次の tracker と、今回出すお知らせを返す。`reset` は表示中のお知らせを消すこと
 * (会話の切替 / 新しい試行の開始) を表す。初回 mount と会話の切替は「開いた時点」として種を入れ、
 * 既存の terminal 状態を出さない。pending / skipped は出さない (Off のままの会話で毎回「スキップ」を出さない)。
 */
export function nextSessionTitleNotice(
  tracker: SessionTitleNoticeTracker,
  input: { sessionId: string; title: string; titleSummary?: SessionTitleSummary },
): { tracker: SessionTitleNoticeTracker; notice: SessionTitleNoticeState | null; reset: boolean } {
  const key = sessionTitleAttemptKey(input.titleSummary);
  if (tracker.sessionId !== input.sessionId) {
    return {
      tracker: { sessionId: input.sessionId, seenKey: key, dismissedKey: "" },
      notice: null,
      reset: true,
    };
  }
  const attempt = input.titleSummary?.attempt;
  if (!attempt || attempt.state === "pending" || attempt.state === "skipped") {
    // 前のお知らせを残したまま新しい試行が始まらないよう、試行が変わったら消す
    const reset = tracker.seenKey !== "" && tracker.seenKey !== key;
    return { tracker: { ...tracker, seenKey: key }, notice: null, reset };
  }
  if (tracker.seenKey === key || tracker.dismissedKey === key) {
    return { tracker, notice: null, reset: false };
  }
  return {
    tracker: { ...tracker, seenKey: key },
    notice: { key, ...sessionTitleNoticeText(input.titleSummary, input.title) },
    reset: false,
  };
}
