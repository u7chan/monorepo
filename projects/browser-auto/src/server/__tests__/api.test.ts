import { describe, expect, test, beforeAll } from "bun:test"
import { createApp } from "../app"
import { isRunning } from "../run-state"
import type { Hono } from "hono"

describe("API routes", () => {
  let app: Hono
  let baseUrl: string

  beforeAll(async () => {
    app = await createApp()

    const server = Bun.serve({
      fetch: app.fetch,
      port: 0,
    })
    const addr = server.port
    baseUrl = `http://127.0.0.1:${addr}`
  })

  test("POST /api/runs with valid scenario returns 202", async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId: "smoke" }),
    })
    expect(res.status).toBe(202)
    const data = await res.json()
    expect(data.runId).toBeDefined()
    expect(data.status).toBe("running")
  })

  test("POST /api/runs with invalid JSON returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe("Invalid JSON")
  })

  test("POST /api/runs without scenarioId returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain("scenarioId")
  })

  test("POST /api/runs with unknown scenario returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId: "nonexistent" }),
    })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain("Scenario not found")
  })

  test("GET /api/runs/:runId with stale id returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/runs/stale-id`)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe("Run not found")
  })

  test("SPA catch-all still works", async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
  })

  test(
    "POST /api/runs concurrent request returns 409",
    async () => {
      // Wait for any previous run to finish
      while (isRunning()) {
        await Bun.sleep(100)
      }

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: "smoke" }),
        }),
        fetch(`${baseUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: "smoke" }),
        }),
      ])

      const statuses = [res1.status, res2.status].sort()
      expect(statuses).toContain(202)
      expect(statuses).toContain(409)
    },
    { timeout: 40_000 },
  )
})
