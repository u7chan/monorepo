import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { ignoredModelEnvironmentVariables } from "./agent";
import { join } from "node:path";
import { AppDb } from "./app-db";
import { createBffRuntime, type BffRuntime } from "./bff-runtime";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { createPromptCatalog } from "./prompts";
import type { PromptCatalog } from "./prompts";
import { createArchiveSettings } from "./archive-settings";
import { createBackupService } from "./backup/service";
import type { BackupModelResolver } from "./backup/plan";
import type { BackupService } from "./backup/service";
import type { ArchiveSettings } from "./archive-settings";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { messageFor } from "./http";
import { ContentSettingsService } from "./content-settings";
import { ContentTrialsService } from "./content-trials";
import { TRIAL_ARTIFACTS_DIR_NAME, createTrialArtifactStore } from "./content-trial-artifacts";
import { createTrialDiskCheck, type TrialStatfs } from "./content-trial-disk-space";
import { createImageCatalog } from "./image-catalog";
import { createSpeechCatalog } from "./speech-catalog";
import { allowPrivateCostHost, createContentCostCatalog, type ContentCostOptions } from "./content-cost";
import { WebSearchSettingsService } from "./web-search-settings";
import type { WebSearchTest } from "./web-search-test";
import { VoiceInputSettingsService } from "./voice-input";
import { VoiceInputSessionService, type VoiceInputSessionTiming } from "./voice-input-session";
import { TitleSummarySettingsService } from "./title-summary-settings";
import { GitSettingsService } from "./git-settings";
import {
  createTitleSummaryTest,
  type TitleSummaryGenerate,
  type TitleSummaryHost,
  type TitleSummaryTest,
} from "./title-summary";
import { TitleSummaryQueue } from "./title-summary-queue";
import { ModelSettingsService } from "./model-settings";
import { OAuthLoginService } from "./oauth-login";
import { NotificationService } from "./notifications";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type {
  SandboxDownloadPlanClient,
  SandboxHandoffClient,
  SandboxMoveClient,
  SandboxRuntimeDiagnostics,
  SandboxServeClient,
  SandboxSkillArchiveClient,
  SandboxSkillFileClient,
  SandboxWorkspaceClient,
} from "./sandbox/client";
import { SecretService } from "./secrets";
import { CloudflareApiClient } from "./cloudflare-api";
import { CloudflareConnectionService } from "./cloudflare-connection";
import { CloudflareSettingsService, type CloudflareCredential } from "./cloudflare-settings";
import {
  SecretKeyError,
  createAppSecretCipher,
  createSecretCipher,
  resolveMasterKeys,
  type AppSecretCipher,
  type SecretCipher,
} from "./secret-crypto";
import { ServeService, sandboxHostFromUrl, type ServeProbe } from "./serve";
import { ServeTunnelService, type ServeTunnelControl, type TunnelDnsLookup } from "./service-tunnel";
import { createCloudflaredLauncher, type CloudflaredLauncher } from "./cloudflared";
import { SharedContentsService } from "./shared-contents";
import { SHARED_THUMBNAIL_DIR_NAME, createSharedThumbnailStore } from "./shared-thumbnails";
import { createSharedContentExclusions } from "./shared-content-exclusions";
import type { SharedContentExclusions } from "./shared-content-exclusions";
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
   * ここには検証済みの値が入る。未指定は既定 (4318)。待受は別 env (PI_FILE_PREVIEW_LISTEN_PORT)
   */
  filePreviewPort?: number;
  /** serve した成果物のブラウザから見たポート。起動時に検証済みの値を渡す */
  previewPort?: number;
  /**
   * ブラウザから見たアプリのオリジン (env `PI_APP_ORIGIN`)。TLS 終端の後ろで Origin が `https://<host>` に
   * なるため、Origin 検査の許可先へ足す。未指定は現行 (リクエスト自身の origin だけ)
   */
  appOrigin?: string;
  /** ブラウザから見たプレビュー オリジン (env `PI_FILE_PREVIEW_ORIGIN`)。iframe の src と CSP の frame-src に使う */
  filePreviewOrigin?: string;
  /** ブラウザから見たサービス オリジン (env `PI_PREVIEW_ORIGIN`)。サービスリンクと Location の書き換えに使う */
  serviceOrigin?: string;
  /**
   * `GET /api/health` が返す版の識別子。未指定は起動時の env (`U7AGENT_BUILD_ID` → `COMMIT_HASH`) から
   * 決める。テストと fixture が、再ビルドせずに client との版ずれを作るために上書きする
   */
  buildId?: string;
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/u7agent/sessions) */
  sessionStoreDir?: string | null;
  /** 通知送信のテスト用。省略時は globalThis.fetch */
  notificationFetch?: typeof fetch;
  /** 設定画面のテスト検索用。省略時は globalThis.fetch */
  webSearchTestFetch?: typeof fetch;
  /** 音声入力の疎通確認と Realtime 中継用。省略時は globalThis.fetch */
  voiceInputFetch?: typeof fetch;
  /** Realtime 中継の段の期限（テストで縮める）。省略時は既定 */
  voiceInputSessionTiming?: VoiceInputSessionTiming;
  /** Cloudflare API のテスト用。省略時は globalThis.fetch */
  cloudflareFetch?: typeof fetch;
  /** 画像モデル一覧取得のテスト用。省略時は globalThis.fetch */
  imageCatalogFetch?: typeof fetch;
  /** 音声モデル一覧取得のテスト用。省略時は globalThis.fetch */
  speechCatalogFetch?: typeof fetch;
  /** コストマスタ取得のテスト用。省略時は接続先の検証つきの HTTP 取得 */
  contentCostFetch?: ContentCostOptions["fetchImpl"];
  /**
   * 試行の成果物の置き場の空き確認のテスト用。省略時は `fs/promises` の `statfs`。
   * 未対応の fs を模すときは失敗するものを渡す。
   */
  trialStatfs?: TrialStatfs;
  /** カスタムプロバイダーの `/models` probe のテスト用。省略時は globalThis.fetch */
  customProviderProbeFetch?: typeof fetch;
  /**
   * 会話タイトルの AI 要約の生成。未指定なら pi のモデルランタイムから組み立てる (テストは差し替える)。
   * null を渡すと要約しない (呼び出しの配線だけを検証するとき)。
   */
  titleSummaryGenerate?: TitleSummaryGenerate | null;
  /**
   * AI 要約の共有実行制御。未指定は既定 (同時 1 件・待ち 15 秒)。テストは上限と待ち時間を縮めて渡す。
   */
  titleSummaryQueue?: TitleSummaryQueue | null;
  /**
   * セッションの引っ越しで作業フォルダ / 添付を移すサンドボックス。未指定なら env から生成した
   * サンドボックスクライアントを再利用する (workspace を差し替えたテストでは null = 移動は 503)。
   */
  moveSandbox?: SandboxMoveClient | null;
  /**
   * 引き継ぎのメモ (HANDOFF.md) の読み書きに使うサンドボックス。未指定なら env から生成した
   * サンドボックスクライアントを再利用する (workspace を差し替えたテストでは null = 引き継ぎは 503)。
   */
  handoffSandbox?: SandboxHandoffClient | null;
  /**
   * serve の記録の読み書き・起動・停止・待受の観測に使うサンドボックス。未指定なら env から生成した
   * サンドボックスクライアントを再利用する (workspace を差し替えたテストでは null)。
   */
  serveSandbox?: SandboxServeClient | null;
  /**
   * 共通スキル (`.agents/skills`) の GUI 編集に使うサンドボックス。未指定なら env から生成した
   * サンドボックスクライアントを再利用する (workspace を差し替えたテストでは null = 編集は 503)。
   */
  skillSandbox?: SandboxSkillFileClient | null;
  /**
   * スキルの持ち出し / 取り込みに使うサンドボックス。未指定なら env から生成したサンドボックスクライアントを
   * 再利用する (workspace を差し替えたテストでは null = 持ち出し / 取り込みは 503)。
   */
  skillArchiveSandbox?: SandboxSkillArchiveClient | null;
  /**
   * 共有のプレビュー (計画) に使うサンドボックス。未指定なら env から生成したサンドボックスクライアントを
   * 再利用する (workspace を差し替えたテストでは null = プレビューは 503)。
   */
  previewSandbox?: SandboxDownloadPlanClient | null;
  /** serve の稼働判定に使うプローブ。テストで差し替える */
  serveProbe?: ServeProbe;
  /** BFF の待受ポート。一時共有の子の記録を、同じ会話ストアを使う別の BFF と分ける */
  port?: number;
  /** 一時共有の起動基盤。未指定は env と会話ストアから組む (テストで差し替える) */
  cloudflared?: CloudflaredLauncher;
  /** 共有 URL の DNS 確認。未指定は Cloudflare の DoH を叩く */
  tunnelDns?: TunnelDnsLookup;
  /** 一時共有の制御。未指定は実体を組む (テストで差し替える) */
  serveTunnel?: ServeTunnelControl;
  /** プローブ先のホスト。未指定は PI_SANDBOX_URL のホスト (同一ホストのサンドボックス) */
  serveHost?: string;
  /**
   * バックアップの復元で使う実効モデルの判定。未指定は pi の実効一覧から組み立てる
   * (pi なしは判断せず、モデルを保持したまま警告する)。
   */
  backupModels?: BackupModelResolver;
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
  /** 定型プロンプトのマスタ (設定 → 定型プロンプトと、エージェントからの参照の解決元) */
  prompts: PromptCatalog;
  projects: ProjectStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  /** 実行環境の診断。workspace とは別に注入でき、null なら not_configured を返す */
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
  /** 共通スキル (`.agents/skills`) の GUI 編集。null なら 503 */
  skillSandbox: SandboxSkillFileClient | null;
  /** 共通スキルの持ち出し / 取り込み。null なら 503 */
  skillArchiveSandbox: SandboxSkillArchiveClient | null;
  /** 定義だけのバックアップ (書き出し / 復元 / 全削除)。DB とスキルを 1 本の排他で扱う */
  backup: BackupService;
  sessionStore: SessionStoreStatus;
  /** アプリデータ (プロジェクト / カタログ) の DB。status() を health へ出す */
  appDb: AppDb;
  /** Discord 通知。ラン完了時の送信と設定 API の両方から使う */
  notifications: NotificationService;
  /** アーカイブの除外名。health と download / check が同じ実効値を取る */
  archiveSettings: ArchiveSettings;
  /** プロバイダー API キー (設定 → モデル)。DB を希望状態として SDK へ写す */
  modelSettings: ModelSettingsService;
  /** OAuth サインイン (設定 → モデル)。資格情報は Pi の auth.json が正で、アプリ DB は触らない */
  oauthLogin: OAuthLoginService;
  /** コンテンツ生成の provider / 画像モデル / APIキー (設定 → コンテンツ生成)。行の有無をツール公開へ写す */
  contentSettings: ContentSettingsService;
  /** コンテンツ生成の試行ジョブ (設定 → コンテンツ生成)。画面の寿命に縛らず、明示キャンセルと close だけが止める */
  contentTrials: ContentTrialsService;
  /** Web 検索の実行時トグル (設定 → Web 検索)。行が無い = 既定 (有効) を execute のたびに読む */
  webSearchSettings: WebSearchSettingsService;
  /** 音声入力の OpenAI Platform のキー (設定 → 音声入力)。行が無い = キー未設定で、トグルは持たない */
  voiceInputSettings: VoiceInputSettingsService;
  /** Realtime セッションの中継。キーの利用判定は voiceInputSettings と共有する */
  voiceInputSession: VoiceInputSessionService;
  /** 設定画面のテスト検索。実行環境を作れない起動 (pi なし) は null */
  webSearchTest: WebSearchTest | null;
  /** 会話タイトルの AI 要約の設定 (On/Off・要約モデル・定義)。保存はサーバー側だけで行う */
  titleSummarySettings: TitleSummarySettingsService;
  /** Git のグローバル identity (設定 → Git)。bash へは exec のたびに渡す */
  gitSettings: GitSettingsService;
  /** 設定画面の「動作確認」。生成できない環境 (pi なし) は null */
  titleSummaryTest: TitleSummaryTest | null;
  /** serve (サービス) の状態と起動・停止。GUI とエージェントの serve ツールが同じ実体を使う */
  serve: ServeService;
  /** 一時共有の状態と開始・停止。メモリだけに持つ */
  serveTunnel: ServeTunnelControl;
  /** 一時共有の起動基盤。起動ログの利用可否と、前の BFF が残した子の掃除に使う */
  cloudflared: CloudflaredLauncher;
  /** 作業フォルダ単位の環境変数。GUI の API と serve / bash への注入が同じ実体を使う */
  secrets: SecretService;
  /** Cloudflare の資格情報。BFF 専用で、公開バックエンドと接続確認だけが平文を読む */
  cloudflareSettings: CloudflareSettingsService;
  /** 保存済みの資格情報での接続確認。公開と同じ Cloudflare client を使い、結果は保存しない */
  cloudflareConnection: CloudflareConnectionService;
  /** 静的成果物の公開。sandbox の ZIP 取得と Cloudflare への送信を担う */
  sharedContents: SharedContentsService;
  /** 共有の除外名。プレビューと公開が同じ実効値を取る */
  sharedContentExclusions: SharedContentExclusions;
};

