import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import type { Config } from "../src/config"
import { createCodeChallenge } from "../src/siwc/pkce"
import { SessionStore, type StoredSession } from "../src/siwc/store"
import {
  DISCOVERY_RESPONSE,
  jsonResponse,
  recordingFetch,
  TOKEN_ENDPOINT,
  TOKEN_RESPONSE,
} from "./helpers/http"
import { createTestIdp } from "./helpers/idp"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const REGISTRATION = {
  clientId: "oaiapp_existing",
  email: "user@example.com",
  subject: "subject-1",
  issuer: "https://auth.openai.com",
  extAgentHostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
  registeredAt: "2026-01-01T00:00:00.000Z",
}

type TestBed = {
  app: ReturnType<typeof createApp>
  store: SessionStore
  requests: ReturnType<typeof recordingFetch>["requests"]
  setExpectedNonce: (nonce: string) => void
  setSignedAudience: (audience: string) => void
  setSignedIssuer: (issuer: string) => void
  setSignedSubject: (subject: string) => void
}

async function createSignInBed(
  session: StoredSession | null = null,
): Promise<TestBed> {
  const idp = await createTestIdp()
  const storageDir = await mkdtemp(join(tmpdir(), "siwc-signin-"))
  temporaryDirectories.push(storageDir)

  let expectedNonce = ""
  let signedAudience = ""
  let signedIssuer = "https://auth.openai.com"
  let signedSubject = "subject-1"

  const http = recordingFetch(async (request) => {
    if (request.url.includes(".well-known/openid-configuration")) {
      return jsonResponse(DISCOVERY_RESPONSE)
    }
    if (request.url === DISCOVERY_RESPONSE.jwks_uri) {
      return jsonResponse(idp.jwks)
    }
    if (request.url === TOKEN_ENDPOINT) {
      return jsonResponse({
        ...TOKEN_RESPONSE,
        id_token: await idp.signIdToken({
          audience: signedAudience,
          nonce: expectedNonce,
          issuer: signedIssuer,
          subject: signedSubject,
          email: "user@example.com",
        }),
      })
    }
    return jsonResponse(
      { error: `unexpected: ${request.url}` },
      { status: 500 },
    )
  })

  const config: Config = {
    port: 8787,
    appName: "test-app",
    storageDir,
    origin: "http://127.0.0.1:8787",
    redirectUri: "http://127.0.0.1:8787/auth/callback",
    enableDebugActions: true,
    defaultModel: "gpt-6-luna",
  }

  const store = new SessionStore(storageDir)
  if (session !== null) {
    await store.save(session)
  }

  return {
    app: createApp(config, { fetch: http.fetch }),
    store,
    requests: http.requests,
    setExpectedNonce: (nonce) => {
      expectedNonce = nonce
    },
    setSignedAudience: (audience) => {
      signedAudience = audience
    },
    setSignedIssuer: (issuer) => {
      signedIssuer = issuer
    },
    setSignedSubject: (subject) => {
      signedSubject = subject
    },
  }
}

type StartedAuthorization = {
  state: string
  nonce: string
  clientId: string
  codeChallenge: string
}

async function startAuthorization(
  app: ReturnType<typeof createApp>,
): Promise<StartedAuthorization> {
  const response = await app.request("/auth/start")
  const url = new URL(response.headers.get("location") ?? "")
  const params = url.searchParams
  return {
    state: params.get("state") ?? "",
    nonce: params.get("nonce") ?? "",
    clientId: params.get("client_id") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
  }
}

