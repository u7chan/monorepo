import { Hono } from "hono"
import { serveStatic } from "hono/bun"

const app = new Hono()

app.use("*", serveStatic({ root: "./dist/client" }))
app.get("*", serveStatic({ path: "./dist/client/index.html" }))

export default app
