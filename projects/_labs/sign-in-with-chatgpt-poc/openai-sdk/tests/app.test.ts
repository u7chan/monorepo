import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createApp } from "../src/app"
import type { Config } from "../src/config"
import { DISCOVERY_URL } from "../src/siwc/constants"
import { SessionStore, type TokenSet } from "../src/siwc/store"
import {
  DISCOVERY_RESPONSE,
  jsonResponse,
  recordingFetch,
  TOKEN_ENDPOINT,
  TOKEN_RESPONSE,
} from "./helpers/http"

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
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    savedAt: new Date().toISOString(),
    ...overrides,
  }
}

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function createTestConfig(
  storageDir: string,
  enableDebugActions = true,
): Config {
  return {
    port: 8787,
    appName: "test-app",
    storageDir,
    origin: "http://127.0.0.1:8787",
    redirectUri: "http://127.0.0.1:8787/auth/callback",
    enableDebugActions,
    defaultModel: "gpt-6-luna",
  }
}

async function createTestApp(options: { enableDebugActions?: boolean } = {}) {
  const storageDir = await createTemporaryDirectory("siwc-app-")
  const config = createTestConfig(
    storageDir,
    options.enableDebugActions ?? true,
  )
  const http = recordingFetch((request) => {
    if (request.url === DISCOVERY_URL) {
      return jsonResponse(DISCOVERY_RESPONSE)
    }
    if (request.url === TOKEN_ENDPOINT) {
      return jsonResponse(TOKEN_RESPONSE)
    }
    return jsonResponse(
      { error: `unexpected: ${request.url}` },
      { status: 500 },
    )
  })

  return {
    app: createApp(config, { fetch: http.fetch }),
    store: new SessionStore(storageDir),
    requests: http.requests,
  }
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe("createApp", () => {
  test("GET / は HTML を返す", async () => {
    const { app } = await createTestApp()

    const response = await app.request("/")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("Sign in with ChatGPT PoC")
    expect(html).toContain('src="/static/app.js"')
  })

  test("GET /api/status は未サインインの状態を返す", async () => {
    const { app } = await createTestApp()

    const body = await jsonBody(await app.request("/api/status"))

    expect(body.signedIn).toBe(false)
    expect(body.planUsageEnabled).toBe(false)
    expect(body.debugActionsEnabled).toBe(true)
    expect(body.defaultModel).toBe("gpt-6-luna")
    expect(String(body.storageFile).endsWith("session.json")).toBe(true)
    expect(String(body.extAgentHostId).startsWith("urn:uuid:")).toBe(true)
  })

  test("GET /auth/start は SIWC の認可 URL へリダイレクトする", async () => {
    const { app } = await createTestApp()

    const response = await app.request("/auth/start")

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin + location.pathname).toBe(
      DISCOVERY_RESPONSE.authorization_endpoint,
    )
    expect(location.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8787/auth/callback",
    )
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("resource")).toBe(
      "https://api.openai.com/v1",
    )
    expect(location.searchParams.get("agent_name_hint")).toBe("test-app")
    expect(location.searchParams.get("prompt")).toBeNull()
  })

  test("GET /auth/start?prompt=consent だけが prompt を渡す", async () => {
    const { app } = await createTestApp()

    const withConsent = new URL(
      (await app.request("/auth/start?prompt=consent")).headers.get(
        "location",
      ) ?? "",
    )
    const withOther = new URL(
      (await app.request("/auth/start?prompt=login")).headers.get("location") ??
        "",
    )

    expect(withConsent.searchParams.get("prompt")).toBe("consent")
    expect(withOther.searchParams.get("prompt")).toBeNull()
  })

  test("GET /auth/callback は未知の state を拒否する", async () => {
    const { app, requests } = await createTestApp()

    const response = await app.request(
      "/auth/callback?state=unknown&code=code-1",
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "/?auth=error&reason=state_mismatch",
    )
    expect(
      requests.filter((request) => request.url === TOKEN_ENDPOINT),
    ).toHaveLength(0)
  })

  test("POST /api/chat は未サインインなら 401 を返す", async () => {
    const { app } = await createTestApp()

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-a",
        input: [{ role: "user", content: "hi" }],
      }),
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(401)
    expect((body.error as { code?: string }).code).toBe("not_signed_in")
  })

  test("POST /api/chat は入力が不正なら 400 を返す", async () => {
    const { app, store } = await createTestApp()
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-a",
        input: [{ role: "system", content: "hi" }],
      }),
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(400)
    expect((body.error as { code?: string }).code).toBe("invalid_request")
  })

  test("POST /api/chat は Responses API のストリームを SSE で中継する", async () => {
    const storageDir = await createTemporaryDirectory("siwc-app-chat-")
    const config = createTestConfig(storageDir, false)
    const responsesBody = [
      "event: response.created",
      `data: ${JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "resp-1" } })}`,
      "",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, delta: "hello" })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", sequence_number: 3, response: { id: "resp-1" } })}`,
      "",
      "",
    ].join("\n")

    const http = recordingFetch((request) => {
      if (request.url.startsWith("https://api.openai.com/v1/responses")) {
        return new Response(responsesBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return jsonResponse(
        { error: `unexpected: ${request.url}` },
        { status: 500 },
      )
    })
    const store = new SessionStore(storageDir)
    await store.save({ registration: REGISTRATION, tokens: tokenSet() })
    const app = createApp(config, { fetch: http.fetch })

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-a",
        instructions: "",
        input: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const sse = await response.text()
    expect(sse).toContain("event: delta")
    expect(sse).toContain('"text":"hello"')
    expect(sse).toContain("event: completed")

    const upstream = http.requests.find((request) =>
      request.url.includes("/responses"),
    )
    expect(upstream?.headers.get("authorization")).toBe("Bearer access-token")
    expect(upstream?.body).toContain('"store":false')
    expect(upstream?.body).toContain('"stream":true')
    expect(sse).not.toContain("event: token")
  })

  test("POST /api/chat は期限切れ時に自動更新し、その事実を SSE で知らせる", async () => {
    const storageDir = await createTemporaryDirectory("siwc-app-refresh-")
    const config = createTestConfig(storageDir, false)
    const responsesBody = [
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "resp-2" } })}`,
      "",
      "",
    ].join("\n")

    const http = recordingFetch((request) => {
      if (request.url === DISCOVERY_URL) {
        return jsonResponse(DISCOVERY_RESPONSE)
      }
      if (request.url === TOKEN_ENDPOINT) {
        return jsonResponse({
          ...TOKEN_RESPONSE,
          access_token: "refreshed-access-token",
        })
      }
      if (request.url.startsWith("https://api.openai.com/v1/responses")) {
        return new Response(responsesBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return jsonResponse(
        { error: `unexpected: ${request.url}` },
        { status: 500 },
      )
    })
    const store = new SessionStore(storageDir)
    await store.save({
      registration: REGISTRATION,
      tokens: tokenSet({
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    })
    const app = createApp(config, { fetch: http.fetch })

    const response = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-luna",
        instructions: "",
        input: [{ role: "user", content: "hi" }],
      }),
    })
    const sse = await response.text()

    expect(sse).toContain("event: token")
    expect(sse).toContain('"refreshed":true')
    expect(sse).toContain("event: completed")
    const upstream = http.requests.find((request) =>
      request.url.includes("/responses"),
    )
    expect(upstream?.headers.get("authorization")).toBe(
      "Bearer refreshed-access-token",
    )
    expect((await store.read())?.tokens?.accessToken).toBe(
      "refreshed-access-token",
    )
  })

  test("デバッグ操作は無効化できる", async () => {
    const { app } = await createTestApp({ enableDebugActions: false })

    expect(
      (await app.request("/api/debug/expire-access-token", { method: "POST" }))
        .status,
    ).toBe(404)
    expect(
      (
        await app.request("/api/debug/invalidate-access-token", {
          method: "POST",
        })
      ).status,
    ).toBe(404)
  })
})
