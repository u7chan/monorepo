import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 診断のスナップショットに載せるビルド識別子。同じタブがどのビルドを実行していたかを後から決められるように、
// ビルドのたびに変わる値 (モード + ビルド時刻) を埋める。サーバー側の識別子とは独立。
const buildId = `${process.env.NODE_ENV ?? "development"}@${new Date().toISOString()}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __U7AGENT_BUILD__: JSON.stringify(buildId),
  },
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
