/**
 * 最終失敗したランの再実行導線。BFF が合成した 1 文と分類コードだけを使い、送信は通常の
 * ユーザーメッセージ (固定文言) に載せる。直前のターンだけを再実行する SDK API は無いため、
 * BFF から `prompt()` を再発行せず、既存の送信経路をそのまま使う (docs/run-lifecycle.md)。
 */
import type { RunErrorCode, RunStatus } from "../types";

/** 失敗した 1 ラン分の分類コードと、BFF が合成した公開文言 */
export type RunErrorInfo = { code: RunErrorCode; text: string };

/** 再実行が送る本文。直前のターンだけを SDK で再実行する API が無いので、続きを促す固定文言を送る */
export const RUN_RETRY_PROMPT = "前回の続きから再開してください";

/** デスクトップは補助行で送信内容を示すため、ボタンのラベルは短くする (compact はラベルが送信内容を兼ねる) */
export const RUN_RETRY_LABEL = "再実行";
export const RUN_RETRY_LABEL_COMPACT = "再実行（前回の続きから送信）";

/** デスクトップのカードに出す補助行。ボタンのラベルだけでは送信内容が分からないため添える */
export const RUN_RETRY_NOTE = "前回の続きから送信します";

/**
 * 時間をおく / やり直すで回復し得る分類だけを再実行の対象にする。
 * 恒久的な利用枠・認証・コンテキスト超過は同じ送信を繰り返しても直らない (docs/run-lifecycle.md)。
 */
const RETRYABLE_CODES: ReadonlySet<RunErrorCode> = new Set<RunErrorCode>(["rate_limit", "unknown"]);

/**
 * 再実行カードに出す失敗。`runStatus === "error"` を必須にする (キュー待ちを挟んだ `runEnd` は
 * `queued` になるため、次のランが pump されるまでのカードのフラッシュを防ぐ)。
 */
export function retryableRunError(runStatus: RunStatus, runError: RunErrorInfo | undefined): RunErrorInfo | undefined {
  if (runStatus !== "error" || runError === undefined) return undefined;
  return RETRYABLE_CODES.has(runError.code) ? runError : undefined;
}

/**
 * `run_end` / resync から保持する失敗。`status === "error"` のときだけ載せる
 * (停止要求と例外が同時のときは停止を正とし、停止直後の再実行カードを出さない)。
 * `errorCode` 無しの縮退 (旧 payload) では載せず、状態行の既存文言を維持する。
 */
export function runErrorFrom(
  status: RunStatus,
  errorCode: RunErrorCode | undefined,
  error: string | undefined,
): RunErrorInfo | undefined {
  if (status !== "error" || errorCode === undefined) return undefined;
  return { code: errorCode, text: error || "実行に失敗しました" };
}

/**
 * 再実行ボタンを押せない理由。送信経路 (`Composer` の submit と `sendChatMessage` の busy) が
 * 実際に遮っているものだけを返し、順序も同じにする。
 */
export function runRetryBlockedReason(input: {
  sending: boolean;
  settingsChanging: boolean;
  attachmentsBusy: boolean;
  runtimeReady: boolean;
}): string | undefined {
  if (input.sending) return "送信中";
  if (input.settingsChanging) return "設定の変更中";
  if (input.attachmentsBusy) return "添付のアップロード中";
  if (!input.runtimeReady) return "ランタイム未接続";
  return undefined;
}

/**
 * 状態行の下へ出す押せない理由の 1 行。無効な操作の名前は実際に無効なボタンから組み
 * (再実行だけが無効なときに圧縮を押せないと誤案内しない)、理由は重複させない
 * (docs/ui-layout.md)。1 行にまとめるのは、狭い画面で説明が入力欄を押し出さないため。
 */
export function blockedButtonsNotice(input: { compact?: string; retry?: string }): string | undefined {
  const { compact, retry } = input;
  if (compact === undefined && retry === undefined) return undefined;
  const target =
    compact !== undefined && retry !== undefined ? "圧縮も再実行も" : compact !== undefined ? "圧縮" : "再実行";
  const reasons = [...new Set([compact, retry].filter((reason): reason is string => reason !== undefined))];
  return `今は${target}できません（${reasons.join("・")}）`;
}
