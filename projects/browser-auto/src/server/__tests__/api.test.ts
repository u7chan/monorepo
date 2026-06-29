import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { createApp } from "../app"
import { isRunning } from "../features/runs/state"

describe("API routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let baseUrl: string
  let fixtureServer: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    app = await createApp()

    const server = Bun.serve({
      fetch: app.fetch,
      port: 0,
    })
    baseUrl = `http://127.0.0.1:${server.port}`

    // Start a fixture server on port 3000 to serve the page the "smoke" scenario expects
    fixtureServer = Bun.serve({
      fetch(_req) {
        return new Response(`<!DOCTYPE html><html><body><h1>Browser Auto</h1></body></html>`, {
          headers: { "Content-Type": "text/html" },
        })
      },
      port: 3000,
    })
  })

  afterAll(() => {
    fixtureServer.stop()
  })

  describe("POST /api/runs", () => {
    it(
      "completes a valid scenario run → succeeded",
      async () => {
        const res = await fetch(`${baseUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: "smoke" }),
        })
        expect(res.status).toBe(202)
        const { runId } = await res.json()
        expect(runId).toBeDefined()

        let run: {
          status: string
          stepIndex: number | null
          finishedAt: string | null
          error: string | null
        } | null = null
        for (let i = 0; i < 100; i++) {
          const getRes = await fetch(`${baseUrl}/api/runs/${runId}`)
          if (getRes.status === 200) {
            run = await getRes.json()
            if (run!.status !== "running") break
          }
          await Bun.sleep(200)
        }

        expect(run).not.toBe(null)
        expect(run!.status).toBe("succeeded")
        expect(run!.stepIndex).toBe(null)
        expect(run!.finishedAt).not.toBe(null)
        expect(run!.error).toBe(null)

        // Start a second run to evict the first runId from memory
        const res2 = await fetch(`${baseUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioId: "smoke" }),
        })
        expect(res2.status).toBe(202)

        // The old runId should now return 404
        const staleRes = await fetch(`${baseUrl}/api/runs/${runId}`)
        expect(staleRes.status).toBe(404)
        const staleData = await staleRes.json()
        expect(staleData.error).toBe("Run not found")

        // Wait for second run to finish so it doesn't interfere with other tests
        const { runId: secondRunId } = await res2.json()
        for (let i = 0; i < 100; i++) {
          const getRes = await fetch(`${baseUrl}/api/runs/${secondRunId}`)
          if (getRes.status === 200) {
            const r = await getRes.json()
            if (r.status !== "running") break
          }
          await Bun.sleep(200)
        }
      },
      { timeout: 40_000 },
    )

    it("returns 400 for invalid JSON body", async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Invalid JSON")
    })

    it("returns 400 when scenarioId is missing", async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain("scenarioId")
    })

    it("returns 404 for unknown scenarioId", async () => {
      const res = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: "nonexistent" }),
      })
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toContain("Scenario not found")
    })

    it(
      "returns 409 when a run is already in progress",
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

  describe("GET /api/runs/:runId", () => {
    it("returns 404 for a stale or nonexistent runId", async () => {
      const res = await fetch(`${baseUrl}/api/runs/stale-id`)
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe("Run not found")
    })
  })

  describe("SPA", () => {
    it("serves index.html on /", async () => {
      const res = await fetch(`${baseUrl}/`)
      expect(res.status).toBe(200)
    })
  })
})
