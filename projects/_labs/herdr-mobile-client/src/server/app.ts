import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getConnInfo } from "@hono/node-server/conninfo"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import { validator } from "hono/validator"
import { isAuthorized } from "./auth"
import { pairOriginFromBody, pairUrl } from "./origin"
import { createPairing, pairCodeFromBody, type Pairing } from "./pairing"
import { isLoopbackAddress, normalizeRemoteAddress } from "./peer"

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version?: string
}

const version = packageJson.version ?? "0.0.0"
const startedAt = new Date().toISOString()

export type HealthResponse = {
  ok: true
  version: string
  startedAt: string
}

export type UnauthorizedResponse = {
  error: "unauthorized"
}

const api = new Hono().get("/api/health", (c) => {
  const body: HealthResponse = { ok: true, version, startedAt }

  return c.json(body)
})

export type ApiType = typeof api

export type PairErrorCode = "invalid_request" | "invalid_code" | "too_many_attempts"

export type PairErrorResponse = {
  error: PairErrorCode
}

export type PairNewResponse = {
  code: string
  url: string
  expiresAt: string
}

export type PairResponse = {
  token: string
}

export type PairRequest = {
  code: string
}

export type CreateAppOptions = {
  token: string
  clientDir?: string
  // app.request() はソケットを持たず、時刻も動かせない。送信元と現在時刻の判定をテストから差し替えられるようにする。
  remoteAddress?: (c: Context) => string | null
  now?: () => number
}

type PublicApiOptions = {
  token: string
  pairing: Pairing
  remoteAddress: (c: Context) => string | null
}

function remoteAddressFromConnection(c: Context): string | null {
  try {
    return normalizeRemoteAddress(getConnInfo(c).remote.address)
  } catch {
    // 握りつぶさないと 500 になり、判定できない場合の倒し先が loopback になってしまう。
    return null
  }
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    // 本文が JSON でないだけで 500 にしない。形式不正は 400 として返す。
    return null
  }
}

function createPublicApi(options: PublicApiOptions) {
  const { pairing, remoteAddress, token } = options

  const loopbackOnly = createMiddleware(async (c, next) => {
    if (!isLoopbackAddress(remoteAddress(c))) {
      return c.notFound()
    }

    await next()
  })

  const rateLimit = createMiddleware(async (c, next) => {
    if (!pairing.registerAttempt()) {
      const body: PairErrorResponse = { error: "too_many_attempts" }

      return c.json(body, 429)
    }

    await next()
  })

  const validatePairCode = (value: unknown, c: Context): PairRequest | Response => {
    const code = pairCodeFromBody(value)

    if (code === null) {
      const body: PairErrorResponse = { error: "invalid_request" }

      return c.json(body, 400)
    }

    return { code }
  }

  return new Hono()
    .post("/api/pair/new", loopbackOnly, async (c) => {
      const origin = pairOriginFromBody(await readJsonBody(c))

      if (origin === null) {
        const body: PairErrorResponse = { error: "invalid_request" }

        return c.json(body, 400)
      }

      const issued = pairing.issue()
      const body: PairNewResponse = {
        code: issued.code,
        url: pairUrl(origin, issued.code),
        expiresAt: issued.expiresAt,
      }

      return c.json(body)
    })
    .post("/api/pair", rateLimit, validator("json", validatePairCode), (c) => {
      const { code } = c.req.valid("json")

      if (!pairing.consume(code)) {
        const body: PairErrorResponse = { error: "invalid_code" }

        return c.json(body, 410)
      }

      const body: PairResponse = { token }

      return c.json(body)
    })
}

export type PublicApiType = ReturnType<typeof createPublicApi>

export function createApp(options: CreateAppOptions) {
  const app = new Hono()
  const pairing = createPairing({ now: options.now })
  const remoteAddress = options.remoteAddress ?? remoteAddressFromConnection

  // 公開する範囲は登録順で読めるようにする。ここへ登録したルートは下の認証ミドルウェアを通らない。
  app.route("/", createPublicApi({ token: options.token, pairing, remoteAddress }))

  // WWW-Authenticate は付けない。ブラウザのネイティブな認証ダイアログが出て、クライアントの入力画面と二重になる。
  app.use("/api/*", async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), options.token)) {
      const body: UnauthorizedResponse = { error: "unauthorized" }

      return c.json(body, 401)
    }

    await next()
  })

  app.route("/", api)

  const clientDir = options.clientDir

  if (clientDir) {
    app.use("*", serveStatic({ root: clientDir }))
    app.get("*", serveStatic({ path: join(clientDir, "index.html") }))
  }

  return app
}
