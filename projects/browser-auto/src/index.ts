import { Hono } from "hono"

const app = new Hono()

app.get("/", (c) => c.text("Hello, Hono!"))

Bun.serve({ fetch: app.fetch, port: 3000 })
