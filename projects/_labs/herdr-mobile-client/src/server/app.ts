import { readFileSync } from "node:fs"
import { join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import type { HealthResponse } from "../shared/health"

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version?: string
}

const version = packageJson.version ?? "0.0.0"
const startedAt = new Date().toISOString()

export type CreateAppOptions = {
  clientDir?: string
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono()

  app.get("/api/health", (c) => {
    const body: HealthResponse = { ok: true, version, startedAt }

    return c.json(body)
  })

  const clientDir = options.clientDir

  if (clientDir) {
    app.use("*", serveStatic({ root: clientDir }))
    app.get("*", serveStatic({ path: join(clientDir, "index.html") }))
  }

  return app
}