export async function createBffContext(opts: CreateBffAppOptions = {}): Promise<BffContext> {
  // 段はこの順で呼ぶ。並びだけで守られている起動順の理由は、それぞれの呼び出しの上に書く。
  const started = await startRuntime(opts);
  const { runtime } = started;
  // DB の例外文言に登録済みキーが現れても、ログ / health / 503 に生のまま載せないよう、マスカーの境界を DB より先に作る。
  const storage = await openStorage(opts, started);
  // 鍵輪は、アプリ DB に暗号化して保存した行 (シークレット / APIキー / Webhook URL) を読み書きする前に作る。
  const keys = loadMasterKeys();
  // モデルとサインインは DB を希望状態の正として SDK へ写す。セッション作成の前 (listen 前) に 1 回だけ通す。
  const model = await applyModelSettings({ opts, appDb: storage.appDb, appCipher: keys.appCipher, runtime });
  // コンテンツ生成は provider キーとは別の行なので、モデルの適用が失敗しても独立に適用する。
  const content = await applyContentSettings({
    opts,
    appDb: storage.appDb,
    storeDir: storage.storeDir,
    appCipher: keys.appCipher,
    runtime,
  });
  // 外部連携の設定も同じ鍵輪を使う。会話タイトルの生成器は、この後の SessionStore が受け取る。
  const integration = await applyIntegrationSettings({ opts, appDb: storage.appDb, keys, runtime });
  // 会話ストアはカタログ・通知・サンドボックスの束を要するので、それらを作ってから開いて前のプロセスの状態を戻す。
  const conversation = await openConversation({
    opts,
    cwd: started.cwd,
    appDb: storage.appDb,
    storeDir: storage.storeDir,
    sessionStore: storage.sessionStore,
    sessionStoreError: storage.sessionStoreError,
    appCipher: keys.appCipher,
    titleSummarySettings: integration.titleSummarySettings,
    titleSummaryGenerate: integration.titleSummaryGenerate,
    runtime,
  });
  // serve と公開は SessionStore の実体 (所有者の判定経路) を要するので、会話を開いた後に作る。
  const publishing = await startPublishing({
    opts,
    cwd: started.cwd,
    appDb: storage.appDb,
    storeDir: storage.storeDir,
    runtime,
    conversation,
    secrets: integration.secrets,
    cloudflareSettings: integration.cloudflareSettings,
  });
  return {
    cwd: started.cwd,
    pi: runtime.pi,
    initError: started.initError,
    catalog: conversation.catalog,
    prompts: conversation.prompts,
    projects: conversation.projects,
    store: conversation.store,
    workspace: conversation.workspace,
    runtimeDiagnostics: conversation.runtimeDiagnostics,
    skillSandbox: conversation.skillSandbox,
    skillArchiveSandbox: conversation.skillArchiveSandbox,
    backup: publishing.backup,
    sessionStore: conversation.sessionStore,
    appDb: storage.appDb,
    notifications: conversation.notifications,
    archiveSettings: conversation.archiveSettings,
    modelSettings: model.modelSettings,
    oauthLogin: model.oauthLogin,
    contentSettings: content.contentSettings,
    contentTrials: content.contentTrials,
    webSearchSettings: integration.webSearchSettings,
    webSearchTest: integration.webSearchTest,
    voiceInputSettings: integration.voiceInputSettings,
    voiceInputSession: integration.voiceInputSession,
    titleSummarySettings: integration.titleSummarySettings,
    titleSummaryTest: integration.titleSummaryTest,
    gitSettings: integration.gitSettings,
    serve: publishing.serve,
    serveTunnel: publishing.serveTunnel,
    cloudflared: publishing.cloudflared,
    secrets: integration.secrets,
    cloudflareSettings: integration.cloudflareSettings,
    cloudflareConnection: publishing.cloudflareConnection,
    sharedContents: publishing.sharedContents,
    sharedContentExclusions: conversation.sharedContentExclusions,
  };
}

