import { readFileSync } from "node:fs"
import { join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { isAuthorized } from "./auth"

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

export type CreateAppOptions = {
  token: string
  clientDir?: string
}

export function createApp(options: CreateAppOptions) {
  const app = new Hono()

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
