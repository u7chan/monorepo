import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { ignoredModelEnvironmentVariables } from "./agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { AppDb } from "./app-db";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { createArchiveSettings } from "./archive-settings";
import type { ArchiveSettings } from "./archive-settings";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { messageFor } from "./http";
import { createImageCatalog } from "./image-catalog";
import { ImageSettingsService } from "./image-settings";
import { ModelSettingsService, type CredentialCommit, type ProviderKeyRuntime } from "./model-settings";
import { NotificationService } from "./notifications";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type { SandboxExecClient, SandboxRuntimeDiagnostics, SandboxWorkspaceClient } from "./sandbox/client";
import { SecretService } from "./secrets";
import { SecretKeyError, createSecretCipher, resolveMasterKeys } from "./secret-crypto";
import { ServeService, sandboxHostFromUrl, type ServeProbe } from "./serve";
import { createServeToolHost } from "./serve-tool";
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
  /**
   * プレビュー オリジン (別リスナー) のブラウザから見たポート。env の解決と検証は起動時に 1 回だけ行うため、
   * ここには検証済みの値が入る。未指定は既定 (4318)。待受は別 env (PI_FILE_PREVIEW_LISTEN_PORT) で、prod は compose が publish する
   */
  filePreviewPort?: number;
  /** serve した成果物のブラウザから見たポート。起動時に検証済みの値を渡す */
  previewPort?: number;
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/u7agent/sessions) */
  sessionStoreDir?: string | null;
  /** 通知送信のテスト用。省略時は globalThis.fetch */
  notificationFetch?: typeof fetch;
  /** 画像モデル一覧取得のテスト用。省略時は globalThis.fetch */
  imageCatalogFetch?: typeof fetch;
  /**
   * serve の記録の読み書きと起動・停止に使うサンドボックス実行。未指定なら env から生成した
   * サンドボックスクライアントを再利用する (workspace を差し替えたテストでは null)。
   */
  serveSandbox?: SandboxExecClient | null;
  /** serve の稼働判定に使うプローブ。テストで差し替える */
  serveProbe?: ServeProbe;
  /** プローブ先のホスト。未指定は PI_SANDBOX_URL のホスト (同一ホストのサンドボックス) */
  serveHost?: string;
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
  /** 画像生成の provider / model / APIキー (設定 → モデルの画像生成タブ)。行の有無をツール公開へ写す */
  imageSettings: ImageSettingsService;
  /** serve (サービス) の状態と起動・停止。GUI とエージェントの serve ツールが同じ実体を使う */
  serve: ServeService;
  /** 作業フォルダ単位の環境変数。GUI の API と serve / bash への注入が同じ実体を使う */
  secrets: SecretService;
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
  // 利用可能なモデルとアプリ既定モデルは DB を正とし、起動時に pi の実行時選択へ写す。
  // provider キーとは別の読取なので、片方が読めなくても他方の適用と最後の再計算を行う。
  const ignoredEnvironmentVariables = ignoredModelEnvironmentVariables();
  if (ignoredEnvironmentVariables.length > 0) {
    console.warn(
      `[u7agent] ${ignoredEnvironmentVariables.join(", ")} は無視されます。設定 → モデル で設定し、デプロイ設定からは削除してください`,
    );
  }
  const modelSettings = new ModelSettingsService({
    db: appDb,
    runtime: pi ? createProviderKeyRuntime(pi) : null,
    retainSecret: pi ? pi.retainSecret : () => {},
    maskError,
    refreshModelState: pi ? pi.refreshModelState : async () => {},
    setModelSelection: pi ? pi.setModelSelection : () => {},
    ignoredEnvironmentVariables,
  });
  await modelSettings.applyStored();
  // 画像生成は provider キーとは独立した 1 行で、行の有無を PiBff のツール公開へ写す。
  // 書込は自分のロックで直列化し、applyStored() も同じロックを通す（model-settings と同じ順序）。
  // モデル一覧は live を正とし、取得できないときは前回の成功（アプリ DB）→ SDK 同梱へ落ちる。
  const imageCatalog = createImageCatalog({ store: appDb, fetchImpl: opts.imageCatalogFetch });
  const imageSettings = new ImageSettingsService({
    db: appDb,
    runtimeAvailable: pi !== null,
    retainSecret: pi ? pi.retainSecret : () => {},
    catalog: imageCatalog,
    setImageGeneration: pi ? pi.setImageGeneration : () => {},
    maskError,
  });
  await imageSettings.applyStored();
  // シークレットは master key をホスト側 (環境変数 / 鍵ファイル) から受け取り、アプリ DB とは別経路で管理する。
  // 未設定 / 壊れた宣言では「秘密の利用」だけを拒否し、変数 (平文) と起動は続行する。
  const secrets = (() => {
    let cipher = null;
    let unavailableReason: string | undefined;
    try {
      const ring = resolveMasterKeys(process.env);
      cipher = ring ? createSecretCipher(ring) : null;
      if (!ring) unavailableReason = "シークレットの master key が未設定です (U7AGENT_SECRET_MASTER_KEY)";
    } catch (error) {
      unavailableReason =
        error instanceof SecretKeyError
          ? error.message
          : `シークレットの master key を読み込めません: ${messageFor(error)}`;
      console.error(`[u7agent] secret master key unavailable: ${unavailableReason}`);
    }
    return new SecretService({
      store: appDb,
      cipher,
      ...(unavailableReason ? { unavailableReason } : {}),
      retainSecret: pi ? pi.retainSecret : () => {},
    });
  })();
  // エージェントの bash へ渡す変数は exec のたびに解決する (変更が「次の bash」から効く) ため、
  // 値ではなく解決関数を注入する。シークレットはここに含めない (serve の起動時だけ渡す)。
  pi?.setSessionEnv({ variablesFor: (cwd) => secrets.variablesFor(cwd) });
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
  // serve の実体はアプリデータ (実績) とサンドボックスの両方を持つここで作り、GUI のルートと
  // エージェントの serve ツールの両方へ同じものを渡す (所有者の判定経路を 1 本に保つ)
  const serveSandbox =
    opts.serveSandbox !== undefined ? opts.serveSandbox : sandboxClient !== undefined ? sandboxClient : null;
  const serve = new ServeService({
    appDb,
    sessions: store,
    sandbox: serveSandbox,
    secretEnv: secrets,
    sandboxHost: opts.serveHost ?? sandboxHostFromUrl(process.env.PI_SANDBOX_URL),
    ...(opts.serveProbe ? { probe: opts.serveProbe } : {}),
  });
  pi?.setServe(createServeToolHost(serve));
  // ask_user の待機は run 状態と同じ SessionStore が持つ。ツール定義はこのホストへ委譲する
  pi?.setAskUser(store.askUserHost());
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
    imageSettings,
    serve,
    secrets,
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
    // 認証の有無を見ない getModels() を引く (未認証のモデルも許可リストには入れられる)
    catalog: () => modelRuntime.getModels().map((model) => ({ provider: model.provider, id: model.id })),
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
