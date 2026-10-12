import { resolve } from "node:path"
import type { Context } from "hono"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import OpenAI from "openai"

import type { Config } from "./config"
import {
  type ChatMessage,
  type ChatRequest,
  type CreateResponseStream,
  type ResponseStreamEventLike,
  streamChatResponse,
} from "./services/inference"
import { SessionService } from "./services/session"
import { buildAuthorizationUrl } from "./siwc/authorize"
import { fetchModelCatalog } from "./siwc/catalog"
import {
  API_BASE_URL,
  CALLBACK_PATH,
  DYNAMIC_CLIENT_ID,
} from "./siwc/constants"
import { DiscoveryClient, type DiscoveryDocument } from "./siwc/discovery"
import { describeError, SicwRequestError } from "./siwc/errors"
import type { FetchLike } from "./siwc/fetch"
import { createRemoteKeyResolver, verifyIdToken } from "./siwc/identity"
import { createPkce, createRandomValue } from "./siwc/pkce"
import { SessionStore } from "./siwc/store"
import { exchangeAuthorizationCode } from "./siwc/token"
import { ErrorPage, Page } from "./ui/page"

const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_HISTORY_MESSAGES = 50

type PendingAuthorization = {
  nonce: string
  codeVerifier: string
  clientId: string
  createdAt: number
}

export type AppDeps = {
  fetch: FetchLike
  now: () => Date
}

