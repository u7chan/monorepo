import preact from "@preact/preset-vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import { PAIR_NEW_PATH, routingPathname } from "./src/server/routing-path"

// proxy 先はサーバーの待ち受けと同じ PORT から導出する。理由は docs/adr/0001-dev-ports.md を参照。
const apiPort = process.env.PORT ?? "18081"

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        bypass(req, res) {
          // 発行 API は送信元が loopback のときだけ通す。Vite の proxy を経由させると、サーバーから見た
          // 送信元が loopback になり、LAN のスマホからの発行要求まで通ってしまうためここで拒否する。
          // 判定は Hono と同じ関数で行う。URL.pathname では %6e のような復号を取りこぼし、
          // Hono が decodeURI してから照合する発行ルートを素通りさせてしまう。
          const target = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

          if (res === undefined || routingPathname(target) !== PAIR_NEW_PATH) {
            return undefined
          }

          res.statusCode = 403
          res.setHeader("content-type", "application/json; charset=utf-8")
          res.end(JSON.stringify({ error: "forbidden" }))

          // 応答を閉じただけでは Vite は proxy へ進む。文字列を返すと `res.writableEnded` を見て
          // next() せずに戻るため、転送されない。
          return req.url ?? "/"
        },
      },
    },
  },
})
