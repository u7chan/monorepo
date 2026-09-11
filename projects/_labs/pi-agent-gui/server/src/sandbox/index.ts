/**
 * サンドボックス ツール実行サービスの起動エントリ。
 * listen はこのファイル (サンドボックス側) だけが行う。BFF の index.ts とは
 * 別プロセス・別コンテナで動く (同一イメージを command 差し替えで共用する)。
 *
 * 必要な環境変数:
 * - PI_SANDBOX_TOKEN: BFF との共有 Bearer トークン (必須、16文字以上)
 * - PI_SANDBOX_CWD:   作業領域 (既定 /workspace。デプロイ側が永続マウントする)
 * - SANDBOX_PORT:     ポート (既定 8080。ホストへ publish しない)
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
  // 永続作業領域がまだ無い場合 (ローカル実行など) は作っておく。
  await mkdir(ROOT_CWD, { recursive: true });

  const service = createSandboxService({ token: TOKEN, rootCwd: ROOT_CWD });
  const server = serve({ fetch: service.app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[pi-agent-gui-sandbox] http://${HOST}:${info.port}`);
    console.log(`[pi-agent-gui-sandbox] working directory: ${ROOT_CWD}`);
  });

  const shutdown = () => {
    service.close();
    server.close(() => process.exit(0));
    // 実行中の子プロセス回収に waits しても閉じない場合の保険。
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// pnpm --filter で起動すると process.cwd() が server/ になるため、明示がない限り
// ローカルの .env は読まない (環境変数はデプロイ側が渡す)。
if (process.argv[1] && resolve(process.argv[1]) === ENTRY_PATH) {
  await main();
}
