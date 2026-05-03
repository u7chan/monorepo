import { inertia } from "@hono/inertia"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { rootView } from "./root-view"

const app = new Hono()
  .use(
    "/static/*",
    serveStatic({
      root: "./public",
      rewriteRequestPath: (path) => path.replace(/^\/static/, ""),
    }),
  )
  .use(inertia({ version: "1", rootView }))
  .get("/", (c) => {
    return c.render("Root")
  })

export default app
