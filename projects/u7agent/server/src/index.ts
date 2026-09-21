import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createBffApp } from "./app";

// pnpm --filter で起動すると cwd が server/ になるため、既定はリポジトリルートにする
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE = resolve(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || "127.0.0.1";

async function main() {
  const bff = await createBffApp({ cwd: process.env.PI_APP_CWD || REPO_ROOT });
  serve({ fetch: bff.app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[u7agent] http://${HOST}:${info.port}`);
    console.log(`[u7agent] working directory: ${bff.pi?.cwd || process.cwd()}`);
    console.log(
      bff.sessionStore.ok
        ? `[u7agent] session store: ${bff.sessionStore.path ?? "disabled"}`
        : `[u7agent] session store unavailable: ${bff.sessionStore.error ?? "unknown"}`,
    );
    if (!bff.pi?.selectedModel) {
      console.log("[u7agent] API key or pi authentication is required before sending a message.");
    }
    if (!bff.pi?.sandboxConfigured) {
      console.log(
        "[u7agent] sandbox is not configured (PI_SANDBOX_URL / PI_SANDBOX_TOKEN): tool execution and new sessions fail with 503. See the local startup steps in README.",
      );
    }
  });

  const shutdown = async () => {
    await bff.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
