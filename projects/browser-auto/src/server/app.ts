import { Hono, type Env } from "hono"
import { serveStatic } from "hono/bun"
import { randomUUID } from "node:crypto"
import { loadDefinitions } from "./features/scenarios/loader"
import { runRoutes } from "./features/runs/routes"
import { logger } from "./logger"
import { join } from "node:path"
import type pino from "pino"

interface AppEnv extends Env {
  Variables: {
    reqId: string
    logger: pino.Logger
  }
}

export async function createApp(): Promise<Hono<AppEnv>> {
  const projectRoot = join(import.meta.dirname, "../..")
  const sitesDir = join(projectRoot, "definitions", "sites")
  const scenariosDir = join(projectRoot, "definitions", "scenarios")

  const store = await loadDefinitions(sitesDir, scenariosDir)

  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    const reqId = randomUUID()
    c.set("reqId", reqId)
    c.set("logger", logger.child({ reqId }))
    await next()
  })

  app.use("*", async (c, next) => {
    const log = c.get("logger")
    const { method } = c.req
    const { pathname } = new URL(c.req.url)
    log.info(`<-- ${method} ${pathname}`)
    const start = Date.now()
    await next()
    const elapsed = Date.now() - start
    const statusColor =
      c.res.status < 300 ? "\u001b[32m" : c.res.status < 400 ? "\u001b[36m" : "\u001b[33m"
    log.info(`--> ${method} ${pathname} ${statusColor}${c.res.status}\u001b[0m ${elapsed}ms`)
  })

  app.route("/", runRoutes(store))

  app.use("*", serveStatic({ root: "./dist/client" }))
  app.get("*", serveStatic({ path: "./dist/client/index.html" }))

  return app
}
