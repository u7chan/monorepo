import type { FetchLike } from "../../src/siwc/fetch"

export type RecordedRequest = {
  url: string
  method: string
  headers: Headers
  body: string | null
}

export type RecordedFetch = {
  fetch: FetchLike
  requests: RecordedRequest[]
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  })
}

export function emptyResponse(status = 200): Response {
  return new Response("", { status })
}

export function recordingFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): RecordedFetch {
  const requests: RecordedRequest[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : null,
    }
    requests.push(request)
    return handler(request)
  }
  return { fetch: fetchImpl, requests }
}

export const DISCOVERY_RESPONSE = {
  issuer: "https://auth.openai.com",
  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
  revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
}

export const TOKEN_ENDPOINT = DISCOVERY_RESPONSE.token_endpoint
export const REVOCATION_ENDPOINT = DISCOVERY_RESPONSE.revocation_endpoint

export const TOKEN_RESPONSE = {
  id_token: "id-token",
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "Bearer",
  expires_in: 3600,
  scope:
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
}