/** 段 1: pi の組み立てと、ランタイムなしの代替 */
type StartedRuntime = {
  cwd: string;
  initError: string | undefined;
  runtime: BffRuntime;
};

async function startRuntime(opts: CreateBffAppOptions): Promise<StartedRuntime> {
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
  return { cwd, initError, runtime: createBffRuntime(pi) };
}

/** 段 2: 会話ストアの置き場とアプリ DB */
type StorageStage = {
  appDb: AppDb;
  storeDir: string | null;
  sessionStore: SessionStoreStatus;
  sessionStoreError: string | undefined;
};

async function openStorage(opts: CreateBffAppOptions, { cwd, runtime }: StartedRuntime): Promise<StorageStage> {
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
    ? AppDb.unavailable({ storeDir, error: sessionStoreError, sanitizeError: runtime.maskError })
    : AppDb.open({ storeDir, sanitizeError: runtime.maskError });

  return { appDb, storeDir, sessionStore, sessionStoreError };
}

/** 段 3: シークレットとアプリ DB の暗号に使うマスターキー輪 */
type KeyStage = {
  cipher: SecretCipher | null;
  appCipher: AppSecretCipher | null;
  unavailableReason: string | undefined;
};

function loadMasterKeys(): KeyStage {
  // シークレットとアプリ DB のキー / Webhook URL は同じ鍵輪を使い、host 側 (環境変数 / 鍵ファイル) から受け取る。
  // 未設定 / 壊れた宣言では「秘密の利用」だけを拒否し、変数 (平文) と起動は続行する。
  let cipher: SecretCipher | null = null;
  let appCipher: AppSecretCipher | null = null;
  let unavailableReason: string | undefined;
  try {
    const ring = resolveMasterKeys(process.env);
    cipher = ring ? createSecretCipher(ring) : null;
    appCipher = ring ? createAppSecretCipher(ring) : null;
    if (!ring) unavailableReason = "シークレットの master key が未設定です (U7AGENT_SECRET_MASTER_KEY)";
  } catch (error) {
    unavailableReason =
      error instanceof SecretKeyError
        ? error.message
        : `シークレットの master key を読み込めません: ${messageFor(error)}`;
    console.error(`[u7agent] secret master key unavailable: ${unavailableReason}`);
  }
  return { cipher, appCipher, unavailableReason };
}