describe("初回登録", () => {
  test("コールバックで発行された client_id でトークン交換し、その ID を保存する", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)
    expect(authorization.clientId).toBe("dynamic_agent_client")

    bed.setExpectedNonce(authorization.nonce)
    bed.setSignedAudience("oaiapp_new")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1&client_id=oaiapp_new`,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/?auth=signed-in")

    const tokenRequest = bed.requests.find(
      (request) => request.url === TOKEN_ENDPOINT,
    )
    const body = new URLSearchParams(tokenRequest?.body ?? "")
    expect(body.get("client_id")).toBe("oaiapp_new")
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code_verifier")).not.toBeNull()
    expect(createCodeChallenge(body.get("code_verifier") ?? "")).toBe(
      authorization.codeChallenge,
    )

    const stored = await bed.store.read()
    expect(stored?.registration.clientId).toBe("oaiapp_new")
    expect(stored?.registration.email).toBe("user@example.com")
    expect(stored?.tokens?.accessToken).toBe("access-token")

    const status = (await (
      await bed.app.request("/api/status")
    ).json()) as Record<string, unknown>
    expect(status.signedIn).toBe(true)
    expect(status.clientId).toBe("oaiapp_new")
  })

  test("発行済み client_id が返らなければ登録しない", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1`,
    )

    expect(response.headers.get("location")).toBe(
      "/?auth=error&reason=missing_issued_client_id",
    )
    expect(bed.requests.some((request) => request.url === TOKEN_ENDPOINT)).toBe(
      false,
    )
    expect(await bed.store.read()).toBeNull()
  })

  test("dynamic_agent_client が返ってきても登録済みにしない", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1&client_id=dynamic_agent_client`,
    )

    expect(response.headers.get("location")).toBe(
      "/?auth=error&reason=missing_issued_client_id",
    )
    expect(await bed.store.read()).toBeNull()
  })

  test("ID トークンの aud が発行済み client_id と違えば完了しない", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)
    bed.setExpectedNonce(authorization.nonce)
    bed.setSignedAudience("oaiapp_other")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1&client_id=oaiapp_new`,
    )

    expect(response.status).toBe(502)
    expect(await bed.store.read()).toBeNull()
  })

  test("nonce が一致しなければ完了しない", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)
    bed.setExpectedNonce("different-nonce")
    bed.setSignedAudience("oaiapp_new")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1&client_id=oaiapp_new`,
    )

    expect(response.status).toBe(502)
    expect(await bed.store.read()).toBeNull()
  })

  test("issuer が違えば完了しない", async () => {
    const bed = await createSignInBed()
    const authorization = await startAuthorization(bed.app)
    bed.setExpectedNonce(authorization.nonce)
    bed.setSignedAudience("oaiapp_new")
    bed.setSignedIssuer("https://example.invalid")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-1&client_id=oaiapp_new`,
    )

    expect(response.status).toBe(502)
    expect(await bed.store.read()).toBeNull()
  })
})

describe("再認可", () => {
  test("保存済み client_id を送り、コールバックで省略されても成功する", async () => {
    const bed = await createSignInBed({
      registration: REGISTRATION,
      tokens: null,
    })
    const authorization = await startAuthorization(bed.app)
    expect(authorization.clientId).toBe("oaiapp_existing")

    bed.setExpectedNonce(authorization.nonce)
    bed.setSignedAudience("oaiapp_existing")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-2`,
    )

    expect(response.headers.get("location")).toBe("/?auth=signed-in")
    const body = new URLSearchParams(
      bed.requests.find((request) => request.url === TOKEN_ENDPOINT)?.body ??
        "",
    )
    expect(body.get("client_id")).toBe("oaiapp_existing")
    expect((await bed.store.read())?.registration.clientId).toBe(
      "oaiapp_existing",
    )
  })

  test("別の client_id が返ってきたら登録を上書きしない", async () => {
    const bed = await createSignInBed({
      registration: REGISTRATION,
      tokens: null,
    })
    const authorization = await startAuthorization(bed.app)

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-2&client_id=oaiapp_other`,
    )

    expect(response.headers.get("location")).toBe(
      "/?auth=error&reason=client_id_mismatch",
    )
    expect(bed.requests.some((request) => request.url === TOKEN_ENDPOINT)).toBe(
      false,
    )
    expect((await bed.store.read())?.tokens).toBeNull()
  })

  test("ID トークンの sub が保存済みの登録と違えば更新しない", async () => {
    const bed = await createSignInBed({
      registration: REGISTRATION,
      tokens: {
        idToken: "old-id-token",
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        tokenType: "Bearer",
        scopes: ["openid"],
        expiresAt: "2027-01-01T00:00:00.000Z",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    const authorization = await startAuthorization(bed.app)
    bed.setExpectedNonce(authorization.nonce)
    bed.setSignedAudience("oaiapp_existing")
    bed.setSignedSubject("another-subject")

    const response = await bed.app.request(
      `/auth/callback?state=${authorization.state}&code=code-2`,
    )

    expect(response.status).toBe(502)
    expect((await bed.store.read())?.tokens?.accessToken).toBe(
      "old-access-token",
    )
  })
})
