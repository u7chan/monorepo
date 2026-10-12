import { APIError } from "openai"

import { readObjectProperty, readStringProperty } from "./fetch"

export type DisplayError = {
  status: number | null
  code: string | null
  param: string | null
  message: string
  requestId: string | null
  hint: string | null
}

export type SicwRequestErrorInput = {
  message: string
  status?: number | null
  code?: string | null
  description?: string | null
  requestId?: string | null
}

/**
 * OAuth / discovery / models のように openai SDK を経由しないリクエストの失敗。
 * ステータスと OAuth の error code を落とさずに持ち回る。
 */
export class SicwRequestError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly description: string | null
  readonly requestId: string | null

  constructor(input: SicwRequestErrorInput) {
    super(input.message)
    this.name = "SicwRequestError"
    this.status = input.status ?? null
    this.code = input.code ?? null
    this.description = input.description ?? null
    this.requestId = input.requestId ?? null
  }
}

const HINTS: Record<string, string> = {
  access_denied:
    "ユーザーが同意を拒否しました。必要なら再度サインインしてください。",
  invalid_client:
    "client の設定が不正です。保存されている client_id を確認してください。",
  invalid_grant:
    "認可コードまたは更新トークンが無効です。保存済みの client ID で再サインインしてください。",
  invalid_refresh_token:
    "更新トークンが無効です。保存済みの client ID で再サインインしてください。",
  token_expired: "トークンの有効期限が切れています。再サインインしてください。",
  refresh_token_expired:
    "更新トークンの有効期限が切れています。再サインインしてください。",
  refresh_token_invalidated:
    "更新トークンが失効しています。再サインインしてください。",
  refresh_token_reused:
    "更新トークンが再利用されています。再サインインしてください。",
  subscription_sharing_user_not_eligible:
    "このアカウント・ワークスペースでは ChatGPT プラン利用が許可されていません。同じリクエストを繰り返さないでください。",
  subscription_sharing_usage_limit_exceeded:
    "ChatGPT プランの利用上限に達しました。設定 → 使用量を確認し、新しいリクエストを止めてください。",
  subscription_sharing_usage_unavailable:
    "使用量の確認ができませんでした。資格情報は保持したまま、時間をおいて再試行してください。",
  subscription_sharing_unsupported_capability:
    "この入力・ツール・モデル・service tier は SIWC 経由では未対応です。error.param を確認して外してください。",
  subscription_sharing_route_not_supported:
    "この HTTP メソッド・エンドポイントは許可されていません。POST /v1/responses を使ってください。",
  subscription_sharing_invalid_user:
    "サブスクライバ情報を検証できませんでした。request ID を控え、必要なら再サインインしてください。",
  subscription_sharing_user_unavailable:
    "ユーザー・ワークスペース情報が一時的に取得できません。時間をおいて再試行してください。",
  chatpass_v2_scope_not_authorized:
    "権限コンテキストが操作を許可していません。client と付与スコープを確認してください。",
  chatpass_v2_invalid_authorization_context:
    "権限コンテキストが不正です。billing を変えずに再試行しても解決しません。",
}

export function hintFor(code: string | null): string | null {
  if (code === null) {
    return null
  }
  return HINTS[code.toLowerCase()] ?? null
}

/** OAuth / discovery / models の非 2xx を、code と request ID を保ったまま持ち回る。 */
export function toResponseError(input: {
  status: number
  payload: unknown
  requestId: string | null
  fallbackMessage: string
}): SicwRequestError {
  // OAuth は { error: "invalid_grant" }、OpenAI API は { error: { code, message } } を返す
  const errorField = readObjectProperty(input.payload, "error")
  const nested =
    typeof errorField === "object" && errorField !== null ? errorField : null
  const code =
    typeof errorField === "string"
      ? errorField
      : readStringProperty(nested, "code")
  const description =
    readStringProperty(input.payload, "error_description") ??
    readStringProperty(input.payload, "detail") ??
    readStringProperty(nested, "message")
  return new SicwRequestError({
    message: description ?? input.fallbackMessage,
    status: input.status,
    code,
    description,
    requestId: input.requestId,
  })
}

export function describeError(error: unknown): DisplayError {
  if (error instanceof APIError) {
    const code = typeof error.code === "string" ? error.code : null
    const detail = readStringProperty(error.error, "detail")
    return {
      status: typeof error.status === "number" ? error.status : null,
      code,
      param: typeof error.param === "string" ? error.param : null,
      message: detail ?? error.message,
      requestId: error.requestID ?? null,
      hint: hintFor(code),
    }
  }

  if (error instanceof SicwRequestError) {
    return {
      status: error.status,
      code: error.code,
      param: null,
      message: error.description ?? error.message,
      requestId: error.requestId,
      hint: hintFor(error.code),
    }
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      status: null,
      code: "request_timeout",
      param: null,
      message: "リクエストがタイムアウトしました。",
      requestId: null,
      hint: "ネットワークと認可サーバーの到達性を確認してください。",
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      status: null,
      code: "request_aborted",
      param: null,
      message: "リクエストを中断しました。",
      requestId: null,
      hint: null,
    }
  }

  if (error instanceof Error) {
    return {
      status: null,
      code: null,
      param: null,
      message: error.message,
      requestId: null,
      hint: null,
    }
  }

  return {
    status: null,
    code: null,
    param: null,
    message: "不明なエラーが発生しました。",
    requestId: null,
    hint: null,
  }
}
