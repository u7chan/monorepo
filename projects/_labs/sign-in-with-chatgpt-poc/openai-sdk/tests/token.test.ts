import { describe, expect, test } from "bun:test"

import { API_BASE_URL } from "../src/siwc/constants"
import { SicwRequestError } from "../src/siwc/errors"
import {
  exchangeAuthorizationCode,
  parseTokenResponse,
  refreshAccessToken,
  revokeRefreshToken,
  splitScopes,
} from "../src/siwc/token"
import {
  emptyResponse,
  jsonResponse,
  REVOCATION_ENDPOINT,
  recordingFetch,
  TOKEN_ENDPOINT,
  TOKEN_RESPONSE,
} from "./helpers/http"

const noSleep = (): Promise<void> => Promise.resolve()

describe("exchangeAuthorizationCode", () => {
  test("authorization_code grant を form で送る", async () => {
    const { fetch, requests } = recordingFetch(() =>
      jsonResponse(TOKEN_RESPONSE),
    )

    const tokens = await exchangeAuthorizationCode(fetch, {
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "oaiapp_example",
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://127.0.0.1:8787/auth/callback",
    })

    const request = requests[0]
    expect(request?.url).toBe(TOKEN_ENDPOINT)
    expect(request?.method).toBe("POST")
    const body = new URLSearchParams(request?.body ?? "")
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("client_id")).toBe("oaiapp_example")
    expect(body.get("code")).toBe("code-1")
    expect(body.get("code_verifier")).toBe("verifier-1")
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8787/auth/callback")
    expect(body.get("resource")).toBe(API_BASE_URL)
    expect(body.has("scope")).toBe(false)

    expect(tokens.accessToken).toBe("access-token")
    expect(tokens.scopes).toContain("chatgpt.tokens.use.direct")
  })

  test("OAuth エラーは status / code / request ID を落とさない", async () => {
    const { fetch } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "code expired",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "openai-request-id": "req-1",
            },
          },
        ),
    )

    const promise = exchangeAuthorizationCode(fetch, {
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "oaiapp_example",
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "http://127.0.0.1:8787/auth/callback",
    })

    await expect(promise).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
      requestId: "req-1",
    })
  })

  test("必須フィールドが欠けたトークン応答はエラーにする", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ access_token: "only-access" }),
    )

    await expect(
      exchangeAuthorizationCode(fetch, {
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "oaiapp_example",
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "http://127.0.0.1:8787/auth/callback",
      }),
    ).rejects.toBeInstanceOf(SicwRequestError)
  })
})

describe("refreshAccessToken", () => {
  test("refresh_token grant を送り、scope は省略して付与を維持する", async () => {
    const { fetch, requests } = recordingFetch(() =>
      jsonResponse(TOKEN_RESPONSE),
    )

    await refreshAccessToken(fetch, {
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "oaiapp_example",
      refreshToken: "refresh-token",
    })

    const body = new URLSearchParams(requests[0]?.body ?? "")
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("client_id")).toBe("oaiapp_example")
    expect(body.get("refresh_token")).toBe("refresh-token")
    expect(body.get("resource")).toBe(API_BASE_URL)
    expect(body.has("scope")).toBe(false)
  })
})

describe("revokeRefreshToken", () => {
  const input = {
    revocationEndpoint: REVOCATION_ENDPOINT,
    clientId: "oaiapp_example",
    refreshToken: "refresh-token",
  }

  test("200 で成功し、token_type_hint を送る", async () => {
    const { fetch, requests } = recordingFetch(() => emptyResponse())

    const result = await revokeRefreshToken(fetch, input, { sleep: noSleep })

    expect(result).toEqual({ revoked: true, attempts: 1, error: null })
    const body = new URLSearchParams(requests[0]?.body ?? "")
    expect(body.get("token")).toBe("refresh-token")
    expect(body.get("token_type_hint")).toBe("refresh_token")
    expect(body.get("client_id")).toBe("oaiapp_example")
  })

  test("4xx は再試行しない", async () => {
    const { fetch, requests } = recordingFetch(() => emptyResponse(400))

    const result = await revokeRefreshToken(fetch, input, { sleep: noSleep })

    expect(result.revoked).toBe(false)
    expect(result.attempts).toBe(1)
    expect(requests).toHaveLength(1)
  })

  test("5xx は再試行し、成功したら revoked: true を返す", async () => {
    let calls = 0
    const { fetch } = recordingFetch(() => {
      calls += 1
      return calls === 1 ? emptyResponse(503) : emptyResponse(200)
    })

    const result = await revokeRefreshToken(fetch, input, { sleep: noSleep })

    expect(result).toEqual({ revoked: true, attempts: 2, error: null })
  })

  test("ネットワーク失敗が続いても例外を投げず、失敗として返す", async () => {
    const { fetch } = recordingFetch(() => {
      throw new Error("network down")
    })

    const result = await revokeRefreshToken(fetch, input, {
      attempts: 2,
      sleep: noSleep,
    })

    expect(result.revoked).toBe(false)
    expect(result.attempts).toBe(2)
    expect(result.error?.message).toContain("network down")
  })
})

describe("parseTokenResponse", () => {
  test("scope 文字列を配列にし、複数の空白を無視する", () => {
    const tokens = parseTokenResponse({
      ...TOKEN_RESPONSE,
      scope: "openid  email\tprofile",
    })
    expect(tokens.scopes).toEqual(["openid", "email", "profile"])
  })

  test("scope が無ければ空配列にする", () => {
    expect(
      parseTokenResponse({
        id_token: TOKEN_RESPONSE.id_token,
        access_token: TOKEN_RESPONSE.access_token,
        refresh_token: TOKEN_RESPONSE.refresh_token,
        token_type: TOKEN_RESPONSE.token_type,
        expires_in: TOKEN_RESPONSE.expires_in,
      }).scopes,
    ).toEqual([])
  })

  test("splitScopes は null を空配列にする", () => {
    expect(splitScopes(null)).toEqual([])
  })
})
