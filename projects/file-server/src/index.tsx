import { Hono } from "hono"
import apiRoutes from "./routes/api"
import browseRoutes from "./routes/browse"
import fileRoutes from "./routes/file"
import type { AppBindings } from "./types"

const app = new Hono<AppBindings>()

app.route("/api", apiRoutes)
app.route("/", browseRoutes)
app.route("/", fileRoutes)

export default app
