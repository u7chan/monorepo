import index from "../index.html";
import { createApp } from "./server/app";
import { createAuthService } from "./server/auth";
import { createCodexApi } from "./server/codex/api";
import { createCodexAuth } from "./server/codex/auth";
import { createCodexLoginService } from "./server/codex/login";
import { loadConfig } from "./server/config";
import { prepareCredentialDir } from "./server/credential-dir";
import { openDatabase, verifyDatabase, type DatabaseHandle } from "./server/db";
import { buildHealthReport } from "./server/health";
import { createOpenCodeApi } from "./server/opencode/api";
import { createOpenCodeAuth } from "./server/opencode/auth";
import { CODEX_PROVIDER, OPENCODE_PROVIDER } from "./server/providers";
import { fetchCodexUsage } from "./server/providers/codex";
import { fetchOpenCodeUsage } from "./server/providers/opencode-go";
import { createSampler, type UsageFetcher } from "./server/sampler";
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
const openCodeAuth = createOpenCodeAuth({ credentialDir: config.credentialDir });
const fetchers: UsageFetcher[] = [
  {
    provider: CODEX_PROVIDER,
    fetch: () => fetchCodexUsage({ source: codexAuth, userAgent, now: Date.now }),
  },
  {
    provider: OPENCODE_PROVIDER,
    fetch: () => fetchOpenCodeUsage({ apiKey: openCodeAuth.apiKey(), userAgent, now: Date.now }),
  },
];
const sampler = createSampler({ db: database, fetchers, intervalMs: config.pollIntervalMs, now: Date.now, log });
const codexLogin = createCodexLoginService({ auth: codexAuth, onSuccess: () => sampler.kick(), log });
const codex = createCodexApi({ auth: codexAuth, login: codexLogin, db: database, sampler });
const opencode = createOpenCodeApi({
  auth: openCodeAuth,
  db: database,
  sampler,
  fetchUsage: (apiKey) => fetchOpenCodeUsage({ apiKey, userAgent, now: Date.now }),
});

const app = createApp({
  auth,
  codex,
  opencode,
  usage: createUsageReader({ db: database, sampleIntervalMs: config.pollIntervalMs, now: Date.now }),
  health: () => buildHealthReport(verifyDatabase(database) ? "ok" : "error", auth.status()),
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

sampler.start();

const authState = auth.status();

console.log(`usage-portal を起動しました: http://${config.host}:${server.port}`);
console.log(`User-Agent: ${userAgent}`);
console.log(
  authState === "setup_required"
    ? "PIN は未設定です。初回アクセスでセットアップしてください。"
    : `認証の状態: ${authState}`,
);
console.log(`Codex: ${codexAuth.signedIn() ? "サインイン済み" : "未接続"}`);
console.log(`OpenCode Go: ${openCodeAuth.state().configured ? "API キー登録済み" : "API キー未登録"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sampler.stop();
    server.stop();
    database.close();
    process.exit(0);
  });
}
