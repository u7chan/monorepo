import preact from "@preact/preset-vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// proxy 先はサーバーの待ち受けと同じ PORT から導出する。理由は docs/adr/0001-dev-ports.md を参照。
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
