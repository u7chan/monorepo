import { Hono } from "hono"
import { authMiddleware, requireAuthMiddleware } from "./middleware/auth"
import apiRoutes from "./routes/api"
import authRoutes from "./routes/auth"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import type { AppBindings } from "./types"
import { validateAuthConfig } from "./utils/auth"

const app = new Hono<AppBindings>()

validateAuthConfig(process.env.USERS_FILE, process.env.SESSION_SECRET)

app.use("*", authMiddleware)
app.use("*", requireAuthMiddleware)

app.route("/", authRoutes)
app.route("/api", apiRoutes)
app.route("/", browseRoutes)
app.route("/file", fileRoutes)

export default app
