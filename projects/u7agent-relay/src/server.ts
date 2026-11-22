import index from "../index.html";
import { createApp } from "./server/app";
import { createAuthService } from "./server/auth";
import { createConnectionService, createKeyService } from "./server/connections";
import { loadConfig } from "./server/config";
import { createStore, openDatabase } from "./server/db";
import { createRelay } from "./server/relay";
import { createUpstreamClient } from "./server/upstream";
import { readPackageVersion } from "./server/version";

process.umask(0o077);

const config = loadConfig(process.env, readPackageVersion());
const auth = createAuthService({ dataDir: config.dataDir });

try {
  auth.ensureSessionKey();
} catch {
  // 鍵が無い状態でも起動は続ける。healthz と /api/auth/session で状態を切り分けられる。
  console.error("セッション鍵を用意できませんでした");
}

const database = openDatabase(config.dataDir);
const store = createStore(database);
// 監査に要る範囲だけ残す。実行履歴は本文を含むため、無期限に増やさない。
const prunedRuns = store.pruneRuns(Date.now() - 90 * 24 * 60 * 60 * 1000);
const upstream = createUpstreamClient();
const relay = createRelay({ store, upstream, now: Date.now });
const connections = createConnectionService({ store, upstream, now: Date.now });
const keys = createKeyService({ store, now: Date.now });

const app = createApp({
  auth,
  store,
  relay,
  connections,
  keys,
  version: config.version,
  trustProxy: config.trustProxy,
  cookieSecure: config.cookieSecure,
  appOrigin: config.appOrigin,
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: {
    "/": index,
  },
  // Bun の server を env として渡す。connection info (レート制限のキー) はここからしか取れない。
  fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
});

console.log(`u7agent-relay を起動しました: http://${config.host}:${server.port}`);
console.log(`バージョン: ${config.version}`);
console.log(
  auth.status() === "setup_required"
    ? "PIN は未設定です。初回アクセスでセットアップしてください。"
    : `認証の状態: ${auth.status()}`,
);
console.log(`接続先: ${store.listConnections().length} 件 / API キー: ${store.listKeys().length} 件`);
if (prunedRuns > 0) {
  console.log(`90 日を過ぎた実行履歴を ${prunedRuns} 件削除しました`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    database.close();
    process.exit(0);
  });
}
