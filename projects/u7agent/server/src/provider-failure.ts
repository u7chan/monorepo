/**
 * provider 呼び出しの失敗分類。画像（`server/src/images.ts`）と音声（`server/src/speech.ts`）で
 * 同じ規則（タイムアウト → ユーザー中断 → 記録した status → 原因不明）を使い、公開文言だけを
 * 呼び出し側が与える。片方だけ新しい分類を増やさないための 1 箇所。
 */

/** 失敗の公開分類。上流の原文は出さず、マスク済みの provider メッセージだけを添える */
export type ProviderFailureCode =
  | "invalid_key"
  | "insufficient_credit"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "unknown";

/** 応答に添える provider メッセージの上限。長文のエラー本文をそのまま会話へ載せない */
export const PROVIDER_MESSAGE_MAX_LENGTH = 500;

/** 分類ごとの公開文言。生成物の種類で呼び出し側が差し替える */
export interface ProviderFailureMessages {
  invalidKey: string;
  insufficientCredit: string;
  rateLimited: string;
  timeout: string;
  aborted: string;
  /** 分類できない失敗の前置き。provider メッセージを添えるときに続ける */
  unknown: string;
}

export interface ProviderFailureContext {
  /** 非 2xx のときだけ記録する。2xx のまま本文が使えないときは undefined */
  status: number | undefined;
  /** 自前タイマーの abort。ユーザー中断とは別に扱う */
  timedOut: boolean;
  aborted: boolean;
  providerMessage: string | undefined;
  maskText: (text: string) => string;
}

export interface ProviderFailure {
  ok: false;
  code: ProviderFailureCode;
  message: string;
}

/** 本文を JSON として読む。JSON でない本文（プロキシの HTML など）は生テキストのまま扱う */
export function parseJsonBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** OpenRouter の `error.message` を優先して理由を取り出す。非 2xx で形が違えば生テキストへ落とす */
export function providerMessageOf(body: unknown, raw: string, includeRaw: boolean): string | undefined {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error !== "") return error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  if (!includeRaw) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * タイムアウト → ユーザー中断 → 記録した status → 原因不明の順に見る。理由の分からない応答本文を
 * そのまま会話へ載せず、provider メッセージはマスクして上限までに切る。
 */
export function classifyProviderFailure(
  context: ProviderFailureContext,
  messages: ProviderFailureMessages,
): ProviderFailure {
  if (context.timedOut) return { ok: false, code: "timeout", message: messages.timeout };
  if (context.aborted) return { ok: false, code: "aborted", message: messages.aborted };
  const { status } = context;
  if (status === 401 || status === 403) return { ok: false, code: "invalid_key", message: messages.invalidKey };
  if (status === 402) return { ok: false, code: "insufficient_credit", message: messages.insufficientCredit };
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { ok: false, code: "rate_limited", message: messages.rateLimited };
  }
  const detail = context.providerMessage;
  return {
    ok: false,
    code: "unknown",
    message: detail
      ? `${messages.unknown}: ${context.maskText(detail).slice(0, PROVIDER_MESSAGE_MAX_LENGTH)}`
      : `${messages.unknown}（原因不明）`,
  };
}
