import { Hono, type Env } from "hono"
import { randomUUID } from "node:crypto"
import type { DefinitionStore } from "../scenarios/loader"
import { isRunning, startRun, getCurrentRun } from "./state"
import { executeScenario } from "./executor"
import type pino from "pino"

interface RunRouteEnv extends Env {
  Variables: {
    reqId: string
    logger: pino.Logger
  }
}

export function runRoutes(store: DefinitionStore): Hono<RunRouteEnv> {
  const routes = new Hono<RunRouteEnv>()

  routes.post("/api/runs", async (c) => {
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

  routes.get("/api/runs/:runId", (c) => {
    const runId = c.req.param("runId")
    const run = getCurrentRun()
    if (!run || run.runId !== runId) {
      return c.json({ error: "Run not found" }, 404)
    }
    return c.json(run)
  })

  return routes
}
