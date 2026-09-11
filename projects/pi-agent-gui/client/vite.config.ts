import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // BFF (pnpm dev / pnpm start) へ API を転送する
      "/api": "http://127.0.0.1:4317",
    },
  },
});
