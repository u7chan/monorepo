import { Hono } from "hono"
import {
  accessLogMiddleware,
  createAccessLogger,
  type AccessLogger,
  type CreateAccessLoggerOptions,
} from "./access-logger"
import type { Harness } from "./harness"

export interface AppDeps {
  harness: Harness
  accessLogger?: AccessLogger
  accessLoggerOptions?: CreateAccessLoggerOptions
}

export function createApp(deps: AppDeps) {
  const { harness } = deps
  const app = new Hono()

  const accessLogger =
    deps.accessLogger ?? createAccessLogger(deps.accessLoggerOptions)
  app.use(accessLogMiddleware(accessLogger))

  app.get("/", (c) => {
    return c.text("Hello Hono!")
  })

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" })
  })

  app.post("/prompt", async (c) => {
    const body = (await c.req.json()) as { prompt?: unknown } | null
    const prompt = body?.prompt

    if (typeof prompt !== "string" || prompt.trim() === "") {
      return c.json({ error: "prompt must be a non-empty string" }, 400)
    }

    const result = await harness.prompt(prompt)
    return c.json({ result })
  })

  return app
}
