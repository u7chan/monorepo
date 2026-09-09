// 起動エントリ (port of src/server.js の main)。listen はこのファイルだけが行う。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createBffApp } from "./app";

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || "127.0.0.1";
// pnpm --filter で起動すると process.cwd() が server/ になるため、既定はリポジトリルート
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main() {
  const bff = await createBffApp({ cwd: process.env.PI_APP_CWD || REPO_ROOT });
  serve({ fetch: bff.app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[pi-agent-gui] http://${HOST}:${info.port}`);
    console.log(`[pi-agent-gui] working directory: ${bff.pi?.cwd || process.cwd()}`);
    if (!bff.pi) console.log("[pi-agent-gui] Set a pi credential/API key before sending a message.");
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
