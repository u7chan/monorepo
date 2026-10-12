import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  needsRefresh,
  SessionService,
  toTokenSet,
} from "../src/services/session"
import { DISCOVERY_URL } from "../src/siwc/constants"
import { DiscoveryClient } from "../src/siwc/discovery"
import type { FetchLike } from "../src/siwc/fetch"
import { SessionStore, type TokenSet } from "../src/siwc/store"
import {
  DISCOVERY_RESPONSE,
  jsonResponse,
  REVOCATION_ENDPOINT,
  recordingFetch,
  TOKEN_ENDPOINT,
  TOKEN_RESPONSE,
} from "./helpers/http"

const NOW = new Date("2026-01-01T12:00:00.000Z")

const REGISTRATION = {
  clientId: "oaiapp_example",
  email: "user@example.com",
  subject: "subject-1",
  issuer: "https://auth.openai.com",
  extAgentHostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
  registeredAt: "2026-01-01T00:00:00.000Z",
}

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    idToken: "id-token",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    expiresAt: "2026-01-01T13:00:00.000Z",
    savedAt: "2026-01-01T12:00:00.000Z",
    ...overrides,
  }
}

async function createService(
  fetchImpl: FetchLike,
): Promise<{ service: SessionService; store: SessionStore }> {
  const store = new SessionStore(await mkdtemp(join(tmpdir(), "siwc-session-")))
  const discovery = new DiscoveryClient(fetchImpl)
  return {
    store,
    service: new SessionService({
      store,
      discovery,
      fetch: fetchImpl,
      appName: "test-app",
      now: () => NOW,
    }),
  }
}

function routeFetch(handlers: {
  token?: () => Response
  revoke?: () => Response
}) {
  return recordingFetch((request) => {
    if (request.url === DISCOVERY_URL) {
      return jsonResponse(DISCOVERY_RESPONSE)
    }
    if (request.url === TOKEN_ENDPOINT) {
      return handlers.token?.() ?? jsonResponse(TOKEN_RESPONSE)
    }
    if (request.url === REVOCATION_ENDPOINT) {
      return handlers.revoke?.() ?? new Response("", { status: 200 })
    }
    return jsonResponse(
      { error: `unexpected url: ${request.url}` },
      { status: 500 },
    )
  })
}

describe("needsRefresh", () => {
  test("残り 60 秒以下なら更新する", () => {
    expect(
      needsRefresh(tokenSet({ expiresAt: "2026-01-01T12:01:00.000Z" }), NOW),
    ).toBe(true)
    expect(
      needsRefresh(tokenSet({ expiresAt: "2026-01-01T12:00:30.000Z" }), NOW),
    ).toBe(true)
    expect(
      needsRefresh(tokenSet({ expiresAt: "2026-01-01T12:02:00.000Z" }), NOW),
    ).toBe(false)
  })

  test("日時として読めない期限は更新扱いにする", () => {
    expect(needsRefresh(tokenSet({ expiresAt: "not-a-date" }), NOW)).toBe(true)
  })
})

describe("toTokenSet", () => {
  test("expires_in 秒から期限を計算する", () => {
    const tokens = toTokenSet(
      {
        idToken: "id",
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresInSeconds: 3600,
        scopes: ["openid"],
      },
      NOW,
    )

    expect(tokens.expiresAt).toBe("2026-01-01T13:00:00.000Z")
    expect(tokens.savedAt).toBe("2026-01-01T12:00:00.000Z")
  })
})

