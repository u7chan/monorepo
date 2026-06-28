import { Hono } from "hono"
import { createApp } from "./app"
import { logger } from "./logger"

try {
  const app = await createApp()

  const hono = new Hono()
  hono.route("/", app)

  const PORT = 3000
  Bun.serve({ fetch: hono.fetch, port: PORT })
  logger.info({ port: PORT }, "Server started")
} catch (error) {
  logger.fatal(error, "Server startup failed")
  process.exit(1)
}
