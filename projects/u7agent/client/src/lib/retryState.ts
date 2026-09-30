/**
 * 自動再試行の状態行文言。残り時間は受信時に出した `retryAt - serverNow` から、
 * 受信後のブラウザ経過分だけを引く (ブラウザ時計とサーバー時刻を直接比較しない。
 * 過去イベントのリプレイでも待機を延長しない)。
 */
import type { RunRetryState } from "../types";

/** 受信時点の残りから経過分を引く。残りが無ければ undefined (推測で秒数を出さない) */
export function retryRemainingMs(
  remainingAtReceipt: number | undefined,
  elapsedSinceReceipt: number | undefined,
): number | undefined {
  if (remainingAtReceipt === undefined) return undefined;
  return Math.max(0, remainingAtReceipt - (elapsedSinceReceipt ?? 0));
}

/**
 * 状態行の文言。waiting で予定時刻を過ぎても message_start が来ないときは
 * 「再実行の開始待ち」に切り替える (「あと 0 秒」の待機表示を残さない)。
 */
export function retryActivityText(retry: RunRetryState | undefined, remaining: number | undefined): string | undefined {
  if (!retry) return undefined;
  const progress = `（${retry.attempt}/${retry.maxAttempts}）`;
  if (retry.phase === "retrying") return `再実行中${progress}`;
  if (remaining === undefined) return `自動再試行を待機中${progress}`;
  if (remaining <= 0) return `再実行の開始待ち${progress}`;
  const label = retry.reason === "rate_limit" ? "レート制限中" : "エラー発生";
  return `${label}。約${Math.ceil(remaining / 1000)}秒後に再試行予定${progress}`;
}

/**
 * 状態行に出す活動の文言と由来。再試行の待機 / 再実行の文言で上書きしている間は run の由来
 * (SSE `status` の `state`) を渡さない。演出 (`activity-shimmer`) は run 自身の「考え中…」
 * に当てるもので、再実行の試行中 (`phase: "retrying"`) は `state` が `thinking` でも行に
 * 出ているのは「再実行中（1/2）」なので、文言と由来は同じ経路から決める。
 */
export function activityDisplay(
  activity: string,
  activityState: string | undefined,
  retry: RunRetryState | undefined,
  remaining: number | undefined,
): { text: string; state: string | undefined } {
  const override = retryActivityText(retry, remaining);
  return override === undefined ? { text: activity, state: activityState } : { text: override, state: undefined };
}
