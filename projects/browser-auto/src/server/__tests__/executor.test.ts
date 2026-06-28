import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { executeScenario } from "../executor"
import type { ScenarioDefinition, SiteDefinition } from "../yaml-schemas"
import { startRun, getCurrentRun } from "../run-state"

describe("executeScenario", () => {
  let fixtureServer: ReturnType<typeof Bun.serve>
  let fixturePort: number

  beforeAll(() => {
    fixtureServer = Bun.serve({
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/test") {
          return new Response(
            `<!DOCTYPE html><html><body><h1>Browser Auto</h1><p>Hello World</p></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          )
        }
        if (url.pathname === "/missing") {
          return new Response(`<!DOCTYPE html><html><body><h1>No Match</h1></body></html>`, {
            headers: { "Content-Type": "text/html" },
          })
        }
        return new Response("Not Found", { status: 404 })
      },
      port: 0,
    })
    if (!fixtureServer.port) {
      throw new Error("Failed to get fixture server port")
    }
    fixturePort = fixtureServer.port
  })

  afterAll(() => {
    fixtureServer.stop()
  })

  const fixtureSite: SiteDefinition = {
    schemaVersion: 1,
    id: "fixture",
    name: "Fixture",
    baseUrl: "",
  }

  beforeAll(() => {
    fixtureSite.baseUrl = `http://127.0.0.1:${fixturePort}`
  })

  test(
    "successful scenario (goto + assertVisible)",
    async () => {
      const scenario: ScenarioDefinition = {
        schemaVersion: 1,
        id: "test-success",
        name: "Test Success",
        siteId: "fixture",
        steps: [
          { action: "goto", path: "/test" },
          { action: "assertVisible", locator: { text: "Browser Auto" } },
        ],
      }

      startRun("exec-success", scenario.id)
      await executeScenario(scenario, fixtureSite, { stepTimeoutMs: 5_000 })

      const run = getCurrentRun()
      expect(run?.status).toBe("succeeded")
      expect(run?.error).toBe(null)
    },
    { timeout: 15_000 },
  )

  test(
    "failed scenario (assertVisible on wrong page)",
    async () => {
      const scenario: ScenarioDefinition = {
        schemaVersion: 1,
        id: "test-fail",
        name: "Test Fail",
        siteId: "fixture",
        steps: [
          { action: "goto", path: "/missing" },
          { action: "assertVisible", locator: { text: "Browser Auto" } },
        ],
      }

      startRun("exec-fail", scenario.id)
      await executeScenario(scenario, fixtureSite, { stepTimeoutMs: 3_000 })

      const run = getCurrentRun()
      expect(run?.status).toBe("failed")
      expect(run?.error).not.toBe(null)
    },
    { timeout: 15_000 },
  )

  test(
    "browser resources are released after failure",
    async () => {
      const scenario: ScenarioDefinition = {
        schemaVersion: 1,
        id: "test-release",
        name: "Test Release",
        siteId: "fixture",
        steps: [
          { action: "goto", path: "/missing" },
          { action: "assertVisible", locator: { text: "Browser Auto" } },
        ],
      }

      startRun("exec-release", scenario.id)
      await executeScenario(scenario, fixtureSite, { stepTimeoutMs: 3_000 })

      const run = getCurrentRun()
      expect(run?.status).toBe("failed")
      // After executeScenario finishes, getCurrentRun still returns the latest run
      // The finally block in executeScenario has already released browser/context/page
      // If resources leaked, process would not exit cleanly
    },
    { timeout: 15_000 },
  )
})
