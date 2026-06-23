import { Hono } from "hono"
import app from "./app"

const hono = new Hono()
hono.route("/", app)

const PORT = 3000
console.info(`Server running at http://localhost:${PORT}`)

Bun.serve({ fetch: hono.fetch, port: PORT })
