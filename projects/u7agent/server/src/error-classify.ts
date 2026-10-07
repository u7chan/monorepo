/**
 * SDK / プロバイダー由来のラン失敗を公開用に分類する純関数群。上流の原文は公開経路へ返さず、
 * コードと定型の日本語文言だけを返す (組織ID・APIキーなどの再公開を構造的に防ぐ)。
 * 優先順位は恒久的な利用枠 / 認証 / モデルの可用性 → コンテキスト超過 → 一時的な rate limit → unknown の順。
 */
import { AUTH_REQUIRED_MESSAGE } from "./agent";
import type { RunErrorCode } from "./schema";

/** 恒久的な利用枠・課金の枯渇。一時的な 429 より先に見て、再試行で回復すると案内しない */
const QUOTA_PATTERN =
  /insufficient_quota|billing|out of budget|quota exceeded|exceeded your current quota|credit balance|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance/i;

/** 認証・設定の不足。SDK の定型文とプロバイダーの 401 を拾う */
const AUTH_PATTERN =
  /No API key found|Provider is not configured|No model selected|Authentication failed|invalid_api_key|invalid api key|incorrect api key|unauthorized|\b401\b/i;

/**
 * 契約・アカウント種別で許可されていないモデル。カタログ上は使えるように見えるため事前には弾けず、
 * 選び直しだけが復旧手段になる。恒久的なので rate limit より先に見る。
 */
const MODEL_UNAVAILABLE_PATTERN = new RegExp(
  [
    "model.{0,48}(?:not supported|unsupported|not available|unavailable|not found|does not exist|no longer exists)",
    "unknown[_ ]?model",
    "model[_ ]?not[_ ]?found",
    "no such model",
    "invalid[_ ]?model",
  ].join("|"),
  "i",
);

/** コンテキスト超過。SDK は通常 compaction で回復するため、ここへ来るのは回復しきれなかったとき */
const CONTEXT_PATTERN =
  /context[_ ]length|maximum context|context window|prompt is too long|too many tokens|input is too long|reduce the length|token limit/i;

/** 一時的な throttle。SDK はこの分類のエラーを指数バックオフで再試行する */
const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|tokens per min|\bTPM\b|\bRPM\b|request too large|resource_exhausted/i;

export interface RunErrorClassification {
  code: RunErrorCode;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 分類結果。空メッセージ (throw "" / new Error()) は「エラー無し」の契約のため undefined を返す。
 * 判定は上流の原文だけで行い、コード以外は外へ出さない。
 */
export function classifyRunError(error: unknown): RunErrorClassification | undefined {
  const message = messageFor(error);
  if (message === "") return undefined;
  if (QUOTA_PATTERN.test(message)) return { code: "insufficient_quota" };
  if (AUTH_PATTERN.test(message)) return { code: "auth_required" };
  if (MODEL_UNAVAILABLE_PATTERN.test(message)) return { code: "model_unavailable" };
  if (CONTEXT_PATTERN.test(message)) return { code: "context_overflow" };
  if (RATE_LIMIT_PATTERN.test(message)) return { code: "rate_limit" };
  return { code: "unknown" };
}

/** 短い日本語の理由。認証だけは復旧手順込みの既存文言を正とする */
export function runErrorMessage(code: RunErrorCode): string {
  switch (code) {
    case "insufficient_quota":
      return "利用枠またはクレジットの不足により実行できませんでした";
    case "auth_required":
      return AUTH_REQUIRED_MESSAGE;
    case "model_unavailable":
      return "選択したモデルは現在の契約では利用できません";
    case "context_overflow":
      return "入力がモデルのコンテキスト上限を超えました";
    case "rate_limit":
      return "レート制限により実行に失敗しました";
    case "unknown":
      return "実行に失敗しました";
  }
}

/** 原因別の操作案内。時間をおいても回復しない分類に「時間を置けば直る」と書かない */
export function runErrorAction(code: RunErrorCode): string | undefined {
  switch (code) {
    case "insufficient_quota":
      return "プロバイダーの利用枠・支払い設定を確認してください（時間をおいても自動では回復しません）";
    case "auth_required":
      return undefined;
    case "model_unavailable":
      // 設定 → モデル の保存はアプリ既定と候補を変えるだけで、失敗した会話のモデルは変えない。
      // 復旧は入力欄の Model で会話モデルを選び直す経路だけなので、そちらを名指しする。
      return "入力欄の Model でこの会話のモデルを選び直してください";
    case "context_overflow":
      return "会話を圧縮するか、新しいチャットで短い入力から再実行してください";
    case "rate_limit":
      return "時間をおいて再実行してください";
    case "unknown":
      return "原因を特定できませんでした。接続と設定を確認して、もう一度実行してください";
  }
}

/** 公開用の確定文言。totalRetryCount はラン中の再試行スケジュール回数 (待機中の中止も含む) */
export function composeRunError(classification: RunErrorClassification, totalRetryCount: number): string {
  const retryNote = totalRetryCount > 0 ? `（自動再試行${totalRetryCount}回）` : "";
  const action = runErrorAction(classification.code);
  return `${runErrorMessage(classification.code)}${retryNote}${action ? `。${action}` : ""}`;
}

/**
 * backoff 待機中の状態行。残り時間はクライアントが retryAt と serverNow から出すため、
 * ここではイベント時点の概算秒数だけを示す (SDK の delayMs は指数バックオフの値で、上流ヒントではない)。
 */
export function retryWaitingText(reason: RunErrorCode, attempt: number, maxAttempts: number, delayMs: number): string {
  const label = reason === "rate_limit" ? "レート制限中" : "エラー発生";
  const seconds = Math.max(0, Math.ceil(delayMs / 1000));
  return `${label}。約${seconds}秒後に再試行予定（${attempt}/${maxAttempts}）`;
}
