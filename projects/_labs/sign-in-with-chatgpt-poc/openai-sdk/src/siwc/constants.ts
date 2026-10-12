/**
 * SIWC（Sign in with ChatGPT）のプロトコル定数。
 * エンドポイントの一部は discovery document から取得するため、ここには持たない。
 */
export const ISSUER = "https://auth.openai.com"

export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`

/**
 * SIWC の `resource` パラメータと、Responses API / models のベースURL。
 * 公式ドキュメントでは同じ値を使う。
 */
export const API_BASE_URL = "https://api.openai.com/v1"

/** 初回登録時だけ送る client_id。発行された client_id を保存し、以降はそちらを使う。 */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client"

export const IDENTITY_SCOPES = ["openid", "profile", "email"] as const

/** ChatGPT プラン枠で推論するために追加で同意してもらうスコープ。 */
export const PLAN_USAGE_SCOPES = [
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const

export const REQUESTED_SCOPES: readonly string[] = [
  ...IDENTITY_SCOPES,
  ...PLAN_USAGE_SCOPES,
]

/** このスコープが付与されているときだけ ChatGPT プラン枠で推論できる。 */
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct"

export const CALLBACK_PATH = "/auth/callback"

/** コールバックはループバックのみ。localhost は使わない。 */
export const REDIRECT_HOST = "127.0.0.1"

export const CHATGPT_USAGE_SETTINGS_URL = "https://chatgpt.com/settings/usage"

/** アクセストークンの残りがこの時間を切ったら、リクエスト前に更新する。 */
export const REFRESH_MARGIN_MS = 60_000

export const DISCOVERY_TIMEOUT_MS = 10_000
export const TOKEN_TIMEOUT_MS = 30_000
export const REVOCATION_TIMEOUT_MS = 10_000
