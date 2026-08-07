import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type { ChatError, ChatErrorCode } from '#/types/chat-api'

const errorDefinitions: Record<Exclude<ChatErrorCode, 'VALIDATION_ERROR'>, Omit<ChatError, 'code'>> = {
  AUTHENTICATION_FAILED: {
    message: 'API キーが無効か、利用を許可されていません。設定を確認してください。',
    retryable: false,
  },
  MODEL_ACCESS_DENIED: {
    message: 'このモデルを利用する権限がありません。モデル名と API キーの権限を確認してください。',
    retryable: false,
  },
  INSUFFICIENT_CREDIT: {
    message: 'LLM プロバイダーのクレジットが不足しています。API キーの請求状況を確認してください。',
    retryable: false,
  },
  RATE_LIMITED: {
    message: 'リクエスト数の上限に達しました。しばらく待ってから再試行してください。',
    retryable: true,
  },
  INVALID_REQUEST: {
    message: 'リクエストを処理できませんでした。入力内容とモデル設定を確認してください。',
    retryable: false,
  },
  UPSTREAM_UNAVAILABLE: {
    message: 'LLM プロバイダーに接続できませんでした。しばらく待ってから再試行してください。',
    retryable: true,
  },
  UNKNOWN_UPSTREAM_ERROR: {
    message: 'LLM の応答取得中にエラーが発生しました。しばらく待ってから再試行してください。',
    retryable: true,
  },
}

export const validationError = (message: string): ChatError => ({
  code: 'VALIDATION_ERROR',
  message,
  retryable: false,
})

export const unavailableChatError = (): ChatError => ({
  code: 'UPSTREAM_UNAVAILABLE',
  ...errorDefinitions.UPSTREAM_UNAVAILABLE,
})

/**
 * OpenAI SDK が保持する HTTP ステータスと provider のエラー種別だけを使い、
 * provider の本文を UI 契約へ持ち込まずに分類する。
 */
export function toChatError(error: unknown): ChatError {
  const details = getErrorDetails(error)
  const code = classifyError(details)

  return {
    code,
    ...errorDefinitions[code],
  }
}

type ErrorDetails = {
  status?: number
  type: string
  code: string
  param: string
  message: string
  connectionError: boolean
}

function getErrorDetails(error: unknown): ErrorDetails {
  const apiError = error instanceof APIError ? error : undefined
  const body = asRecord(apiError?.error)

  return {
    status: apiError?.status,
    type: readString(body?.type),
    code: readString(body?.code),
    param: readString(body?.param),
    message: [readString(body?.message), error instanceof Error ? error.message : '']
      .filter(Boolean)
      .join('\n')
      .toLowerCase(),
    connectionError: error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError,
  }
}

function classifyError({
  status,
  type,
  code,
  param,
  message,
  connectionError,
}: ErrorDetails): Exclude<ChatErrorCode, 'VALIDATION_ERROR'> {
  const signals = `${type}\n${code}\n${param}\n${message}`.toLowerCase()

  // LiteLLM は provider の 400 を BadRequestError として返すため、HTTP status より本文の特徴を優先する。
  if (/credit\s+balance\s+is\s+too\s+low|insufficient\s+credit|credit.*(?:insufficient|too\s+low)/.test(signals)) {
    return 'INSUFFICIENT_CREDIT'
  }

  if (
    status === 401 ||
    /authentication|invalid[_\s-]?(?:api )?key|invalid.*token|token_not_found|token.*not.*found/.test(signals)
  ) {
    return 'AUTHENTICATION_FAILED'
  }

  if (status === 403 || /model.*(?:access|permission|denied)|(?:access|permission).*model/.test(signals)) {
    return 'MODEL_ACCESS_DENIED'
  }

  if (status === 429 || /rate[_\s-]?limit|too many requests/.test(signals)) {
    return 'RATE_LIMITED'
  }

  if (
    connectionError ||
    status === 408 ||
    (status !== undefined && status >= 500) ||
    /connection refused|network error|fetch failed|timed out|timeout/.test(signals)
  ) {
    return 'UPSTREAM_UNAVAILABLE'
  }

  if ((status !== undefined && status >= 400 && status < 500) || /invalid[_\s-]?request|bad request/.test(signals)) {
    return 'INVALID_REQUEST'
  }

  return 'UNKNOWN_UPSTREAM_ERROR'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
