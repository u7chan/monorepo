import preact from "@preact/preset-vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// proxy 先を別の変数にすると指定漏れで /api だけ届かなくなるため、サーバーの待ち受けと同じ PORT を共有する。
// 別ポートで 2 つ目を起動するときは、変えなかった側の衝突を避けるため PORT と VITE_PORT を両方指定する（README 参照）。
const apiPort = process.env.PORT ?? "3000"

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
      },
    },
  },
})