describe("SessionService", () => {
  test("未サインインなら 401 の SicwRequestError を投げる", async () => {
    const { service } = await createService(routeFetch({}).fetch)

    await expect(service.ensureAccessToken()).rejects.toMatchObject({
      status: 401,
      code: "not_signed_in",
    })
  })

  test("期限切れなら更新してから access token を返し、保存内容を入れ替える", async () => {
    const { fetch, requests } = routeFetch({
      token: () =>
        jsonResponse({ ...TOKEN_RESPONSE, access_token: "new-access-token" }),
    })
    const { service, store } = await createService(fetch)
    await store.save({
      registration: REGISTRATION,
      tokens: tokenSet({ expiresAt: "2026-01-01T11:00:00.000Z" }),
    })

    expect(await service.ensureAccessToken()).toBe("new-access-token")

    const tokenRequests = requests.filter(
      (request) => request.url === TOKEN_ENDPOINT,
    )
    expect(tokenRequests).toHaveLength(1)
    const body = new URLSearchParams(tokenRequests[0]?.body ?? "")
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("refresh-token")
    expect((await store.read())?.tokens?.accessToken).toBe("new-access-token")
  })

  test("有効期限内なら更新しない", async () => {
    const { fetch, requests } = routeFetch({})
    const { service, store } = await createService(fetch)
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    expect(await service.ensureAccessToken()).toBe("access-token")
    expect(
      requests.filter((request) => request.url === TOKEN_ENDPOINT),
    ).toHaveLength(0)
  })

  test("同時に refresh しても token エンドポイントは 1 回だけ呼ぶ", async () => {
    const { fetch, requests } = routeFetch({})
    const { service, store } = await createService(fetch)
    await store.save({
      registration: REGISTRATION,
      tokens: tokenSet({ expiresAt: "2026-01-01T11:00:00.000Z" }),
    })

    const [first, second] = await Promise.all([
      service.refresh(),
      service.refresh(),
    ])

    expect(first).toEqual(second)
    expect(
      requests.filter((request) => request.url === TOKEN_ENDPOINT),
    ).toHaveLength(1)
  })

  test("signOut は失効に失敗してもローカルのトークンを消し、warning を返す", async () => {
    const { fetch } = routeFetch({
      revoke: () => new Response("", { status: 400 }),
    })
    const { service, store } = await createService(fetch)
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    const result = await service.signOut()

    expect(result.revoked).toBe(false)
    expect(result.warning).toContain("リモート失効を確認できませんでした")
    const stored = await store.read()
    expect(stored?.tokens).toBeNull()
    expect(stored?.registration).toEqual(REGISTRATION)
  })

  test("signOut は失効に成功したら revoked: true を返す", async () => {
    const { fetch } = routeFetch({})
    const { service, store } = await createService(fetch)
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    expect(await service.signOut()).toEqual({ revoked: true, warning: null })
    expect((await store.read())?.tokens).toBeNull()
  })

  test("completeSignIn は既存登録と sub が違えば拒否する", async () => {
    const { fetch } = routeFetch({})
    const { service, store } = await createService(fetch)
    await store.save({ registration: REGISTRATION, tokens: null })

    await expect(
      service.completeSignIn({
        clientId: "oaiapp_example",
        issuer: "https://auth.openai.com",
        identity: { subject: "another-subject", email: null, name: null },
        tokenResponse: {
          idToken: "id",
          accessToken: "access",
          refreshToken: "refresh",
          tokenType: "Bearer",
          expiresInSeconds: 3600,
          scopes: ["openid"],
        },
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" })
  })

  test("authorizationHints は初回登録と再認可で切り替わる", async () => {
    const { fetch } = routeFetch({})
    const { service, store } = await createService(fetch)

    expect(await service.authorizationHints()).toMatchObject({
      clientId: "dynamic_agent_client",
      agentNameHint: "test-app",
      idTokenHint: null,
      loginHint: null,
    })

    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    expect(await service.authorizationHints()).toMatchObject({
      clientId: "oaiapp_example",
      agentNameHint: null,
      idTokenHint: "id-token",
      loginHint: "user@example.com",
    })
  })

  test("status はプラン利用の可否と残り時間を返す", async () => {
    const { fetch } = routeFetch({})
    const { service, store } = await createService(fetch)
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    const status = await service.status(true)

    expect(status.signedIn).toBe(true)
    expect(status.planUsageEnabled).toBe(true)
    expect(status.expiresInSeconds).toBe(3600)
    expect(status.debugActionsEnabled).toBe(true)
    expect(status.storageFile.endsWith("session.json")).toBe(true)
  })
})
