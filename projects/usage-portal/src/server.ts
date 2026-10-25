import index from "../index.html";
import { createApp } from "./server/app";
import { loadAuthConfig } from "./server/auth-config";
import { loadConfig } from "./server/config";
import { openDatabase, verifyDatabase, type DatabaseHandle } from "./server/db";
import { buildHealthReport } from "./server/health";
import { readPackageVersion, userAgentFor } from "./server/version";

process.umask(0o077);

const config = loadConfig(process.env, readPackageVersion());
const auth = loadAuthConfig(process.env);

let database: DatabaseHandle | null = null;

try {
  database = openDatabase(config.dataDir);
} catch (error) {
  console.error("SQLite を開けませんでした:", error instanceof Error ? error.message : "unknown");
}

const app = createApp({
  health: () =>
    buildHealthReport(database && verifyDatabase(database) ? "ok" : "error", auth.ok ? "ok" : "misconfigured"),
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: { "/": index },
  fetch: (request) => app.fetch(request),
});

console.log(`usage-portal を起動しました: http://${config.host}:${server.port}`);
console.log(`User-Agent: ${userAgentFor(config.version)}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    database?.close();
    process.exit(0);
  });
}