export function createApp(
  config: Config,
  overrides: Partial<AppDeps> = {},
): Hono {
  const deps: AppDeps = { fetch, now: () => new Date(), ...overrides }
  const store = new SessionStore(config.storageDir)
  const discovery = new DiscoveryClient(deps.fetch)
  const sessions = new SessionService({
    store,
    discovery,
    fetch: deps.fetch,
    appName: config.appName,
    now: deps.now,
  })

  // 単一ユーザー・単一プロセスなので、認可中の値をメモリに持つ。
  // CSRF 対策は state の照合で足りるため、ブラウザセッションは導入しない。
  const pendingAuthorizations = new Map<string, PendingAuthorization>()
  const keyResolvers = new Map<
    string,
    ReturnType<typeof createRemoteKeyResolver>
  >()

  const app = new Hono()

  app.use(
    "/static/*",
    // /static/app.js -> src/public/app.js。cwd に依存させないため root は import.meta.dir から解決する
    serveStatic({
      root: resolve(import.meta.dir, "public"),
      rewriteRequestPath: (path) => path.replace(/^\/static/, ""),
    }),
  )

  app.get("/", (c) => c.html(`<!DOCTYPE html>${<Page />}`))

  app.get("/auth/start", async (c) => {
    try {
      const [document, hints] = await Promise.all([
        discovery.get(),
        sessions.authorizationHints(),
      ])
      evictExpiredAuthorizations(pendingAuthorizations, deps.now().getTime())

      const pkce = createPkce()
      const state = createRandomValue(24)
      const nonce = createRandomValue(24)
      // 同意画面を再表示したいときだけ許可する（プラン利用を許可しない場合の検証用）
      const prompt = c.req.query("prompt") === "consent" ? "consent" : undefined
      pendingAuthorizations.set(state, {
        nonce,
        codeVerifier: pkce.verifier,
        clientId: hints.clientId,
        createdAt: deps.now().getTime(),
      })

      return c.redirect(
        buildAuthorizationUrl(document.authorizationEndpoint, {
          clientId: hints.clientId,
          extAgentHostId: hints.extAgentHostId,
          agentNameHint: hints.agentNameHint ?? undefined,
          idTokenHint: hints.idTokenHint ?? undefined,
          loginHint: hints.loginHint ?? undefined,
          prompt,
          redirectUri: config.redirectUri,
          state,
          nonce,
          codeChallenge: pkce.challenge,
        }),
      )
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get(CALLBACK_PATH, async (c) => {
    const state = c.req.query("state") ?? ""
    const authorization = pendingAuthorizations.get(state)
    pendingAuthorizations.delete(state)

    if (authorization === undefined) {
      return c.redirect("/?auth=error&reason=state_mismatch")
    }
    if (deps.now().getTime() - authorization.createdAt > PENDING_TTL_MS) {
      return c.redirect("/?auth=error&reason=expired")
    }
    const authorizationError = c.req.query("error")
    if (authorizationError !== undefined && authorizationError !== "") {
      return c.redirect(
        `/?auth=error&reason=${encodeURIComponent(authorizationError)}`,
      )
    }
    const code = c.req.query("code")
    if (code === undefined || code === "") {
      return c.redirect("/?auth=error&reason=missing_code")
    }
    // 初回登録は dynamic_agent_client で開始し、コールバックで発行済み client_id を受け取る。
    // 再認可は保存済み client_id を使い続け、違う ID が返っても登録を上書きしない。
    const resolved = resolveCallbackClientId(
      authorization.clientId,
      c.req.query("client_id"),
    )
    if (!resolved.ok) {
      return c.redirect(`/?auth=error&reason=${resolved.reason}`)
    }
    const issuedClientId = resolved.clientId

    try {
      const document = await discovery.get()
      const tokenResponse = await exchangeAuthorizationCode(deps.fetch, {
        tokenEndpoint: document.tokenEndpoint,
        clientId: issuedClientId,
        code,
        codeVerifier: authorization.codeVerifier,
        redirectUri: config.redirectUri,
      })
      const identity = await verifyIdToken(
        {
          issuer: document.issuer,
          audience: issuedClientId,
          nonce: authorization.nonce,
          keyResolver: keyResolverFor(keyResolvers, document, deps.fetch),
          now: deps.now,
        },
        tokenResponse.idToken,
      )
      await sessions.completeSignIn({
        clientId: issuedClientId,
        issuer: document.issuer,
        identity,
        tokenResponse,
      })
      return c.redirect("/?auth=signed-in")
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get("/api/status", async (c) =>
    c.json({
      ...(await sessions.status(config.enableDebugActions)),
      defaultModel: config.defaultModel,
    }),
  )

  app.get("/api/models", async (c) => {
    try {
      const { accessToken } = await sessions.ensureAccessToken()
      return c.json({
        models: await fetchModelCatalog(deps.fetch, { accessToken }),
      })
    } catch (error) {
      return jsonError(c, error)
    }
  })

  app.post("/api/auth/refresh", async (c) => {
    try {
      const tokens = await sessions.refresh()
      return c.json({ expiresAt: tokens.expiresAt, scopes: tokens.scopes })
    } catch (error) {
      return jsonError(c, error)
    }
  })

  app.post("/api/auth/logout", async (c) => {
    try {
      return c.json(await sessions.signOut())
    } catch (error) {
      return jsonError(c, error)
    }
  })

  app.post("/api/chat", async (c) => {
    let request: ChatRequest
    try {
      request = parseChatRequest(await c.req.json<unknown>())
    } catch (error) {
      return jsonError(c, error)
    }

    let accessToken: string
    let refreshedToken: { expiresAt: string } | null = null
    try {
      const token = await sessions.ensureAccessToken()
      accessToken = token.accessToken
      refreshedToken = token.refreshed ? { expiresAt: token.expiresAt } : null
    } catch (error) {
      return jsonError(c, error)
    }

    return streamSSE(c, async (sse) => {
      const abortController = new AbortController()
      sse.onAbort(() => {
        abortController.abort()
      })

      // 更新は黙って行われると検証しにくいので、ストリームの先頭で知らせる
      if (refreshedToken !== null) {
        await sse.writeSSE({
          event: "token",
          data: JSON.stringify({
            type: "token",
            refreshed: true,
            expiresAt: refreshedToken.expiresAt,
          }),
        })
      }

      const createStream = createOpenAiResponseStream(accessToken, deps.fetch)
      try {
        for await (const event of streamChatResponse(
          createStream,
          request,
          abortController.signal,
        )) {
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) })
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }
        const failed = { type: "failed" as const, error: describeError(error) }
        await sse.writeSSE({ event: "failed", data: JSON.stringify(failed) })
      }
    })
  })

  if (config.enableDebugActions) {
    app.post("/api/debug/expire-access-token", async (c) => {
      try {
        await sessions.expireAccessToken()
        return c.json({
          ok: true,
          note: "次のリクエストの前にアクセストークンを更新します。",
        })
      } catch (error) {
        return jsonError(c, error)
      }
    })

    app.post("/api/debug/invalidate-access-token", async (c) => {
      try {
        await sessions.invalidateAccessToken()
        return c.json({
          ok: true,
          note: "次の /v1/responses は 401 になります。更新ボタンで回復できます。",
        })
      } catch (error) {
        return jsonError(c, error)
      }
    })
  }

  return app
}

function createOpenAiResponseStream(
  accessToken: string,
  fetchImpl: FetchLike,
): CreateResponseStream {
  return async (request, options) => {
    // maxRetries を 0 にして、401 / 403 / 429 と request ID をそのまま観測する
    const client = new OpenAI({
      apiKey: accessToken,
      baseURL: API_BASE_URL,
      maxRetries: 0,
      fetch: fetchImpl,
    })
    const stream = await client.responses.create(
      {
        model: request.model,
        input: request.input,
        // 空文字の instructions は送らない（未対応扱いになる可能性があるため）
        ...(request.instructions === ""
          ? {}
          : { instructions: request.instructions }),
        store: false,
        stream: true,
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
      },
      { signal: options.signal },
    )
    return stream as unknown as AsyncIterable<ResponseStreamEventLike>
  }
}

function keyResolverFor(
  cache: Map<string, ReturnType<typeof createRemoteKeyResolver>>,
  document: DiscoveryDocument,
  fetchImpl: FetchLike,
): ReturnType<typeof createRemoteKeyResolver> {
  const cached = cache.get(document.jwksUri)
  if (cached !== undefined) {
    return cached
  }
  const resolver = createRemoteKeyResolver(document.jwksUri, fetchImpl)
  cache.set(document.jwksUri, resolver)
  return resolver
}

type CallbackClientIdResolution =
  | { ok: true; clientId: string }
  | { ok: false; reason: "missing_issued_client_id" | "client_id_mismatch" }

/** コールバックの client_id から、トークン交換に使う client ID を決める。 */
function resolveCallbackClientId(
  pendingClientId: string,
  callbackClientId: string | undefined,
): CallbackClientIdResolution {
  if (pendingClientId === DYNAMIC_CLIENT_ID) {
    // 発行済み client ID が返らなければ登録が完了していない。dynamic_agent_client は保存しない
    const issued =
      callbackClientId === undefined || callbackClientId === ""
        ? null
        : callbackClientId
    if (issued === null || issued === DYNAMIC_CLIENT_ID) {
      return { ok: false, reason: "missing_issued_client_id" }
    }
    return { ok: true, clientId: issued }
  }

  if (callbackClientId !== undefined && callbackClientId !== pendingClientId) {
    return { ok: false, reason: "client_id_mismatch" }
  }
  return { ok: true, clientId: pendingClientId }
}

function evictExpiredAuthorizations(
  pending: Map<string, PendingAuthorization>,
  now: number,
): void {
  for (const [state, authorization] of pending) {
    if (now - authorization.createdAt > PENDING_TTL_MS) {
      pending.delete(state)
    }
  }
}

function parseChatRequest(payload: unknown): ChatRequest {
  if (typeof payload !== "object" || payload === null) {
    throw invalidRequest("JSON オブジェクトを送ってください。")
  }
  const record = payload as Record<string, unknown>

  if (typeof record.model !== "string" || record.model === "") {
    throw invalidRequest("model を指定してください。")
  }
  if (!Array.isArray(record.input) || record.input.length === 0) {
    throw invalidRequest("input に 1 件以上のメッセージを指定してください。")
  }
  if (record.input.length > MAX_HISTORY_MESSAGES) {
    throw invalidRequest(`input は ${MAX_HISTORY_MESSAGES} 件までです。`)
  }
  if (
    record.instructions !== undefined &&
    typeof record.instructions !== "string"
  ) {
    throw invalidRequest("instructions は文字列で指定してください。")
  }
  if (
    record.temperature !== undefined &&
    typeof record.temperature !== "number"
  ) {
    throw invalidRequest("temperature は数値で指定してください。")
  }

  return {
    model: record.model,
    instructions:
      typeof record.instructions === "string" ? record.instructions : "",
    input: record.input.map(parseChatMessage),
    ...(record.temperature === undefined
      ? {}
      : { temperature: record.temperature }),
  }
}

function parseChatMessage(value: unknown): ChatMessage {
  if (typeof value !== "object" || value === null) {
    throw invalidRequest("input の要素はオブジェクトで指定してください。")
  }
  const record = value as Record<string, unknown>
  if (record.role !== "user" && record.role !== "assistant") {
    throw invalidRequest(
      "input の role は user / assistant のみです（system は使えません）。",
    )
  }
  if (typeof record.content !== "string") {
    throw invalidRequest("input の content は文字列で指定してください。")
  }
  return { role: record.role, content: record.content }
}

function invalidRequest(message: string): SicwRequestError {
  return new SicwRequestError({ message, status: 400, code: "invalid_request" })
}

function jsonError(context: Context, error: unknown): Response {
  const display = describeError(error)
  return context.json(
    { error: display },
    (display.status ?? 500) as ContentfulStatusCode,
  )
}

function errorResponse(context: Context, error: unknown): Response {
  return context.html(
    `<!DOCTYPE html>${<ErrorPage error={describeError(error)} />}`,
    502,
  )
}