/** 段 4: プロバイダー API キーと OAuth サインイン */
type ModelStage = {
  oauthLogin: OAuthLoginService;
  modelSettings: ModelSettingsService;
};

async function applyModelSettings(input: {
  opts: CreateBffAppOptions;
  appDb: AppDb;
  appCipher: AppSecretCipher | null;
  runtime: BffRuntime;
}): Promise<ModelStage> {
  const { opts, appDb, appCipher, runtime } = input;
  // プロバイダー API キーは DB を希望状態の正とし、起動時に SDK の runtime overlay へ写す。
  // 失敗しても起動は続け、degraded として設定画面から回復できるようにする。
  const ignoredEnvironmentVariables = ignoredModelEnvironmentVariables();
  if (ignoredEnvironmentVariables.length > 0) {
    console.warn(
      `[u7agent] ${ignoredEnvironmentVariables.join(", ")} は無視されます。設定 → モデル で設定し、デプロイ設定からは削除してください`,
    );
  }
  // OAuth サインインは資格情報を Pi の auth.json へ委ね、進行状態だけをメモリに持つ。
  // キー変更とは別のロックで直列化する (進行中のサインインは分単位で待つため、キーの保存を塞がない)
  // サインアウトは SDK が auth.json の資格情報と一緒に runtime overlay も消すため、DB に残るキーの
  // 希望状態を写し直す係を渡す。実体 (ModelSettingsService) はこの後で作るので、束縛だけを遅らせる
  let reapplyStoredKey: (provider: string) => Promise<void> = async () => {};
  const oauthLogin = new OAuthLoginService({
    runtime: runtime.oauthLogin(),
    refresh: runtime.refreshModelState,
    reapplyStoredKey: (provider) => reapplyStoredKey(provider),
    maskError: runtime.maskError,
  });
  const modelSettings = new ModelSettingsService({
    db: appDb,
    runtime: runtime.providerKeys(),
    oauthLogin,
    retainSecret: runtime.retainSecret,
    maskError: runtime.maskError,
    refreshModelState: runtime.refreshModelState,
    setModelSelection: runtime.setModelSelection,
    probeFetch: opts.customProviderProbeFetch,
    ignoredEnvironmentVariables,
    appCipher,
  });
  reapplyStoredKey = (provider) => modelSettings.reapplyStoredKey(provider);
  // 利用可能なモデルとアプリ既定モデルは DB を正とし、起動時に pi の実行時選択へ写す。
  // provider キーとは別の読取なので、片方が読めなくても他方の適用と最後の再計算を行う。
  await modelSettings.applyStored();
  return { oauthLogin, modelSettings };
}

