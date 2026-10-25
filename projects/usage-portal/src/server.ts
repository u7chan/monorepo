import index from "../index.html";
import { createApp } from "./server/app";
import { createAuthService } from "./server/auth";
import { loadConfig } from "./server/config";
import { openDatabase, verifyDatabase, type DatabaseHandle } from "./server/db";
import { buildHealthReport } from "./server/health";
import { readPackageVersion, userAgentFor } from "./server/version";

process.umask(0o077);

const config = loadConfig(process.env, readPackageVersion());
const auth = createAuthService({ dataDir: config.dataDir });

try {
  auth.ensureSessionKey();
} catch (error) {
  console.error("セッション鍵を用意できませんでした:", error instanceof Error ? error.message : "unknown");
}

let database: DatabaseHandle | null = null;

try {
  database = openDatabase(config.dataDir);
} catch (error) {
  console.error("SQLite を開けませんでした:", error instanceof Error ? error.message : "unknown");
}

const app = createApp({
  auth,
  health: () => buildHealthReport(database && verifyDatabase(database) ? "ok" : "error", auth.status()),
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: {
    "/": index,
    // アイコンは index.html の data URI に置く。ここに実体を置くとアイコンの定義が 2 か所になるため、
    // /favicon.ico を無条件に要求するクライアントへは空の応答だけ返して 404 にしない。
    "/favicon.ico": () => new Response(null, { status: 204 }),
  },
  // Bun の server を env として渡す。connection info (レート制限のキー) はここからしか取れない。
  fetch: (request, server) => app.fetch(request, { server }),
});

const authState = auth.status();

console.log(`usage-portal を起動しました: http://${config.host}:${server.port}`);
console.log(`User-Agent: ${userAgentFor(config.version)}`);
console.log(
  authState === "setup_required"
    ? "PIN は未設定です。初回アクセスでセットアップしてください。"
    : `認証の状態: ${authState}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    database?.close();
    process.exit(0);
  });
}
