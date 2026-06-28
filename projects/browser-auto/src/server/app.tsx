import { Hono, type Env } from "hono"
import { serveStatic } from "hono/bun"
import { logger as honoLogger } from "hono/logger"
import { randomUUID } from "node:crypto"
import type { DefinitionStore } from "./yaml-loader"
import { loadDefinitions } from "./yaml-loader"
import { isRunning, startRun, getCurrentRun } from "./run-state"
import { executeScenario } from "./executor"
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

  const store: DefinitionStore = await loadDefinitions(sitesDir, scenariosDir)

  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    const reqId = randomUUID()
    c.set("reqId", reqId)
    c.set("logger", logger.child({ reqId }))
    await next()
  })

  app.use(honoLogger((msg) => logger.info(msg)))

  app.post("/api/runs", async (c) => {
    const log = c.get("logger")
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    if (body === null || typeof body !== "object" || !("scenarioId" in body)) {
      return c.json({ error: "scenarioId is required" }, 400)
    }

    const scenarioId = (body as { scenarioId: unknown }).scenarioId
    if (typeof scenarioId !== "string") {
      return c.json({ error: "scenarioId must be a string" }, 400)
    }

    if (!store.scenarios.has(scenarioId)) {
      return c.json({ error: `Scenario not found: ${scenarioId}` }, 404)
    }

    if (isRunning()) {
      return c.json({ error: "A run is already in progress" }, 409)
    }

    const runId = randomUUID()
    const run = startRun(runId, scenarioId)

    log.info({ runId, scenarioId }, "Run started")

    const scenario = store.scenarios.get(scenarioId)!
    const site = store.sites.get(scenario.siteId)!
    executeScenario(scenario, site, { logger: log }).catch((err) => {
      log.error({ err, runId }, "Run promise rejected unexpectedly")
    })

    return c.json({ runId: run.runId, status: run.status }, 202)
  })

  app.get("/api/runs/:runId", (c) => {
    const runId = c.req.param("runId")
    const run = getCurrentRun()
    if (!run || run.runId !== runId) {
      return c.json({ error: "Run not found" }, 404)
    }
    return c.json(run)
  })

  app.use("*", serveStatic({ root: "./dist/client" }))
  app.get("*", serveStatic({ path: "./dist/client/index.html" }))

  return app
}