/** 段 5: コンテンツ生成のカタログ・設定・試行 */
type ContentStage = {
  contentSettings: ContentSettingsService;
  contentTrials: ContentTrialsService;
};

async function applyContentSettings(input: {
  opts: CreateBffAppOptions;
  appDb: AppDb;
  storeDir: string | null;
  appCipher: AppSecretCipher | null;
  runtime: BffRuntime;
}): Promise<ContentStage> {
  const { opts, appDb, storeDir, appCipher, runtime } = input;
  // コンテンツ生成は provider キーとは独立した 1 行で、行の有無を PiBff のツール公開へ写す。
  // 書込は自分のロックで直列化し、applyStored() も同じロックを通す（model-settings と同じ順序）。
  // モデル一覧は live を正とし、取得できないときは前回の成功（アプリ DB）→ SDK 同梱へ落ちる。
  const imageCatalog = createImageCatalog({ store: appDb, fetchImpl: opts.imageCatalogFetch });
  // 音声モデルは SDK にカタログが無いため、取得できないときは前回の成功（アプリ DB）→ 同梱の既定 1 件へ落ちる。
  // 取得は画像と同じくキーを見ない（一覧 API は認証不要）
  const speechCatalog = createSpeechCatalog({ store: appDb, fetchImpl: opts.speechCatalogFetch });
  // 価格と「一覧に出す / 出さない」の判断はコストマスタが持ち、ここは取得して写すだけ。
  // 取得は手動の [カタログ更新] のときだけ（起動時は保持値の読込のみ）
  const costCatalog = createContentCostCatalog({
    store: appDb,
    fetchImpl: opts.contentCostFetch,
    // 同一 Docker ネットワークのサービス名で master を指す運用では、解決先が private になる
    allowPrivateHosts: allowPrivateCostHost(),
  });
  const contentSettings = new ContentSettingsService({
    db: appDb,
    runtimeAvailable: runtime.available,
    retainSecret: runtime.retainSecret,
    catalog: imageCatalog,
    speechCatalog,
    cost: costCatalog,
    setContentGeneration: runtime.setContentGeneration,
    codexAuth: runtime.codexAuth,
    maskError: runtime.maskError,
    appCipher,
  });
  await contentSettings.applyStored();
  // 形式の学習結果は派生データだが、再起動後に同じ 400 往復を繰り返さないためアプリ DB へ残す。
  // 生成器は PiBff が持ち、DB はここが持つので、注入は setServe などと同じ形にする
  runtime.setSpeechFormatStore({
    read: (model) => appDb.readSpeechFormat(model),
    save: (model, format) => appDb.saveSpeechFormat(model, format),
  });
  // 試行ジョブのレジストリはメモリだけに持つ。起動時に前のプロセスの `running` を `interrupted` へ倒す。
  // 成果物は会話ストア / DB と同じ領域の兄弟 (`<storeDir>/trials`) に置き、サンドボックスを要求しない
  const trialArtifactsDir = storeDir ? join(storeDir, TRIAL_ARTIFACTS_DIR_NAME) : undefined;
  const contentTrials = new ContentTrialsService({
    db: appDb,
    source: contentSettings.trialSource(),
    generateImage: runtime.generateImage,
    // 音声も同じジョブの仕組みに載せる。未注入（ランタイムなしで起動）は画像と同じく 503 にする
    generateSpeech: runtime.generateSpeech,
    // BGM の生成器はチャットの `generate_bgm` と同じもの（同時実行枠も共有する）
    generateBgm: runtime.generateBgm,
    artifacts: trialArtifactsDir ? createTrialArtifactStore(trialArtifactsDir) : undefined,
    // 生成の前に置き場の空きを見る（永続化なしの構成では保存できないため、判定しない）
    diskSpace: trialArtifactsDir
      ? createTrialDiskCheck({ dir: trialArtifactsDir, statfs: opts.trialStatfs })
      : undefined,
    maskError: runtime.maskError,
  });
  await contentTrials.applyStored();
  return { contentSettings, contentTrials };
}

/** 段 6: Web 検索・音声入力・タイトル要約・Git・環境変数・Cloudflare の資格情報 */
type IntegrationStage = {
  webSearchSettings: WebSearchSettingsService;
  webSearchTest: WebSearchTest | null;
  voiceInputSettings: VoiceInputSettingsService;
  voiceInputSession: VoiceInputSessionService;
  titleSummarySettings: TitleSummarySettingsService;
  titleSummaryGenerate: TitleSummaryGenerate | null;
  titleSummaryTest: TitleSummaryTest | null;
  gitSettings: GitSettingsService;
  secrets: SecretService;
  cloudflareSettings: CloudflareSettingsService;
};

