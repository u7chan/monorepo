import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app"

const port = Number(process.env.PORT ?? 3000)
const clientDir = resolve(import.meta.dirname, "../../dist/client")

if (!existsSync(resolve(clientDir, "index.html"))) {
  console.warn(
    `クライアントのビルドがありません: ${clientDir}（pnpm start の前に pnpm build。pnpm dev では Vite が配信します）`,
  )
}

const app = createApp({ clientDir })

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`herdr-mobile-client を起動しました: http://127.0.0.1:${info.port}`)
})
