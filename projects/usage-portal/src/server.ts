import index from "../index.html";
import { createApp } from "./server/app";
import { createAuthService } from "./server/auth";
import { createCodexApi } from "./server/codex/api";
import { createCodexAuth } from "./server/codex/auth";
import { createCodexLoginService } from "./server/codex/login";
import { loadConfig } from "./server/config";
import { prepareCredentialDir } from "./server/credential-dir";
import {
  deleteLegacyOpenCodeUsage,
  openDatabase,
  pruneOpenCodeUsage,
  verifyDatabase,
  type DatabaseHandle,
} from "./server/db";
import { buildHealthReport } from "./server/health";
import { createOpenCodeAccounts, openCodeSourceId } from "./server/opencode/accounts";
import { createOpenCodeApi } from "./server/opencode/api";
import { createProbeApi } from "./server/probe/api";
import { createProbeRunner } from "./server/probe/service";
import { createProbeSettings } from "./server/probe/settings";
import { CODEX_PROVIDER, OPENCODE_PROVIDER } from "./server/providers";
import { fetchCodexUsage } from "./server/providers/codex";
import { fetchOpenCodeUsage } from "./server/providers/opencode-go";
import { createSampler, type UsageFetcher } from "./server/sampler";
import { staticRoutes } from "./server/static";
import { createUsageReader } from "./server/usage";
import { readPackageVersion, userAgentFor } from "./server/version";

process.umask(0o077);

const log = (message: string): void => {
  console.warn(`[usage-portal] ${message}`);
};
const config = loadConfig(process.env, readPackageVersion());
const userAgent = userAgentFor(config.version);
const auth = createAuthService({ dataDir: config.dataDir });

try {
  auth.ensureSessionKey();
} catch {
  // 鍵が無い状態でも起動は続ける。health が misconfigured を返し、原因を切り分けられる。
  console.error("セッション鍵を用意できませんでした");
}

let database: DatabaseHandle;

try {
  database = openDatabase(config.dataDir);
} catch {
  // SQLite が無いと利用枠も認証状態の検査も成り立たない。healthcheck の再起動に任せる。
  console.error("SQLite を開けませんでした");
  process.exit(1);
}

try {
  prepareCredentialDir(config.credentialDir);
} catch {
  // 0600 にできない資格情報ディレクトリで動かすと token が他ユーザーから読める。
  console.error("資格情報ディレクトリを用意できませんでした");
  process.exit(1);
}

const codexAuth = createCodexAuth({ credentialDir: config.credentialDir, log });
const openCodeAccounts = createOpenCodeAccounts({ credentialDir: config.credentialDir, log });
// 送信の設定は秘密ではないので `DATA_DIR` に置く。壊れていても「未設定」として起動する。
const probeSettings = createProbeSettings({ dataDir: config.dataDir, log });

// 単一キー時代の行と、消えたアカウントの行を起動時に回収する。失敗しても取得は続けられる。
try {
  deleteLegacyOpenCodeUsage(database);
} catch {
  log("旧 OpenCode Go の履歴を削除できませんでした");
}

try {
  pruneOpenCodeUsage(
    database,
    openCodeAccounts.list().map((account) => openCodeSourceId(account.id)),
  );
} catch {
  log("登録の無い OpenCode Go の履歴を削除できませんでした");
}

// 取得のたびに評価する。アカウントの追加・削除が再起動なしで次の取得から反映される。
const fetchers = (): UsageFetcher[] => [
  {
    sourceId: CODEX_PROVIDER.id,
    provider: CODEX_PROVIDER,
    fetch: () => fetchCodexUsage({ source: codexAuth, userAgent, now: Date.now }),
  },
  ...openCodeAccounts.list().map((account) => ({
    sourceId: openCodeSourceId(account.id),
    provider: OPENCODE_PROVIDER,
    fetch: () => fetchOpenCodeUsage({ apiKey: openCodeAccounts.apiKey(account.id), userAgent, now: Date.now }),
  })),
];
const sampler = createSampler({ db: database, fetchers, intervalMs: config.pollIntervalMs, now: Date.now, log });
const codexLogin = createCodexLoginService({ auth: codexAuth, onSuccess: () => sampler.kick(), log });
const codex = createCodexApi({ auth: codexAuth, login: codexLogin, db: database, sampler });
const opencode = createOpenCodeApi({
  accounts: openCodeAccounts,
  db: database,
  sampler,
  fetchUsage: (apiKey) => fetchOpenCodeUsage({ apiKey, userAgent, now: Date.now }),
});
const probe = createProbeApi({
  settings: probeSettings,
  runner: createProbeRunner({
    settings: probeSettings,
    accounts: openCodeAccounts,
    credential: () => codexAuth.credential(),
    userAgent,
    kick: () => sampler.kick(),
    now: Date.now,
    log,
  }),
});

const app = createApp({
  auth,
  codex,
  opencode,
  probe,
  usage: createUsageReader({
    db: database,
    sampleIntervalMs: config.pollIntervalMs,
    now: Date.now,
    accounts: () => openCodeAccounts.list(),
  }),
  health: () => buildHealthReport(verifyDatabase(database) ? "ok" : "error", auth.status()),
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: {
    "/": index,
    ...staticRoutes,
  },
  // Bun の server を env として渡す。connection info (レート制限のキー) はここからしか取れない。
  fetch: (request, server) => app.fetch(request, { server }),
});

sampler.start();

const authState = auth.status();
const accountCount = openCodeAccounts.list().length;

console.log(`usage-portal を起動しました: http://${config.host}:${server.port}`);
console.log(`User-Agent: ${userAgent}`);
console.log(
  authState === "setup_required"
    ? "PIN は未設定です。初回アクセスでセットアップしてください。"
    : `認証の状態: ${authState}`,
);
console.log(`Codex: ${codexAuth.signedIn() ? "サインイン済み" : "未接続"}`);
console.log(`OpenCode Go: ${accountCount === 0 ? "アカウント未登録" : `アカウント ${accountCount} 件`}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sampler.stop();
    server.stop();
    database.close();
    process.exit(0);
  });
}
