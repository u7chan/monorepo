import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app"
import { resolveToken } from "./token"

const port = Number(process.env.PORT ?? 18081)
const clientDir = resolve(import.meta.dirname, "../../dist/client")
const token = resolveToken(process.env)

if (!existsSync(resolve(clientDir, "index.html"))) {
  console.warn(
    `クライアントのビルドがありません: ${clientDir}（pnpm start の前に pnpm build。pnpm dev では Vite が配信します）`,
  )
}

const app = createApp({ token: token.value, clientDir })

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`herdr-mobile-client を起動しました: http://127.0.0.1:${info.port}`)

  if (token.source === "generated") {
    console.log("HERDR_CLIENT_TOKEN が未設定のため、トークンを生成しました（再起動で変わります）:")
    console.log(token.value)
  } else {
    console.log("HERDR_CLIENT_TOKEN の値で認証します。")
  }
})
