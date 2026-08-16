import { constants } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import type { AppBindings } from "../types"
import { getUploadDir } from "../utils/requestUtils"

const healthzRoutes = new Hono<AppBindings>()

healthzRoutes.get("/healthz", async (c) => {
  c.header("Cache-Control", "no-store")

  const uploadDir = getUploadDir(c)
  const accessMode = constants.R_OK | constants.W_OK | constants.X_OK

  try {
    await Promise.all([
      access(path.join(uploadDir, "public"), accessMode),
      access(path.join(uploadDir, "private"), accessMode),
    ])

    return c.json({ status: "ok" })
  } catch {
    return c.json({ status: "unavailable" }, 503)
  }
})

export default healthzRoutes
