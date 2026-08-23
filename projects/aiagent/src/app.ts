import { Hono } from "hono"

export function createApp() {
  const app = new Hono()

  app.get("/", (c) => {
    return c.text("Hello Hono!")
  })

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" })
  })

  return app
}
