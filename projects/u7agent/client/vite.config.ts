import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 3000,
    strictPort: true,
    proxy: {
      // BFF (pnpm dev / pnpm start) へ API を転送する。scripts/dev.mjs は PORT を BFF と揃えて渡す
      "/api": {
        target: `http://127.0.0.1:${Number(process.env.PORT) || 4317}`,
        // Origin の検証に外部 Host を使う。文字列 shorthand は changeOrigin: true になる。
        changeOrigin: false,
      },
    },
  },
});
