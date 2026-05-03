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
  .get("/about", (c) => {
    return c.render("About")
  })
  .get("/users/:id", (c) => {
    const id = c.req.param("id")

    return c.render("UserShow", {
      user: {
        id,
        name: id === "1" ? "Ada Lovelace" : "Grace Hopper",
        role: id === "1" ? "Mathematician" : "Computer Scientist",
      },
      notifications: ["Welcome to the Inertia sample page.", "Props are rendered from the Hono route."],
    })
  })

export default app
