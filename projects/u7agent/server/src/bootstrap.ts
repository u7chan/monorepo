import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { AppDb } from "./app-db";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { createArchiveSettings } from "./archive-settings";
import type { ArchiveSettings } from "./archive-settings";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { messageFor } from "./http";
import { ModelSettingsService, type CredentialCommit, type ProviderKeyRuntime } from "./model-settings";
import { NotificationService } from "./notifications";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type { SandboxRuntimeDiagnostics, SandboxWorkspaceClient } from "./sandbox/client";
import { SessionStore } from "./sessions";
import { prepareSessionStore, resolveSessionStoreDir } from "./session-store";

export type CreateBffAppOptions = {
  cwd?: string;
  /** null を渡すとランタイム構築をスキップする (テスト用) */
  pi?: PiBff | null;
  /** 未指定なら env から生成し、null なら未設定として 503 を返す */
  workspace?: SandboxWorkspaceClient | null;
  /**
   * 診断専用クライアント。未指定なら env から生成したサンドボックスクライアントを再利用する
   * (workspace を差し替えたテストでは null。既存の workspace スタブへ診断メソッドを要求しない)。
   */
  runtimeDiagnostics?: SandboxRuntimeDiagnostics | null;
  clientDistDir?: string;
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/u7agent/sessions) */
  sessionStoreDir?: string | null;
  /** 通知送信のテスト用。省略時は globalThis.fetch */
  notificationFetch?: typeof fetch;
};

export type SessionStoreStatus = {
  /** null は永続化なし */
  path: string | null;
  ok: boolean;
  error?: string;
};

export type BffContext = {
  cwd: string;
  pi: PiBff | null;
  initError: string | undefined;
  catalog: AgentCatalog;
  projects: ProjectStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  /** 実行環境の診断。workspace とは別に注入でき、null なら not_configured を返す */
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
  sessionStore: SessionStoreStatus;
  /** アプリデータ (プロジェクト / カタログ) の DB。status() を health へ出す */
  appDb: AppDb;
  /** Discord 通知。ラン完了時の送信と設定 API の両方から使う */
  notifications: NotificationService;
  /** アーカイブの除外名。health と download / check が同じ実効値を取る */
  archiveSettings: ArchiveSettings;
  /** プロバイダー API キー (設定 → モデル)。DB を希望状態として SDK へ写す */
  modelSettings: ModelSettingsService;
};

