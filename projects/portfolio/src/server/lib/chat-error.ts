import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type { ChatError, ChatErrorCode } from '#/types/chat-api'

export type UpstreamErrorDetails = {
  status?: number
  type?: string
  code?: string
  param?: string
  requestId?: string
  message?: string
}

/** HTTP 200 の Responses terminal failure など、SDK が例外化しない upstream エラーを表す。 */
export class UpstreamChatError extends Error {
  constructor(readonly details: UpstreamErrorDetails) {
    super(details.message ?? 'Unknown upstream error')
    this.name = 'UpstreamChatError'
  }
}

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
  IMAGE_STORAGE_NOT_CONFIGURED: {
    message:
      '生成画像の保存先が未設定です。file-server の接続先・公開 URL・管理者ユーザー名・パスワードを確認してください。',
    retryable: false,
  },
  IMAGE_STORAGE_FAILED: {
    message:
      '生成画像を保存できませんでした。file-server のログイン・アップロード設定と接続状態を確認して再試行してください。',
    retryable: true,
  },
  IMAGE_MODEL_ENDPOINT_INCOMPATIBLE: {
    message:
      '画像生成プロバイダーがモデルまたはエンドポイントに対応していません。base URL の /images/generations 対応と gpt-image-2 の利用可否を確認してください。',
    retryable: false,
  },
  IMAGE_REQUEST_INVALID: {
    message:
      '画像生成リクエストのパラメータが受け付けられませんでした。プロバイダーが受け付ける model・size・output format・n・prompt を確認してください。',
    retryable: false,
  },
  IMAGE_PROVIDER_REJECTED: {
    message:
      '画像生成プロバイダーにリクエストを拒否されました。prompt の内容とプロバイダーの安全基準・利用制限を確認してください。',
    retryable: false,
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

export const imageStorageNotConfiguredError = (): ChatError => ({
  code: 'IMAGE_STORAGE_NOT_CONFIGURED',
  ...errorDefinitions.IMAGE_STORAGE_NOT_CONFIGURED,
})

export const imageStorageFailedError = (): ChatError => ({
  code: 'IMAGE_STORAGE_FAILED',
  ...errorDefinitions.IMAGE_STORAGE_FAILED,
})

export function toImageGenerationChatError(error: unknown): ChatError {
  const details = getErrorDetails(error)
  const code = classifyImageGenerationError(details)

  return {
    code,
    ...errorDefinitions[code],
  }
}

export function getSafeUpstreamErrorLogFields(error: unknown): Record<string, string | number | boolean> {
  const details = getErrorDetails(error)
  const fields: Record<string, string | number | boolean> = {}

  if (isHttpStatus(details.status)) fields.status = details.status

  const code = readSafeDiagnosticValue(details.code)
  if (code) fields.code = code

  const type = readSafeDiagnosticValue(details.type)
  if (type) fields.type = type

  const param = readSafeDiagnosticValue(details.param)
  if (param) fields.param = param

  const requestId = readSafeDiagnosticValue(details.requestId)
  if (requestId) fields.requestId = requestId

  if (details.connectionError) fields.connectionError = true

  return fields
}

export const conversationPersistenceError = (): ChatError => ({
  code: 'UPSTREAM_UNAVAILABLE',
  message: '会話を保存できませんでした。しばらく待ってから再試行してください。',
  retryable: true,
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
  requestId: string
  message: string
  connectionError: boolean
}

function getErrorDetails(error: unknown): ErrorDetails {
  const apiError = error instanceof APIError ? error : undefined
  const upstreamError = error instanceof UpstreamChatError ? error.details : undefined
  const body = asRecord(apiError?.error) ?? upstreamError

  return {
    status: apiError?.status ?? upstreamError?.status,
    type: readString(apiError?.type) || readString(body?.type),
    code: readString(apiError?.code) || readString(body?.code),
    param: readString(apiError?.param) || readString(body?.param),
    requestId: readString(apiError?.requestID) || readString(upstreamError?.requestId),
    message: [readString(body?.message), error instanceof Error ? error.message : '']
      .filter(Boolean)
      .join('\n')
      .toLowerCase(),
    connectionError: error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError,
  }
}

function classifyImageGenerationError(details: ErrorDetails): Exclude<ChatErrorCode, 'VALIDATION_ERROR'> {
  const genericCode = classifyError(details)

  if (!['INVALID_REQUEST', 'UNKNOWN_UPSTREAM_ERROR'].includes(genericCode)) {
    return genericCode
  }

  if (isImageProviderRejection(details)) {
    return 'IMAGE_PROVIDER_REJECTED'
  }

  if (isImageModelEndpointIncompatible(details)) {
    return 'IMAGE_MODEL_ENDPOINT_INCOMPATIBLE'
  }

  return genericCode === 'INVALID_REQUEST' ? 'IMAGE_REQUEST_INVALID' : genericCode
}

function isImageProviderRejection({ type, code, message }: ErrorDetails): boolean {
  const structuredSignals = `${type}\n${code}`.toLowerCase()
  if (
    /moderation[_\s-]?blocked|content[_\s-]?(?:policy|filter)|policy[_\s-]?violation|image[_\s-]?generation[_\s-]?user[_\s-]?error|safety[_\s-]?(?:violation|blocked|filter)|(?:^|\n)blocked(?:$|\n)/.test(
      structuredSignals
    )
  ) {
    return true
  }

  const messageSignals = message.toLowerCase()
  return /(?:prompt|content|image|moderation).*(?:blocked|rejected|filtered|policy|safety|violation)|(?:blocked|rejected|filtered).*(?:prompt|content|image)/.test(
    messageSignals
  )
}

function isImageModelEndpointIncompatible({ status, type, code, param, message }: ErrorDetails): boolean {
  if (status === 404 || status === 405) return true

  const signals = `${type}\n${code}\n${param}\n${message}`.toLowerCase()
  const normalizedParam = param.toLowerCase()

  return (
    normalizedParam === 'model' ||
    normalizedParam === 'endpoint' ||
    /(?:model|endpoint|route|path).*(?:not found|not supported|unsupported|unavailable)|(?:not found|not supported|unsupported|unavailable).*(?:model|endpoint|route|path)|does not support.*(?:model|image|endpoint)|image.*(?:not supported|unsupported)/.test(
      signals
    )
  )
}

function isHttpStatus(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599
}

function readSafeDiagnosticValue(value: unknown): string | undefined {
  const normalized = readString(value).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(normalized) ? normalized : undefined
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
    /connection refused|network error|fetch failed|timed out|timeout|server[_\s-]?error|internal[_\s-]?error/.test(
      signals
    )
  ) {
    return 'UPSTREAM_UNAVAILABLE'
  }

  if (
    (status !== undefined && status >= 400 && status < 500) ||
    /invalid[_\s-]?(?:request|prompt)|bad request/.test(signals)
  ) {
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
