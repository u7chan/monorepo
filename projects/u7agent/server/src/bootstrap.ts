import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { ignoredModelEnvironmentVariables } from "./agent";
import { join } from "node:path";
import { CredentialSynchronizationError, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { AppDb } from "./app-db";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { createArchiveSettings } from "./archive-settings";
import type { ArchiveSettings } from "./archive-settings";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { createDeviceIdStore, DEVICE_ID_PATH } from "./device-id";
import { messageFor } from "./http";
import { ContentSettingsService } from "./content-settings";
import { createImageCatalog } from "./image-catalog";
import { createSpeechCatalog } from "./speech-catalog";
import { WebSearchSettingsService } from "./web-search-settings";
import { TitleSummarySettingsService } from "./title-summary-settings";
import {
  createTitleSummaryGenerate,
  createTitleSummaryTest,
  type TitleSummaryGenerate,
  type TitleSummaryHost,
  type TitleSummaryTest,
} from "./title-summary";
import { TitleSummaryQueue } from "./title-summary-queue";
import { ModelSettingsService, type CredentialCommit, type ProviderKeyRuntime } from "./model-settings";
import { OAuthLoginService, canSignInHere, type OAuthLoginRuntime } from "./oauth-login";
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
import { SharedContentsService } from "./shared-contents";
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
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/u7agent/sessions) */
  sessionStoreDir?: string | null;
  /** 通知送信のテスト用。省略時は globalThis.fetch */
  notificationFetch?: typeof fetch;
  /** Cloudflare API のテスト用。省略時は globalThis.fetch */
  cloudflareFetch?: typeof fetch;
  /** 画像モデル一覧取得のテスト用。省略時は globalThis.fetch */
  imageCatalogFetch?: typeof fetch;
  /** 音声モデル一覧取得のテスト用。省略時は globalThis.fetch */
  speechCatalogFetch?: typeof fetch;
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
  /** 共通スキル (`.agents/skills`) の GUI 編集。null なら 503 */
  skillSandbox: SandboxSkillFileClient | null;
  /** 共通スキルの持ち出し / 取り込み。null なら 503 */
  skillArchiveSandbox: SandboxSkillArchiveClient | null;
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
  /** Web 検索の実行時トグル (設定 → Web 検索)。行が無い = 既定 (有効) を execute のたびに読む */
  webSearchSettings: WebSearchSettingsService;
  /** 会話タイトルの AI 要約の設定 (On/Off・要約モデル・定義)。保存はサーバー側だけで行う */
  titleSummarySettings: TitleSummarySettingsService;
  /** 設定画面の「動作確認」。生成できない環境 (pi なし) は null */
  titleSummaryTest: TitleSummaryTest | null;
  /** serve (サービス) の状態と起動・停止。GUI とエージェントの serve ツールが同じ実体を使う */
  serve: ServeService;
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
  // シークレットとアプリ DB のキー / Webhook URL は同じ鍵輪を使い、host 側 (環境変数 / 鍵ファイル) から受け取る。
  // 未設定 / 壊れた宣言では「秘密の利用」だけを拒否し、変数 (平文) と起動は続行する。
  const secretCrypto = (() => {
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
  })();
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
    runtime: pi ? createOAuthLoginRuntime(pi) : null,
    refresh: pi ? pi.refreshModelState : async () => {},
    reapplyStoredKey: (provider) => reapplyStoredKey(provider),
    maskError,
  });
  const modelSettings = new ModelSettingsService({
    db: appDb,
    runtime: pi ? createProviderKeyRuntime(pi) : null,
    oauthLogin,
    retainSecret: pi ? pi.retainSecret : () => {},
    maskError,
    refreshModelState: pi ? pi.refreshModelState : async () => {},
    setModelSelection: pi ? pi.setModelSelection : () => {},
    probeFetch: opts.customProviderProbeFetch,
    ignoredEnvironmentVariables,
    appCipher: secretCrypto.appCipher,
  });
  reapplyStoredKey = (provider) => modelSettings.reapplyStoredKey(provider);
  await modelSettings.applyStored();
  // コンテンツ生成は provider キーとは独立した 1 行で、行の有無を PiBff のツール公開へ写す。
  // 書込は自分のロックで直列化し、applyStored() も同じロックを通す（model-settings と同じ順序）。
  // モデル一覧は live を正とし、取得できないときは前回の成功（アプリ DB）→ SDK 同梱へ落ちる。
  const imageCatalog = createImageCatalog({ store: appDb, fetchImpl: opts.imageCatalogFetch });
  // 音声モデルは SDK にカタログが無いため、取得できないときは前回の成功（アプリ DB）→ 同梱の既定 1 件へ落ちる。
  // 取得は画像と同じくキーを見ない（一覧 API は認証不要）
  const speechCatalog = createSpeechCatalog({ store: appDb, fetchImpl: opts.speechCatalogFetch });
  const contentSettings = new ContentSettingsService({
    db: appDb,
    runtimeAvailable: pi !== null,
    retainSecret: pi ? pi.retainSecret : () => {},
    catalog: imageCatalog,
    speechCatalog,
    setContentGeneration: pi ? pi.setContentGeneration : () => {},
    maskError,
    appCipher: secretCrypto.appCipher,
    // 生成器の口は任意。未注入（ランタイムなしで起動）はお試し再生を 503 にする
    generateSpeech: pi ? pi.generateSpeech : undefined,
  });
  await contentSettings.applyStored();
  // Web 検索は「既定 ON / Exa」なので、行が無ければそのまま立ち、設定行とキーがあるときだけ写す。
  // コンテンツ生成と同じく、写しはロックの内側で差し替える (設定 API と起動時の適用を直列化する)
  const webSearchSettings = new WebSearchSettingsService({
    db: appDb,
    setWebSearch: pi ? pi.setWebSearch : () => {},
    retainSecret: pi ? pi.retainSecret : () => {},
    maskError,
    cipher: secretCrypto.appCipher,
    runtimeAvailable: pi !== null,
  });
  await webSearchSettings.applyStored();
  // 会話タイトルの AI 要約はモデル / 定義を DB で持つ。生成は会話ストアが判定し、ここは設定と 1 回の呼び出しだけ。
  const titleSummarySettings = new TitleSummarySettingsService({ db: appDb, models: () => pi?.modelOptions ?? [] });
  await titleSummarySettings.applyStored();
  const titleSummaryGenerate: TitleSummaryGenerate | null =
    opts.titleSummaryGenerate !== undefined
      ? opts.titleSummaryGenerate
      : pi
        ? createTitleSummaryGenerate(
            {
              resolveModel: (model) => pi.resolveModel(model),
              // sessionId (プロバイダーのルーティング)・出力予算・Effort・取消をそのまま渡す
              complete: (model, context, options) => pi.modelRuntime.completeSimple(model, context, options),
            },
            pi.secretMasker,
          )
        : null;
  const titleSummaryTest: TitleSummaryTest | null = titleSummaryGenerate
    ? createTitleSummaryTest(() => titleSummarySettings.runtime(), titleSummaryGenerate)
    : null;
  const secrets = new SecretService({
    store: appDb,
    cipher: secretCrypto.cipher,
    ...(secretCrypto.unavailableReason ? { unavailableReason: secretCrypto.unavailableReason } : {}),
    retainSecret: pi ? pi.retainSecret : () => {},
  });
  // Cloudflare の資格情報も同じ鍵輪を使う。公開トークンは agent / sandbox へ渡さず、
  // 公開バックエンドと接続確認が credential() で読むまで BFF のメモリ外へ出さない。
  const cloudflareSettings = new CloudflareSettingsService({
    db: appDb,
    cipher: secretCrypto.cipher,
    retainSecret: pi ? pi.retainSecret : () => {},
  });
  // エージェントの bash へ渡す変数は exec のたびに解決する (変更が「次の bash」から効く) ため、
  // 値ではなく解決関数を注入する。シークレットはここに含めない (serve の起動時だけ渡す)。
  pi?.setSessionEnv({ variablesFor: (cwd) => secrets.variablesFor(cwd) });
  // 組み込みスキルはサンドボックスに依らず起動時に読み込み済みなので、カタログの応答へそのまま載せる。
  // ツールの一覧はアプリ側の実効 (キー / 実行時トグル / serve host / 環境変数) を取得時に写すため、
  // 値ではなく pi の解決関数を渡す (runtime が無いときは空 = クライアントが「取得できていない」と出す)
  const catalog = createAgentCatalog({
    builtinSkills: BUILTIN_SKILLS.map((skill) => ({
      name: skill.name,
      description: skill.description,
      version: skill.version,
    })),
    tools: () => pi?.toolCatalog() ?? [],
    db: appDb,
  });
  const projects = new ProjectStore(appDb);
  // 通知はセッションと同じ secret masker を使い、本文とエラーから秘密値を落とす
  const notifications = new NotificationService({
    db: appDb,
    masker: pi?.secretMasker,
    fetchImpl: opts.notificationFetch,
    cipher: secretCrypto.appCipher,
    runtimeAvailable: pi !== null,
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
    pi,
    catalog,
    masker: pi?.secretMasker,
    projects,
    storeDir,
    storeError: sessionStoreError,
    workspace,
    moveSandbox,
    handoffSandbox,
    cwdKeys: appDb,
    serveCommands: appDb,
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
  // investigate の子 runner も SessionStore が持つ。子は record に載せず、親 run の signal で止める
  pi?.setInvestigate(store.investigateHost());
  // 公開と接続確認が同じ client 設定（base URL / timeout / fetch）を使うよう、factory はここ 1 箇所に置く
  const createCloudflare = (credential: CloudflareCredential) =>
    new CloudflareApiClient({
      accountId: credential.accountId,
      apiToken: credential.apiToken,
      ...(opts.cloudflareFetch ? { fetchImpl: opts.cloudflareFetch } : {}),
    });
  const sharedContents = new SharedContentsService({
    store: appDb,
    sessions: store,
    workspace,
    planSandbox: previewSandbox,
    credentials: cloudflareSettings,
    createCloudflare,
    rootCwd: cwd,
    maskError,
    secretValues: () => pi?.secretMasker.secrets ?? [],
    exclusions: sharedContentExclusions,
  });
  const cloudflareConnection = new CloudflareConnectionService({
    credentials: cloudflareSettings,
    createCloudflare,
  });
  // 中断した公開を起動時に回収する。失敗しても起動は止めず、行は publishing + lastError のまま残す
  await sharedContents.recoverInterrupted().catch((error) => {
    console.warn(`[u7agent] shared content recovery failed: ${maskError(messageFor(error))}`);
  });
  return {
    cwd,
    pi,
    initError,
    catalog,
    projects,
    store,
    workspace,
    runtimeDiagnostics,
    skillSandbox,
    skillArchiveSandbox,
    sessionStore,
    appDb,
    notifications,
    archiveSettings,
    modelSettings,
    oauthLogin,
    contentSettings,
    webSearchSettings,
    titleSummarySettings,
    titleSummaryTest,
    serve,
    secrets,
    cloudflareSettings,
    cloudflareConnection,
    sharedContents,
    sharedContentExclusions,
  };
}

/** 会話ストアへ渡す AI 要約の口。設定は呼び出しのたびに読み、世代の比較はストアが行う */
function titleSummaryHost(settings: TitleSummarySettingsService, generate: TitleSummaryGenerate): TitleSummaryHost {
  return { settings: () => settings.runtime(), generate };
}

/** SDK のログインで名乗る名前。同意画面の `agent_name_hint` に出る静的な文字列で、秘密情報ではない */
export const OAUTH_AGENT_NAME = "u7agent";

/**
 * SDK の ModelRuntime を OAuthLoginRuntime へ写す。`login` の戻り値 (credential) は捨て、保存は SDK に委ねる。
 * device id は agent dir 配下のファイルへ永続化し、プロセスを再起動しても同じ UUID を返す。
 */
export function createOAuthLoginRuntime(pi: PiBff): OAuthLoginRuntime {
  const { modelRuntime } = pi;
  const deviceIds = createDeviceIdStore(join(pi.agentDir, DEVICE_ID_PATH), (message) =>
    console.warn(`[u7agent] ${message}`),
  );
  return {
    list: () =>
      modelRuntime.getProviders().map((provider) => ({
        provider: provider.id,
        supportsOAuth: Boolean(provider.auth?.oauth),
        oauthLoginLabel: provider.auth?.oauth?.loginLabel ?? null,
      })),
    loginOAuth: (provider, interaction) =>
      settleCredentialOperation("login", provider, () =>
        modelRuntime.login(provider, "oauth", interaction, {
          getDeviceId: () => deviceIds.getOrCreate(),
          agentName: OAUTH_AGENT_NAME,
        }),
      ),
    logoutOAuth: (provider, { signal }) =>
      settleCredentialOperation("logout", provider, () => modelRuntime.logout(provider, { signal })),
    credentialKind: (provider) => (modelRuntime.isUsingOAuth(provider) ? "oauth" : null),
    // readStoredCredential は読取に失敗したら undefined を返す。種別以外はここで捨てる
    storedCredentialKind: (provider) => readStoredCredential(provider, join(pi.agentDir, "auth.json"))?.type,
  };
}

/**
 * SDK は auth.json への commit 後に snapshot の同期が失敗しても CSE を投げるため、provider と操作が
 * 一致する CSE だけを「保存済み・反映は次回の再計算で追いつく」として成功に倒す (credential は返さない)。
 */
async function settleCredentialOperation(
  operation: "login" | "logout",
  provider: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      error instanceof CredentialSynchronizationError &&
      error.providerId === provider &&
      error.operation === operation
    ) {
      console.warn(`[u7agent] oauth ${operation} credential synced late: ${provider}`);
      return;
    }
    throw error;
  }
}

