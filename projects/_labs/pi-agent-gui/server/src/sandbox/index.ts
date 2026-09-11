/**
 * サンドボックス側の起動エントリ (BFF とは別プロセス・別コンテナ。同一イメージを command 差し替えで共用する)。
 * 環境変数は docs/api.md を参照。listen はこのファイルだけが行う。
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SANDBOX_DEFAULT_PORT } from "./protocol";
import { createSandboxService } from "./service";

const ENTRY_PATH = fileURLToPath(import.meta.url);

const PORT = Number(process.env.SANDBOX_PORT) || SANDBOX_DEFAULT_PORT;
const HOST = process.env.SANDBOX_HOST || "0.0.0.0";
const ROOT_CWD = process.env.PI_SANDBOX_CWD || "/workspace";
const TOKEN = process.env.PI_SANDBOX_TOKEN?.trim() ?? "";

async function main() {
  if (TOKEN.length < 16) {
    console.error(
      "[pi-agent-gui-sandbox] PI_SANDBOX_TOKEN に 16 文字以上の共有トークンを設定してください (未認証要求は拒否されます)。",
    );
    process.exit(1);
  }
  // 永続作業領域が無い場合 (ローカル実行など) はここで作る。
  await mkdir(ROOT_CWD, { recursive: true });

  const service = createSandboxService({ token: TOKEN, rootCwd: ROOT_CWD });
  const server = serve({ fetch: service.app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[pi-agent-gui-sandbox] http://${HOST}:${info.port}`);
    console.log(`[pi-agent-gui-sandbox] working directory: ${ROOT_CWD}`);
  });

  const shutdown = () => {
    service.close();
    server.close(() => process.exit(0));
    // 実行中の子プロセス回収を待っても閉じない場合の保険。
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// cwd 相対の .env は読まない (pnpm --filter 起動では cwd が server/ になり、環境変数はデプロイ側が渡す)。
if (process.argv[1] && resolve(process.argv[1]) === ENTRY_PATH) {
  await main();
}
