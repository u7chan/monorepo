import { mkdir } from "node:fs/promises"
import { Hono } from "hono"
import apiRoutes from "./routes/api"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import type { AppBindings } from "./types"
import { DEFAULT_UPLOAD_DIR } from "./utils/requestUtils"

// Ensure UPLOAD_DIR exists
const uploadDir = process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR
await mkdir(uploadDir, { recursive: true })

const app = new Hono<AppBindings>()

app.route("/api", apiRoutes)
app.route("/", browseRoutes)
app.route("/file", fileRoutes)

export default app