async function applyIntegrationSettings(input: {
  opts: CreateBffAppOptions;
  appDb: AppDb;
  keys: KeyStage;
  runtime: BffRuntime;
}): Promise<IntegrationStage> {
  const { opts, appDb, keys, runtime } = input;
  // Web 検索は「既定 OFF / Exa」なので、行が無ければ無効のまま立ち、設定行とキーがあるときだけ写す。
  // コンテンツ生成と同じく、写しはロックの内側で差し替える (設定 API と起動時の適用を直列化する)
  const webSearchSettings = new WebSearchSettingsService({
    db: appDb,
    setWebSearch: runtime.setWebSearch,
    retainSecret: runtime.retainSecret,
    maskError: runtime.maskError,
    cipher: keys.appCipher,
    runtimeAvailable: runtime.available,
  });
  await webSearchSettings.applyStored();
  // 音声入力のキーはコンテンツ生成 (OpenRouter) とは別の行で、OpenAI Platform のキーを AEAD で保存する。
  // 起動時に復号できたキーだけをマスカーへ入れ、疎通確認と中継は同じ利用判定を通す
  const voiceInputSettings = new VoiceInputSettingsService({
    db: appDb,
    runtimeAvailable: runtime.available,
    retainSecret: runtime.retainSecret,
    maskError: runtime.maskError,
    appCipher: keys.appCipher,
    ...(opts.voiceInputFetch === undefined ? {} : { fetchImpl: opts.voiceInputFetch }),
  });
  await voiceInputSettings.applyStored();
  // 未登録と利用不可の案内を中継側でも揃えるため、キーの利用判定はここへ複製しない
  const voiceInputSession = new VoiceInputSessionService({
    settings: voiceInputSettings,
    ...(opts.voiceInputFetch === undefined ? {} : { fetchImpl: opts.voiceInputFetch }),
    ...(opts.voiceInputSessionTiming === undefined ? {} : { timing: opts.voiceInputSessionTiming }),
  });
  // テスト検索はツールと同じ runner と同じ設定の写しを使う (画面とチャットで結果が食い違わない)
  const webSearchTest = runtime.webSearchTest(() => webSearchSettings.runtime(), opts.webSearchTestFetch);
  // 会話タイトルの AI 要約はモデル / 定義を DB で持つ。生成は会話ストアが判定し、ここは設定と 1 回の呼び出しだけ。
  const titleSummarySettings = new TitleSummarySettingsService({ db: appDb, models: runtime.modelOptions });
  await titleSummarySettings.applyStored();
  // Git の identity はサンドボックスの global gitconfig へ exec のたびに写す。DB が読めないときは null
  // (= useConfigOnly だけ) に倒し、古い identity を使い回さない
  const gitSettings = new GitSettingsService({ db: appDb });
  runtime.setGitIdentity(gitSettings);
  const titleSummaryGenerate: TitleSummaryGenerate | null =
    opts.titleSummaryGenerate !== undefined ? opts.titleSummaryGenerate : runtime.titleSummaryGenerate();
  const titleSummaryTest: TitleSummaryTest | null = titleSummaryGenerate
    ? createTitleSummaryTest(() => titleSummarySettings.runtime(), titleSummaryGenerate)
    : null;
  const secrets = new SecretService({
    store: appDb,
    cipher: keys.cipher,
    ...(keys.unavailableReason ? { unavailableReason: keys.unavailableReason } : {}),
    retainSecret: runtime.retainSecret,
  });
  // Cloudflare の資格情報も同じ鍵輪を使う。公開トークンは agent / sandbox へ渡さず、
  // 公開バックエンドと接続確認が credential() で読むまで BFF のメモリ外へ出さない。
  const cloudflareSettings = new CloudflareSettingsService({
    db: appDb,
    sharedContents: appDb.sharedContents,
    cipher: keys.cipher,
    retainSecret: runtime.retainSecret,
  });
  // エージェントの bash へ渡す変数は exec のたびに解決する (変更が「次の bash」から効く) ため、
  // 値ではなく解決関数を注入する。シークレットはここに含めない (serve の起動時だけ渡す)。
  runtime.setSessionEnv({ variablesFor: (cwd) => secrets.variablesFor(cwd) });
  return {
    webSearchSettings,
    webSearchTest,
    voiceInputSettings,
    voiceInputSession,
    titleSummarySettings,
    titleSummaryGenerate,
    titleSummaryTest,
    gitSettings,
    secrets,
    cloudflareSettings,
  };
}

/** 段 7: 会話ストアと、それを組み立てるカタログ・通知・サンドボックスの束 */
type ConversationStage = {
  prompts: PromptCatalog;
  catalog: AgentCatalog;
  projects: ProjectStore;
  notifications: NotificationService;
  archiveSettings: ArchiveSettings;
  sharedContentExclusions: SharedContentExclusions;
  sandboxClient: ReturnType<typeof createSandboxToolClientFromEnv> | undefined;
  workspace: SandboxWorkspaceClient | null;
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
  skillSandbox: SandboxSkillFileClient | null;
  skillArchiveSandbox: SandboxSkillArchiveClient | null;
  previewSandbox: SandboxDownloadPlanClient | null;
  store: SessionStore;
  sessionStore: SessionStoreStatus;
};