export async function createBffContext(opts: CreateBffAppOptions = {}): Promise<BffContext> {
  const cwd = opts.cwd ?? process.cwd();
  let pi: PiBff | null = opts.pi ?? null;
  let initError: string | undefined;
  if (opts.pi === undefined) {
    try {
      pi = await createPiBff({ cwd });
    } catch (error) {
      initError = messageFor(error);
      console.error(`[u7agent] Pi runtime unavailable: ${initError}`);
    }
  }
  // DB の例外文言に登録済みキーが現れても、ログ / health / 503 に生のまま載せない境界を先に作る。
  // 可変マスカーなので、起動後に登録されたキーにも効く。pi が無いときだけ identity に落ちる。
  const maskError = (text: string): string => (pi ? pi.secretMasker.mask(text) : text);

  // 会話ストアはサンドボックスと共有しない。設定ミス (ワークスペース内の指定) は永続化なしに落とし、
  // health で理由を見せてセッション作成だけを 503 で止める。
  let sessionStore: SessionStoreStatus = { path: null, ok: true };
  let sessionStoreError: string | undefined;
  let storeDir: string | null = null;
  try {
    storeDir = opts.sessionStoreDir !== undefined ? opts.sessionStoreDir : resolveSessionStoreDir({ rootCwd: cwd });
  } catch (error) {
    sessionStoreError = messageFor(error);
    console.error(`[u7agent] session store unavailable: ${sessionStoreError}`);
  }
  if (storeDir) sessionStore = { path: storeDir, ok: true };
  else if (sessionStoreError) sessionStore = { path: null, ok: false, error: sessionStoreError };

  // アプリデータの DB は会話ストアと同じディレクトリへ併置するため、先にディレクトリを用意する。
  // パス解決に失敗しているときはメモリ DB へ逃がさず、DB も使えない状態にする。
  if (storeDir) {
    try {
      await prepareSessionStore(storeDir);
    } catch (error) {
      sessionStoreError = messageFor(error);
      sessionStore = { path: storeDir, ok: false, error: sessionStoreError };
      console.error(`[u7agent] session store unavailable: ${sessionStoreError}`);
    }
  }
  const appDb = sessionStoreError
    ? AppDb.unavailable({ storeDir, error: sessionStoreError, sanitizeError: maskError })
    : AppDb.open({ storeDir, sanitizeError: maskError });

  // プロバイダー API キーは DB を希望状態の正とし、起動時に SDK の runtime overlay へ写す。
  // 失敗しても起動は続け、degraded として設定画面から回復できるようにする。
  const modelSettings = new ModelSettingsService({
    db: appDb,
    runtime: pi ? createProviderKeyRuntime(pi) : null,
    retainSecret: pi ? pi.retainSecret : () => {},
    maskError,
    refreshModelState: pi ? pi.refreshModelState : async () => {},
    defaultModel: () => {
      const model = pi?.selectedModel;
      return model ? `${model.provider}/${model.id}` : undefined;
    },
    whitelistConfigured: () => pi?.runtimeDiagnostics?.summary.whitelistConfigured ?? false,
  });
  await modelSettings.applyStored();
  // 組み込みスキルはサンドボックスに依らず起動時に読み込み済みなので、カタログの応答へそのまま載せる
  const catalog = createAgentCatalog({
    builtinSkills: BUILTIN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description })),
    db: appDb,
  });
  const projects = new ProjectStore(appDb);
  // 通知はセッションと同じ secret masker を使い、本文とエラーから秘密値を落とす
  const notifications = new NotificationService({
    db: appDb,
    masker: pi?.secretMasker,
    fetchImpl: opts.notificationFetch,
  });
  // アーカイブの除外名は設定ストアが唯一の決定点で、サンドボックスへはリクエストごとに渡す
  const archiveSettings = createArchiveSettings({ db: appDb });
  // 作業領域の操作はモデルランタイムとは独立に生成する (APIキー未設定で ready: false でもツリーは開けるように)
  const sandboxClient = opts.workspace !== undefined ? undefined : createSandboxToolClientFromEnv(process.env);
  const workspace = opts.workspace !== undefined ? opts.workspace : (sandboxClient ?? null);
  const runtimeDiagnostics = opts.runtimeDiagnostics !== undefined ? opts.runtimeDiagnostics : (sandboxClient ?? null);
  const store = new SessionStore({
    pi,
    catalog,
    masker: pi?.secretMasker,
    projects,
    storeDir,
    storeError: sessionStoreError,
    workspace,
    rootCwd: cwd,
    notifications,
  });
  if (storeDir) {
    try {
      await store.init();
    } catch (error) {
      // 準備に失敗したらセッション作成も 503 で止める (メモリだけの黙ったフォールバックをしない)
      sessionStoreError = messageFor(error);
      store.markStoreUnavailable(sessionStoreError);
      sessionStore = { path: storeDir, ok: false, error: sessionStoreError };
      console.error(`[u7agent] session store init failed: ${sessionStoreError}`);
    }
  }
  return {
    cwd,
    pi,
    initError,
    catalog,
    projects,
    store,
    workspace,
    runtimeDiagnostics,
    sessionStore,
    appDb,
    notifications,
    archiveSettings,
    modelSettings,
  };
}

/**
 * SDK の ModelRuntime を ProviderKeyRuntime へ写す。SDK の例外は throw せず CredentialCommit へ分類し、
 * `credential` / `cause` / 生の例外文言はこの境界から外へ出さない。
 */
export function createProviderKeyRuntime(pi: PiBff): ProviderKeyRuntime {
  const { modelRuntime } = pi;
  return {
    list: () =>
      modelRuntime.getProviders().map((provider) => ({
        provider: provider.id,
        name: provider.name || provider.id,
        // auth.apiKey.login は「対話でキー入力を受け付ける」印。ambient / keyless は login を持たない
        canSetApiKey: Boolean(provider.auth?.apiKey?.login),
        supportsOAuth: Boolean(provider.auth?.oauth),
      })),
    auth: (provider) => modelRuntime.getProviderAuthStatus(provider),
    applyApiKey: (provider, apiKey, { signal }) =>
      commitCredential("setRuntimeApiKey", provider, signal, () =>
        modelRuntime.setRuntimeApiKey(provider, apiKey, { signal }),
      ),
    removeApiKey: (provider, { signal }) =>
      commitCredential("removeRuntimeApiKey", provider, signal, () =>
        modelRuntime.removeRuntimeApiKey(provider, { signal }),
      ),
  };
}

/**
 * SDK は Map への commit 後に同期が失敗した場合も CSE を投げるため、例外を「未適用」と見なさない。
 * provider / operation が一致する CSE だけを commit 済みと判定し、timeout・実行中 abort は unknown に倒す。
 */
async function commitCredential(
  operation: "setRuntimeApiKey" | "removeRuntimeApiKey",
  provider: string,
  signal: AbortSignal,
  run: () => Promise<unknown>,
): Promise<CredentialCommit> {
  // 開始前と確実に識別できる abort だけを not_applied とする (呼び出し側の timeout が先に切れている場合)。
  if (signal.aborted) return { outcome: "not_applied" };
  try {
    await run();
    return { outcome: "applied", synced: true };
  } catch (error) {
    if (error instanceof CredentialSynchronizationError) {
      return error.providerId === provider && error.operation === operation
        ? { outcome: "applied", synced: false }
        : { outcome: "unknown" };
    }
    return { outcome: "unknown" };
  }
}
