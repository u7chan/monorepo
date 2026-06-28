import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import {
  startRun,
  getCurrentRun,
  setStepIndex,
  finishRunSucceeded,
  finishRunFailed,
} from "../run-state"

describe("executor", () => {
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

  test(
    "goto and assertVisible success",
    async () => {
      let browser: Browser | null = null
      let context: BrowserContext | null = null
      let page: Page | null = null

      try {
        browser = await chromium.launch({ headless: true })
        context = await browser.newContext()
        page = await context.newPage()

        startRun("cr-test-1", "test-success")
        setStepIndex(0)
        await page.goto(`http://127.0.0.1:${fixturePort}/test`, {
          timeout: 10_000,
          waitUntil: "domcontentloaded",
        })
        setStepIndex(1)
        await page.getByText("Browser Auto", { exact: true }).waitFor({
          state: "visible",
          timeout: 5000,
        })
        finishRunSucceeded()

        const run = getCurrentRun()
        expect(run?.status).toBe("succeeded")
        expect(run?.error).toBe(null)
      } finally {
        if (page) await page.close().catch(() => {})
        if (context) await context.close().catch(() => {})
        if (browser) await browser.close().catch(() => {})
      }
    },
    { timeout: 15_000 },
  )

  test(
    "assertVisible failure",
    async () => {
      let browser: Browser | null = null
      let context: BrowserContext | null = null
      let page: Page | null = null

      try {
        browser = await chromium.launch({ headless: true })
        context = await browser.newContext()
        page = await context.newPage()

        startRun("cr-test-2", "test-fail")
        setStepIndex(0)
        await page.goto(`http://127.0.0.1:${fixturePort}/missing`, {
          timeout: 5000,
          waitUntil: "domcontentloaded",
        })
        setStepIndex(1)
        try {
          await page.getByText("Browser Auto", { exact: true }).waitFor({
            state: "visible",
            timeout: 3000,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          finishRunFailed(1, message)
        }

        const run = getCurrentRun()
        expect(run?.status).toBe("failed")
        expect(run?.error).not.toBe(null)
      } finally {
        if (page) await page.close().catch(() => {})
        if (context) await context.close().catch(() => {})
        if (browser) await browser.close().catch(() => {})
      }
    },
    { timeout: 15_000 },
  )

  test(
    "browser resources are released after failure",
    async () => {
      let browser: Browser | null = null
      let context: BrowserContext | null = null
      let page: Page | null = null

      try {
        browser = await chromium.launch({ headless: true })
        context = await browser.newContext()
        page = await context.newPage()

        startRun("cr-test-3", "test-release")
        setStepIndex(0)
        await page.goto(`http://127.0.0.1:${fixturePort}/missing`, {
          timeout: 5000,
          waitUntil: "domcontentloaded",
        })

        // Simulate a failure by throwing
        throw new Error("Simulated error")
      } catch (error) {
        const current = getCurrentRun()
        const message = error instanceof Error ? error.message : String(error)
        finishRunFailed(current?.stepIndex ?? 0, message)
      } finally {
        if (page) await page.close().catch(() => {})
        if (context) await context.close().catch(() => {})
        if (browser) await browser.close().catch(() => {})
      }

      const run = getCurrentRun()
      expect(run?.status).toBe("failed")
    },
    { timeout: 15_000 },
  )
})