async function openConversation(input: {
  opts: CreateBffAppOptions;
  cwd: string;
  appDb: AppDb;
  storeDir: string | null;
  sessionStore: SessionStoreStatus;
  sessionStoreError: string | undefined;
  appCipher: AppSecretCipher | null;
  titleSummarySettings: TitleSummarySettingsService;
  titleSummaryGenerate: TitleSummaryGenerate | null;
  runtime: BffRuntime;
}): Promise<ConversationStage> {
  const { opts, cwd, appDb, storeDir, appCipher, runtime, titleSummarySettings, titleSummaryGenerate } = input;
  // ストアの準備 (init) に失敗したら、この段の戻り値の状態も 503 側へ倒す
  let { sessionStore, sessionStoreError } = input;
  // 組み込みスキルはサンドボックスに依らず起動時に読み込み済みなので、カタログの応答へそのまま載せる。
  // ツールの一覧はアプリ側の実効 (キー / 実行時トグル / serve host / 環境変数) を取得時に写すため、
  // 値ではなく pi の解決関数を渡す (runtime が無いときは空 = クライアントが「取得できていない」と出す)
  const prompts = createPromptCatalog({ db: appDb });
  const catalog = createAgentCatalog({
    builtinSkills: BUILTIN_SKILLS.map((skill) => ({
      name: skill.name,
      description: skill.description,
      version: skill.version,
    })),
    tools: runtime.toolCatalog,
    db: appDb,
    prompts,
  });
  const projects = new ProjectStore(appDb);
  // 通知はセッションと同じ secret masker を使い、本文とエラーから秘密値を落とす
  const notifications = new NotificationService({
    db: appDb,
    masker: runtime.masker,
    fetchImpl: opts.notificationFetch,
    cipher: appCipher,
    runtimeAvailable: runtime.available,
    retainSecret: runtime.retainSecret,
  });
  // アーカイブの除外名は設定ストアが唯一の決定点で、サンドボックスへはリクエストごとに渡す
  const archiveSettings = createArchiveSettings({ db: appDb });
  // 共有の除外名はアーカイブとは別の既定を持ち、プレビューと公開の受付時にだけ読む
  const sharedContentExclusions = createSharedContentExclusions({ db: appDb });
  // 作業領域の操作はモデルランタイムとは独立に生成する (APIキー未設定で ready: false でもツリーは開けるように)
  const sandboxClient = opts.workspace !== undefined ? undefined : createSandboxToolClientFromEnv(process.env);
  const workspace = opts.workspace !== undefined ? opts.workspace : (sandboxClient ?? null);
  const runtimeDiagnostics = opts.runtimeDiagnostics !== undefined ? opts.runtimeDiagnostics : (sandboxClient ?? null);
  // 引っ越しの物理移動も workspace と同じ規則で注入する (workspace スタブを広げないための狭い IF)
  const moveSandbox =
    opts.moveSandbox !== undefined ? opts.moveSandbox : sandboxClient !== undefined ? sandboxClient : null;
  // 引き継ぎメモの読み書きも同じく狭い IF で注入する (同じ env のクライアントを再利用する)
  const handoffSandbox =
    opts.handoffSandbox !== undefined ? opts.handoffSandbox : sandboxClient !== undefined ? sandboxClient : null;
  // 共通スキルの編集も同じく狭い IF で注入する (一覧と検証の経路は変えない)
  const skillSandbox =
    opts.skillSandbox !== undefined ? opts.skillSandbox : sandboxClient !== undefined ? sandboxClient : null;
  // 持ち出し / 取り込みも同じクライアントを狭い IF で注入する (CRUD のスタブを広げない)
  const skillArchiveSandbox =
    opts.skillArchiveSandbox !== undefined
      ? opts.skillArchiveSandbox
      : sandboxClient !== undefined
        ? sandboxClient
        : null;
  // 共有のプレビューも同じクライアントを狭い IF で注入する (workspace のスタブを広げない)
  const previewSandbox =
    opts.previewSandbox !== undefined ? opts.previewSandbox : sandboxClient !== undefined ? sandboxClient : null;
  const store = new SessionStore({
    pi: runtime.pi,
    catalog,
    masker: runtime.masker,
    projects,
    storeDir,
    storeError: sessionStoreError,
    workspace,
    moveSandbox,
    handoffSandbox,
    cwdKeys: appDb,
    serveCommands: appDb,
    assistantMetrics: appDb,
    rootCwd: cwd,
    notifications,
    titleSummary: titleSummaryGenerate ? titleSummaryHost(titleSummarySettings, titleSummaryGenerate) : null,
    ...(opts.titleSummaryQueue !== undefined ? { titleSummaryQueue: opts.titleSummaryQueue } : {}),
  });
  // Off への変更では未開始の要約を取り消す (実行中は中断し、後から届いた結果も適用しない)
  titleSummarySettings.onChange(() => store.cancelTitleSummaries());
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
    prompts,
    catalog,
    projects,
    notifications,
    archiveSettings,
    sharedContentExclusions,
    sandboxClient,
    workspace,
    runtimeDiagnostics,
    skillSandbox,
    skillArchiveSandbox,
    previewSandbox,
    store,
    sessionStore,
  };
}

