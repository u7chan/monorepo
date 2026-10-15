import preact from "@preact/preset-vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// サーバーと同じ PORT を見て proxy 先を決める。片方だけ変えると dev で API だけ届かなくなるため、
// 別ポートで 2 つ目を起動するときは PORT と VITE_PORT を両方指定する（README 参照）。
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
