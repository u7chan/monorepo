import index from "../index.html";
import { createApp } from "./server/app";
import { createAuthService } from "./server/auth";
import { createClaudeCli, createClaudePromptCli } from "./server/claude/cli";
import { createClaudeUsageService } from "./server/claude/service";
import { createClaudeStartService } from "./server/claude/start";
import { sendClaudeStart } from "./server/claude/start-prompt";
import { createCodexApi } from "./server/codex/api";
import { createCodexAuth } from "./server/codex/auth";
import { createCodexLoginService } from "./server/codex/login";
import { createFetchIntervalStore } from "./server/fetch-intervals";
import { codexSourceId } from "./server/codex/source";
import { loadConfig } from "./server/config";
import { prepareCredentialDir } from "./server/credential-dir";
import {
  deleteLegacyOpenCodeUsage,
  migrateCodexUsage,
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
import { fetchIntervalMs } from "./shared/fetch-interval";
import { CLAUDE_PROVIDER, CODEX_PROVIDER, OPENCODE_PROVIDER } from "./server/providers";
import { CLAUDE_REFRESH_INTERVAL_MS } from "./server/providers/claude";
import type { ProviderId } from "./server/providers/types";
import { fetchCodexUsage } from "./server/providers/codex";
import { fetchOpenCodeUsage } from "./server/providers/opencode-go";
import { createSampler, PAUSED_RETRY_INTERVAL_MS, type UsageFetcher } from "./server/sampler";
import { loadProviderErrors, loadProviderUsage } from "./server/db";
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

// 旧キーの履歴を、いまサインインしているアカウントのキーへ移す。サインアウト中は何もしない。
try {
  migrateCodexUsage(database, codexSourceId(codexAuth.accountId()));
} catch {
  log("Codex の履歴を引き継げませんでした");
}

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
const fetchers = (): UsageFetcher[] => {
  const errors = loadProviderErrors(database);

  return [
    {
      // サインイン中はアカウント別のキーへ書き、未接続時だけ base キーに error を書く。
      sourceId: codexSourceId(codexAuth.accountId()),
      provider: CODEX_PROVIDER,
      // source id の accountId はログへ出さない。
      logLabel: CODEX_PROVIDER.id,
      fetch: () => fetchCodexUsage({ source: codexAuth, userAgent, now: Date.now }),
    },
    ...openCodeAccounts.list().map((account) => {
      const sourceId = openCodeSourceId(account.id);
      const error = errors.get(sourceId);

      return {
        sourceId,
        provider: OPENCODE_PROVIDER,
        // 契約エラーで止めたアカウントは、取得間隔ではなく失敗時刻から 6 時間後の再確認に落とす。
        pausedUntil: error?.code === "subscription_required" ? error.at + PAUSED_RETRY_INTERVAL_MS : null,
        fetch: () => fetchOpenCodeUsage({ apiKey: openCodeAccounts.apiKey(account.id), userAgent, now: Date.now }),
      };
    }),
  ];
};
// env の POLL_INTERVAL_MS は、画面から設定していない provider の既定値として使う。
const fetchIntervals = createFetchIntervalStore({ db: database, defaultMs: config.pollIntervalMs, log });
// 画面から設定できるのは Codex と OpenCode Go だけ。Claude は周期取得をせず、固定値を使う。
const intervalFor = (provider: ProviderId): number =>
  provider === "claude" ? CLAUDE_REFRESH_INTERVAL_MS : fetchIntervals.get(provider);
const sampler = createSampler({
  db: database,
  fetchers,
  intervalFor,
  now: Date.now,
  log,
});
const codexLogin = createCodexLoginService({ auth: codexAuth, onSuccess: () => sampler.kick("codex"), log });
const claude = createClaudeUsageService({
  db: database,
  cli: createClaudeCli({ credentialDir: config.credentialDir, env: process.env }),
  now: Date.now,
  log,
});
const claudePromptCli = createClaudePromptCli({ credentialDir: config.credentialDir, env: process.env });
const claudeStart = createClaudeStartService({
  db: database,
  now: Date.now,
  refreshUsage: () => claude.refresh("schedule"),
  readSnapshot: () => loadProviderUsage(database, [CLAUDE_PROVIDER.id]).get(CLAUDE_PROVIDER.id)?.snapshot ?? null,
  send: (settings) => sendClaudeStart(claudePromptCli, settings.model, settings.effort),
  log,
});
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
    kick: () => sampler.kick("codex"),
    kickOpenCode: async (accountId) => {
      await sampler.refreshSource(openCodeSourceId(accountId));
    },
    now: Date.now,
    log,
  }),
});

const app = createApp({
  auth,
  trustProxy: config.trustProxy,
  cookieSecure: config.cookieSecure,
  codex,
  opencode,
  claude: {
    refresh: claude.refresh,
    logout: async () => {
      const ok = await claude.logout();

      if (ok) {
        claudeStart.disable();
      }

      return ok;
    },
  },
  claudeStart,
  probe,
  fetchIntervals: {
    read: () => fetchIntervals.list(),
    write: (provider, minutes) => {
      fetchIntervals.set(provider, fetchIntervalMs(minutes));
      // 次回の予定だけを引き直す。設定の変更で上流をすぐ叩き直さない。
      sampler.reschedule(provider);

      return fetchIntervals.list();
    },
  },
  usage: createUsageReader({
    db: database,
    intervalFor,
    nextFetchAt: sampler.nextFetchAt,
    now: Date.now,
    accounts: () => openCodeAccounts.list(),
    codexSourceId: () => codexSourceId(codexAuth.accountId()),
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
claudeStart.start();

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
console.log("Claude: 画面を開いたときと手動更新で取得します（開始予約は設定したときだけ送信します）");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sampler.stop();
    claudeStart.stop();
    server.stop();
    database.close();
    process.exit(0);
  });
}
