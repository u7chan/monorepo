import { mkdir } from "node:fs/promises"
import { Hono } from "hono"
import apiRoutes from "./routes/api"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import type { AppBindings } from "./types"

// Ensure UPLOAD_DIR exists (default: ./tmp)
const uploadDir = process.env.UPLOAD_DIR || "./tmp"
await mkdir(uploadDir, { recursive: true })

const app = new Hono<AppBindings>()

app.route("/api", apiRoutes)
app.route("/", browseRoutes)
app.route("/", fileRoutes)

export default app
