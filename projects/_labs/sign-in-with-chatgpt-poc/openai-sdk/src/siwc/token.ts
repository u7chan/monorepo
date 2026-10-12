import {
  API_BASE_URL,
  REVOCATION_TIMEOUT_MS,
  TOKEN_TIMEOUT_MS,
} from "./constants"
import {
  type DisplayError,
  describeError,
  SicwRequestError,
  toResponseError,
} from "./errors"
import {
  type FetchLike,
  readNumberProperty,
  readResponseBody,
  readStringProperty,
  requestIdFrom,
} from "./fetch"

export type TokenResponse = {
  idToken: string
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresInSeconds: number
  scopes: string[]
}

export type RevocationResult = {
  revoked: boolean
  attempts: number
  error: DisplayError | null
}

export type RevocationOptions = {
  attempts?: number
  baseDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

export type TokenEndpointInput = {
  tokenEndpoint: string
  clientId: string
}

export function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  input: TokenEndpointInput & {
    code: string
    codeVerifier: string
    redirectUri: string
  },
): Promise<TokenResponse> {
  return postTokenRequest(
    fetchImpl,
    input.tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: API_BASE_URL,
    }),
  )
}

export function refreshAccessToken(
  fetchImpl: FetchLike,
  input: TokenEndpointInput & { refreshToken: string },
): Promise<TokenResponse> {
  // scope は省略して既存の付与を維持する（公式ドキュメントの指示）
  return postTokenRequest(
    fetchImpl,
    input.tokenEndpoint,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: API_BASE_URL,
    }),
  )
}

/**
 * 更新セッションを失効させる。5xx とネットワーク失敗だけを再試行する。
 * 200 の空ボディが成功（失効済みのトークンでも 200）。
 * ローカルのトークン削除は呼び出し側の責務なので、ここでは例外を投げない。
 */
export async function revokeRefreshToken(
  fetchImpl: FetchLike,
  input: { revocationEndpoint: string; clientId: string; refreshToken: string },
  options: RevocationOptions = {},
): Promise<RevocationResult> {
  const attempts = options.attempts ?? 3
  const sleep = options.sleep ?? defaultSleep
  let lastError: DisplayError | null = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input.revocationEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: input.refreshToken,
          token_type_hint: "refresh_token",
          client_id: input.clientId,
        }),
        signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      })
      if (response.ok) {
        return { revoked: true, attempts: attempt, error: null }
      }
      const payload = await readResponseBody(response)
      lastError = describeError(
        toResponseError({
          status: response.status,
          payload,
          requestId: requestIdFrom(response),
          fallbackMessage: `セッションの失効に失敗しました (HTTP ${response.status})`,
        }),
      )
      if (response.status < 500 && response.status !== 429) {
        return { revoked: false, attempts: attempt, error: lastError }
      }
    } catch (error) {
      lastError = describeError(error)
    }

    if (attempt < attempts) {
      await sleep((options.baseDelayMs ?? 300) * 2 ** (attempt - 1))
    }
  }

  return { revoked: false, attempts, error: lastError }
}

export async function postTokenRequest(
  fetchImpl: FetchLike,
  endpoint: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  const payload = await readResponseBody(response)
  if (!response.ok) {
    throw toResponseError({
      status: response.status,
      payload,
      requestId: requestIdFrom(response),
      fallbackMessage: `トークンエンドポイントが失敗しました (HTTP ${response.status})`,
    })
  }
  return parseTokenResponse(payload)
}

export function parseTokenResponse(payload: unknown): TokenResponse {
  const idToken = readStringProperty(payload, "id_token")
  const accessToken = readStringProperty(payload, "access_token")
  const refreshToken = readStringProperty(payload, "refresh_token")
  const expiresInSeconds = readNumberProperty(payload, "expires_in")

  if (
    idToken === null ||
    accessToken === null ||
    refreshToken === null ||
    expiresInSeconds === null
  ) {
    throw new SicwRequestError({
      message:
        "トークン応答に id_token / access_token / refresh_token / expires_in のいずれかがありません。",
      code: "invalid_token_response",
    })
  }

  return {
    idToken,
    accessToken,
    refreshToken,
    tokenType: readStringProperty(payload, "token_type") ?? "Bearer",
    expiresInSeconds,
    scopes: splitScopes(readStringProperty(payload, "scope")),
  }
}

export function splitScopes(scope: string | null): string[] {
  if (scope === null) {
    return []
  }
  return scope.split(/\s+/).filter((entry) => entry.length > 0)
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
