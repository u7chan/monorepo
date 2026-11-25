import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 診断のスナップショットに載せるビルド識別子。同じタブがどのビルドを実行していたかを後から決められるように、
// ビルドのたびに変わる値 (モード + ビルド時刻) を埋める。BFF の識別子 (下の版の識別子) とは独立。
const buildStamp = `${process.env.NODE_ENV ?? "development"}@${new Date().toISOString()}`;

/**
 * BFF と突き合わせる版の識別子の既定値。ビルド時に決まる version + コミットの短縮 SHA で、
 * `server/src/build-id.ts` と同じ値になる。dev サーバーは空にして案内を出さない
 * (dev でも `VITE_U7AGENT_BUILD_ID` で差し替えられる。読み込みは `client/src/lib/versionMismatch.ts`)。
 */
function defaultVersionId(command: "build" | "serve"): string {
  if (command !== "build") return "";
  const version = packageVersion();
  const commit = (process.env.COMMIT_HASH ?? "").trim();
  if (version && commit) return `${version}+${commit}`;
  return version || commit;
}

function packageVersion(): string {
  try {
    const json = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof json.version === "string" ? json.version.trim() : "";
  } catch {
    return "";
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __U7AGENT_BUILD__: JSON.stringify(buildStamp),
    __U7AGENT_BUILD_ID__: JSON.stringify(defaultVersionId(command)),
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
}));