/** 段 8: serve・共有コンテンツの公開・Cloudflare の接続確認・バックアップ */
type PublishingStage = {
  serve: ServeService;
  serveTunnel: ServeTunnelControl;
  cloudflared: CloudflaredLauncher;
  sharedContents: SharedContentsService;
  cloudflareConnection: CloudflareConnectionService;
  backup: BackupService;
};

async function startPublishing(input: {
  opts: CreateBffAppOptions;
  cwd: string;
  appDb: AppDb;
  storeDir: string | null;
  runtime: BffRuntime;
  conversation: ConversationStage;
  secrets: SecretService;
  cloudflareSettings: CloudflareSettingsService;
}): Promise<PublishingStage> {
  const { opts, cwd, appDb, storeDir, runtime, conversation, secrets, cloudflareSettings } = input;
  const {
    store,
    sandboxClient,
    workspace,
    skillSandbox,
    skillArchiveSandbox,
    previewSandbox,
    sharedContentExclusions,
  } = conversation;
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
  runtime.setServe(createServeToolHost(serve));
  const cloudflared =
    opts.cloudflared ??
    createCloudflaredLauncher({
      env: process.env,
      sessionStoreDir: storeDir,
      rootCwd: cwd,
      instancePort: opts.port ?? 4317,
      log: (line) => console.log(`[u7agent] ${line}`),
    });
  const serveTunnel =
    opts.serveTunnel ??
    new ServeTunnelService({
      launcher: cloudflared,
      serve,
      sandboxConfigured: serveSandbox !== null,
      sandboxHost: opts.serveHost ?? sandboxHostFromUrl(process.env.PI_SANDBOX_URL),
      ...(opts.tunnelDns === undefined ? {} : { dns: opts.tunnelDns }),
      log: (line) => console.log(`[u7agent] ${line}`),
    });
  // ask_user の待機は run 状態と同じ SessionStore が持つ。ツール定義はこのホストへ委譲する
  runtime.setAskUser(store.askUserHost());
  // egress の承認も同じ SessionStore が持つ (メモリのみ、abort / 削除で未承認へ戻す)
  runtime.setNetworkAccess(store.networkAccessHost());
  // investigate の子 runner も SessionStore が持つ。子は record に載せず、親 run の signal で止める
  runtime.setInvestigate(store.investigateHost());
  // 公開と接続確認が同じ client 設定（base URL / timeout / fetch）を使うよう、factory はここ 1 箇所に置く
  const createCloudflare = (credential: CloudflareCredential) =>
    new CloudflareApiClient({
      accountId: credential.accountId,
      apiToken: credential.apiToken,
      ...(opts.cloudflareFetch ? { fetchImpl: opts.cloudflareFetch } : {}),
    });
  const sharedContents = new SharedContentsService({
    store: appDb.sharedContents,
    sessions: store,
    workspace,
    planSandbox: previewSandbox,
    credentials: cloudflareSettings,
    createCloudflare,
    rootCwd: cwd,
    maskError: runtime.maskError,
    secretValues: runtime.secretValues,
    exclusions: sharedContentExclusions,
    // サムネイルも DB と同じ領域の兄弟 (`<storeDir>/shared-thumbnails`) に置く。
    // 永続化なしの構成 (storeDir が無い) では保存できないので、配信も 503 になる
    thumbnails: storeDir ? createSharedThumbnailStore(join(storeDir, SHARED_THUMBNAIL_DIR_NAME)) : null,
  });
  const cloudflareConnection = new CloudflareConnectionService({
    credentials: cloudflareSettings,
    createCloudflare,
  });
  // 中断した公開を起動時に回収する。失敗しても起動は止めず、行は publishing + lastError のまま残す
  await sharedContents.recoverInterrupted().catch((error) => {
    console.warn(`[u7agent] shared content recovery failed: ${runtime.maskError(messageFor(error))}`);
  });
  // サムネイルの行と実体を揃える。行の無いファイルを消し、実体の無い行を未設定へ倒す
  await sharedContents.reconcileThumbnails().catch((error) => {
    console.warn(`[u7agent] shared content thumbnail reconciliation failed: ${runtime.maskError(messageFor(error))}`);
  });
  /**
   * 復元でのモデルの可否は、セッション作成と同じ実効一覧で判定する。APIキー未設定で一覧が空、
   * またはカタログが取れていないときは判断せず保持する (docs/backup.md)。
   */
  const backupModels: BackupModelResolver =
    opts.backupModels ?? runtime.backupModels(() => appDb.readModelSettings()?.allowedModels ?? null);

  const backup = createBackupService({
    db: appDb,
    workspace,
    skillSandbox,
    skillArchive: skillArchiveSandbox,
    models: backupModels,
    // 組み込みスキルは同梱物が正で、ツールは pi の実効一覧。どちらも取れない構成では判定しない
    knownSkills: () => ({ builtin: BUILTIN_SKILLS.map((skill) => skill.name) }),
    knownTools: runtime.knownToolNames,
  });
  return { serve, serveTunnel, cloudflared, sharedContents, cloudflareConnection, backup };
}

/** 会話ストアへ渡す AI 要約の口。設定は呼び出しのたびに読み、世代の比較はストアが行う */
function titleSummaryHost(settings: TitleSummarySettingsService, generate: TitleSummaryGenerate): TitleSummaryHost {
  return { settings: () => settings.runtime(), generate };
}