/**
 * SDK の ModelRuntime を ProviderKeyRuntime へ写す。SDK の例外は throw せず CredentialCommit へ分類し、
 * `credential` / `cause` / 生の例外文言はこの境界から外へ出さない。
 */
export function createProviderKeyRuntime(pi: PiBff): ProviderKeyRuntime {
  const { modelRuntime } = pi;
  // SDK が実際に読む保存先と同じパス。表示専用の覗き見にだけ使う
  const storedAuthPath = join(pi.agentDir, "auth.json");
  return {
    list: () =>
      modelRuntime.getProviders().map((provider) => {
        const supportsOAuth = Boolean(provider.auth?.oauth);
        return {
          provider: provider.id,
          name: provider.name || provider.id,
          // auth.apiKey.login は「対話でキー入力を受け付ける」印。ambient / keyless は login を持たない
          canSetApiKey: Boolean(provider.auth?.apiKey?.login),
          supportsOAuth,
          // 画面がサインインの操作を出せるかの判定。OAuth を求める方式でも、この画面が扱えない対話を
          // 必要とする flow はここで false になる (許可リストは oauth-login 側が持つ)
          canSignInHere: canSignInHere(provider.id, supportsOAuth),
          // OAuth の表示名だけを渡す (ログイン手段の名前で、トークンや client_id ではない)
          oauthLoginLabel: provider.auth?.oauth?.loginLabel ?? null,
        };
      }),
    auth: (provider) => modelRuntime.getProviderAuthStatus(provider),
    credentialKind: (provider) => (modelRuntime.isUsingOAuth(provider) ? "oauth" : "api_key"),
    // readStoredCredential は読取に失敗したら undefined を返す。種別以外はここで捨てる
    storedCredentialKind: (provider) => readStoredCredential(provider, storedAuthPath)?.type,
    // 認証の有無を見ない getModels() を引く (未認証のモデルも許可リストには入れられる)
    catalog: () => modelRuntime.getModels().map((model) => ({ provider: model.provider, id: model.id })),
    refreshCatalog: (options) => pi.refreshModelCatalog(options),
    catalogSnapshot: () => pi.modelCatalog,
    applyApiKey: (provider, apiKey, { signal }) =>
      commitCredential("setRuntimeApiKey", provider, signal, () =>
        modelRuntime.setRuntimeApiKey(provider, apiKey, { signal }),
      ),
    removeApiKey: (provider, { signal }) =>
      commitCredential("removeRuntimeApiKey", provider, signal, () =>
        modelRuntime.removeRuntimeApiKey(provider, { signal }),
      ),
    // SDK の検証は登録内容の反映前に行われるため、throw しても旧登録は残る (呼び出し側が 400 にする)
    registerProvider: (provider, config) =>
      modelRuntime.registerProvider(provider, {
        name: config.name,
        baseUrl: config.baseUrl,
        api: config.api,
        models: config.models.map((model) => ({ ...model, type: "chat" as const })),
      }),
    unregisterProvider: (provider) => modelRuntime.unregisterProvider(provider),
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
