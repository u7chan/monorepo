/**
 * API 契約の正。DTO のフィールド名と optional の扱いは client と揃える。
 * 実体はドメイン別の `schema/` に分け、このファイルはバレルとして再エクスポートする
 * (呼び出し側の import 経路を変えないため)。
 */
import type {
  SandboxGitConfigStatus,
  SandboxLandlockStatus,
  SandboxRuntimeCommand,
  SandboxRuntimeEnvironment,
} from "./sandbox/protocol";
import { WEB_SEARCH_PROVIDER_IDS } from "./web-search-providers";
import { z } from "zod";
import { AgentPayloadInfoSchema } from "./schema/catalog";
import {
  AskUserAnswerSchema,
  AskUserQuestionSchema,
  ModelRefSchema,
  PROVIDER_API_KEY_MAX_LENGTH,
  PROVIDER_API_KEY_MIN_LENGTH,
  RunStatusSchema,
  SessionTitleSummarySchema,
  ThinkingLevelSchema,
} from "./schema/common";
import {
  AssistantMetaSchema,
  ChatMessageSchema,
  CompactionInfoSchema,
  ContextUsageSchema,
  MessageMetricsSchema,
  NetworkAccessModeSchema,
  PendingSendSchema,
  ResyncReasonSchema,
  RunErrorCodeSchema,
  RunPayloadSchema,
  RunRetryStateSchema,
  SessionNetworkAccessSchema,
  SkillLoadSchema,
  UsageSchema,
} from "./schema/messages";

/**
 * 会話の引き継ぎの状態。`consumed` は引き継ぎ後に最初に受理した送信で立ち、
 * チップ (HANDOFF.md を参照) の表示条件になる。旧サーバーは載せない (省略 = 引き継ぎなし)。
 */
export const SessionHandoffStateSchema = z.object({
  operationId: z.string(),
  at: z.number(),
  /** HANDOFF.md を作った引き継ぎか */
  memo: z.boolean(),
  /** 引き継ぎ後の最初の送信を受理済みか (未送信の破棄では戻らない) */
  consumed: z.boolean(),
  /** 確定後の履歴削除 (片付け) が残っているか。true の間は会話を開けない */
  cleanupPending: z.boolean(),
});
export type SessionHandoffState = z.infer<typeof SessionHandoffStateSchema>;
export const SessionPayloadSchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  piSessionId: z.string(),
  /** rootCwd 相対の作業ディレクトリ (未所属は所属スペースのスクラッチ。"" = root は永続化なしの既定スペースだけ) */
  cwd: z.string(),
  /** SSE の世代。seq は再起動で 0 に戻るため、カーソルの整合判定に使う */
  eventGeneration: z.string(),
  projectId: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  supportsThinking: z.boolean().optional(),
  /** 実効モデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  availableThinkingLevels: z.array(ThinkingLevelSchema).optional(),
  status: RunStatusSchema,
  title: z.string(),
  /** 会話タイトルの由来と AI 要約の試行。旧サーバーは載せない */
  titleSummary: SessionTitleSummarySchema.optional(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  /** この payload を組み立てた時刻 (epoch ms)。retry.retryAt との差でクライアントが残り時間を出す */
  serverNow: z.number(),
  queueDepth: z.number(),
  /** 受理済みでまだ保存されていない送信 (古い→新しい)。旧サーバーは載せないため省略可 (省略 = 未対応) */
  pendingSends: z.array(PendingSendSchema).optional(),
  /** 手動圧縮の開始時刻 (epoch ms)。status === "compacting" のときだけ載る */
  compactionStartedAt: z.number().optional(),
  /** この会話の完了を Discord へ送るか。サーバーは常に載せ、読む側は省略を false として扱う */
  notify: z.boolean().optional(),
  /** サイドバーに固定するか */
  pinned: z.boolean(),
  lastSeq: z.number(),
  /** `resync` イベントだけが載せる理由 (省略 = 同じ実行の継続) */
  resyncReason: ResyncReasonSchema.optional(),
  agent: AgentPayloadInfoSchema.optional(),
  run: RunPayloadSchema.nullable(),
  messages: z.array(ChatMessageSchema),
  /**
   * 表示 item にならない assistant 応答のメタ情報 (未回答の ask_user を合成するときに使う)。
   * 同じ BFF が SDK 履歴から引ける間だけ載り、旧サーバーはキー自体を省略する
   */
  assistantMeta: z.array(AssistantMetaSchema).optional(),
  /** 会話の圧縮履歴 (古い→新しい)。区切りは messages に混ぜず、回数はこの長さから導出する */
  compactions: z.array(CompactionInfoSchema),
  /** セッションのコンテキスト使用量。SDK が持たない (スタブ等) ときはキーを省略する */
  context: ContextUsageSchema.optional(),
  /** 直前の引き継ぎの状態。引き継ぎを受けていない会話と旧サーバーは省略する */
  handoff: SessionHandoffStateSchema.optional(),
  /** この会話の egress の実効状態。旧サーバーはキーを省略する (省略 = 承認の状態を出さない) */
  networkAccess: SessionNetworkAccessSchema.optional(),
  /** 分岐元の会話 id。分岐した会話だけが載せ、親のタイトルは一覧から引く (旧サーバーは省略する) */
  parentSessionId: z.string().optional(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;
/** 作業ディレクトリ単位の serve 成功実績。一覧の会話と稼働記録の両方がこの形で cwd とコマンドを持つ */
export const ServeCommandSchema = z.object({
  /** ワークスペース root 相対の作業ディレクトリ */
  cwd: z.string(),
  command: z.string(),
});
export type ServeCommand = z.infer<typeof ServeCommandSchema>;
export const SessionSummarySchema = z.object({
  spaceId: z.string().optional(),
  sessionId: z.string(),
  title: z.string(),
  /** 会話タイトルの由来と AI 要約の試行。旧サーバーは載せない */
  titleSummary: SessionTitleSummarySchema.optional(),
  agentId: z.string(),
  agentName: z.string().optional(),
  status: RunStatusSchema,
  /**
   * ask_user の未 settle の待機があるか。待機を持たない未ロードの会話と旧サーバーは省略し、
   * `running` の意味 (BFF がそのランのために動いている) は変えない
   */
  awaitingAnswer: z.boolean().optional(),
  queueDepth: z.number(),
  /** この会話の完了を Discord へ送るか。サーバーは常に載せ、読む側は省略を false として扱う */
  notify: z.boolean().optional(),
  /** サイドバーに固定するか。未指定の旧データは false として扱う */
  pinned: z.boolean(),
  /** 同じ会話のままエージェント / スペースを引き継げるか。旧サーバーは載せないため省略可 (省略 = false) */
  canHandoff: z.boolean().optional(),
  /** プロジェクト所属か。真では引き継ぎ先のスペースを選ばない (同じ作業ディレクトリで移す先がない) */
  projectSession: z.boolean().optional(),
  /** 確定後の履歴削除 (片付け) が残っているか。残っている間は開けない / 新しい引き継ぎを受けない */
  handoffCleanup: z.boolean().optional(),
  /** 生ログ (`session.jsonl`) をダウンロードできるか。旧サーバーは載せないため省略可 (省略 = false) */
  hasRawLog: z.boolean().optional(),
  messageCount: z.number(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  /**
   * その会話の作業ディレクトリ (workdir) の serve 成功実績。実績が無ければ null。
   * cwd を共有するプロジェクト会話は同じ値を返す (実行状況からの起動可否と起動の確認に使う)。
   */
  serveCommand: ServeCommandSchema.nullable(),
  model: z.string().optional(),
  projectId: z.string().optional(),
  /**
   * 実行状況 (全スペース横断) の経過時間と終了表示のための時刻。未ロードの会話は実行を持たないため
   * 載せない (idle として返し、`lastUsedAt` を開始時刻の代用にしない)。
   */
  runStartedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** 直近のランの所要時間 (runOutcomes にあるときだけ)。無ければ終了時刻だけを出す */
  lastRunDurationMs: z.number().optional(),
  compactionStartedAt: z.number().optional(),
  /** 未 settle の質問のうち最も古い開始時刻。回答待ちの経過時間の起点 */
  awaitingSince: z.number().optional(),
  /** 分岐元の会話 id。分岐した会話だけが載せ、分岐先は同じスペースの一覧から引く */
  parentSessionId: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
/**
 * 直近の送信結果 (通常通知とテスト送信で共通の 1 件)。URL とレスポンス原文は入れない。
 * 応答が返らなかった (タイムアウト / ネットワーク / リダイレクト拒否) ときは status を省略する。
 */
export const NotificationResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  latencyMs: z.number(),
  /** Discord の message、またはアプリ側の固定文言 */
  message: z.string().optional(),
  code: z.number().optional(),
  /** 429 の待機秒数 (Discord の retry_after を切り上げた整数)。429 以外では省略する */
  retryAfter: z.number().optional(),
  at: z.number(),
});
export type NotificationResult = z.infer<typeof NotificationResultSchema>;
/**
 * GET / PUT `/api/notifications` の応答。保存済み URL もその断片も返さない (write-only)。
 * `configured` は暗号文の有無、`webhookAvailable` は復号できて送信に使えるかで、`webhookEvaluated` は
 * 「復号を試したか」を表す (未評価を誤鍵・破損と断定しない)。
 */
export const NotificationsResponseSchema = z.object({
  enabled: z.boolean(),
  askUser: z.boolean(),
  provider: z.literal("discord"),
  configured: z.boolean(),
  /** Webhook URL を復号でき、送信に使える */
  webhookAvailable: z.boolean(),
  /** 復号を評価済みか。false は「まだ確認できていない」で、失敗とは区別する */
  webhookEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未設定のときは null */
  webhookErrorMessage: z.string().nullable(),
  baseUrl: z.string().optional(),
  lastResult: NotificationResultSchema.optional(),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;
/**
 * GET / PUT / DELETE `/api/settings/archive` の応答。`excludeNames` は常に実効値で、
 * `overridden` が false のときは既定の一覧を使っている（行が無い）。
 */
export const ArchiveSettingsResponseSchema = z.object({
  excludeNames: z.array(z.string()),
  defaultExcludeNames: z.array(z.string()),
  overridden: z.boolean(),
  maxNames: z.number(),
  maxNameLength: z.number(),
});
export type ArchiveSettingsResponse = z.infer<typeof ArchiveSettingsResponseSchema>;
/**
 * GET / PUT / DELETE `/api/settings/shared-content-exclusions` の応答。形はアーカイブの設定と同じで、
 * 一覧エディタも同じ部品を使う（既定値・適用範囲・保存先だけが違う）。
 */
export const SharedContentExclusionsResponseSchema = ArchiveSettingsResponseSchema;
export type SharedContentExclusionsResponse = z.infer<typeof SharedContentExclusionsResponseSchema>;
export const ModelOptionSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  supportsThinking: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export const RuntimeAuthSourceSchema = z.enum([
  "environment",
  "stored",
  "runtime",
  "fallback",
  "models_json_key",
  "models_json_command",
  "unknown",
]);
export type RuntimeAuthSource = z.infer<typeof RuntimeAuthSourceSchema>;
/** 認証の出所だけを表す。ラベルや認証情報の値は API に含めない。 */
export const RuntimeAuthSchema = z.object({
  configured: z.boolean(),
  source: RuntimeAuthSourceSchema.optional(),
  environmentVariables: z.array(z.string()),
});
export type RuntimeAuth = z.infer<typeof RuntimeAuthSchema>;
export const RuntimeVersionsSchema = z.object({
  piCodingAgent: z.string(),
  piAi: z.string().optional(),
  commitHash: z.string().optional(),
});
export type RuntimeVersions = z.infer<typeof RuntimeVersionsSchema>;
export const RuntimeCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
});
export type RuntimeCatalogModel = z.infer<typeof RuntimeCatalogModelSchema>;
export const RuntimeCatalogProviderSchema = z.object({
  provider: z.string(),
  auth: RuntimeAuthSchema,
  models: z.array(RuntimeCatalogModelSchema),
});
export type RuntimeCatalogProvider = z.infer<typeof RuntimeCatalogProviderSchema>;
/**
 * GET /api/runtime/models と カタログ更新 の 503。カタログを取れなかった回に空の一覧で 200 を返さず、
 * 全 provider 未認証と区別できるようにする。
 */
export const RUNTIME_MODELS_UNAVAILABLE_MESSAGE = "ランタイムのモデル情報を取得できません";
/** GET /api/runtime/models。モデル一覧はこの API を開いたときだけ取得する。 */
export const RuntimeModelsResponseSchema = z.object({
  catalogCount: z.number().int().nonnegative(),
  availableCount: z.number().int().nonnegative(),
  versions: RuntimeVersionsSchema,
  providers: z.array(RuntimeCatalogProviderSchema),
});
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>;
/** 設定 → モデルの provider メモの上限。秘密情報ではなく、長文でカードが伸びるのを抑える境界 */
export const PROVIDER_MEMO_MAX_LENGTH = 500;
/** OAuth サインインで貼り付ける URL / コードの上限。中身の検証は SDK が行うので、長さだけを境界にする */
export const OAUTH_LOGIN_CODE_MAX_LENGTH = 4_096;
/** OAuth サインインの選択肢 id の上限。SDK の公開値は短いが、壊れた入力を state へ載せない */
export const OAUTH_LOGIN_SELECT_ID_MAX_LENGTH = 128;
/** 資格情報の種別。SDK が見ている値と、auth.json の保存値 (表示専用) の両方に使う */
export const CredentialKindSchema = z.enum(["oauth", "api_key"]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;
export const OAuthLoginSelectOptionSchema = z.object({
  /** SDK が返す選択肢の id。画面はこの値をそのまま POST する */
  id: z.string(),
  /** 画面用の固定文言。SDK の英語 label は載せない */
  label: z.string(),
});
export type OAuthLoginSelectOption = z.infer<typeof OAuthLoginSelectOptionSchema>;
/** 進行中の select prompt。選択肢の id / label だけを公開し、SDK の message は固定文言へ寄せる */
export const OAuthLoginSelectSchema = z.object({
  message: z.string(),
  options: z.array(OAuthLoginSelectOptionSchema),
});
export type OAuthLoginSelect = z.infer<typeof OAuthLoginSelectSchema>;
/**
 * 設定 → モデルの OAuth サインインの状態。進行中の認可 URL はこの state としてだけクライアントへ渡し、
 * 完了・失敗・キャンセルでは落とす。生の例外文言・トークン・client_id はどのフィールドにも載せない。
 */
export const OAuthLoginStateSchema = z.object({
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  /** 進行中に開く URL (認可 URL / デバイスコードの確認 URL)。running 以外と未発行は null */
  authUrl: z.string().nullable(),
  /** 進行中の主文 (ブラウザ操作の案内。画面用の固定文言) */
  instructions: z.string().nullable(),
  /** 進行中の補助行 (画面用の固定文言)。主文を置き換えず、併記する */
  progress: z.string().nullable(),
  /** 貼り付け待ちの入力欄。null = 入力を受け付けていない */
  input: z.object({ message: z.string(), placeholder: z.string() }).nullable(),
  /** 進行中の方式選択 (SDK の select)。null = 選択待ちではない */
  select: OAuthLoginSelectSchema.nullable(),
  /** デバイスコード方式のユーザーコード。null = この方式ではない */
  userCode: z.string().nullable(),
  /** failed のときの画面用の固定文言。null = 失敗以外 */
  error: z.string().nullable(),
});
export type OAuthLoginState = z.infer<typeof OAuthLoginStateSchema>;
/** 設定 → モデルの 1 プロバイダー行。認証状態は出所だけで、値・ラベル・生の認証エラーは含めない。 */
export const ProviderAuthSettingSchema = z.object({
  provider: z.string(),
  name: z.string(),
  auth: RuntimeAuthSchema,
  /** provider_credentials に行がある (保存済みの希望状態) */
  managed: z.boolean(),
  /** provider_credentials.updatedAt (epoch ms)。null = 行が無い / 移行前の行で不明 */
  keyUpdatedAt: z.number().nullable(),
  /** 保存済みのキーを復号でき、SDK へ適用できる。managed でも false になり得る */
  keyAvailable: z.boolean(),
  /**
   * 復号を評価済みか。`managed: true` / `keyEvaluated: false` は「保存済みだが復号をまだ確認していない」で、
   * 誤鍵・破損と断定しない。評価は起動・保存 / 置換・再同期・再起動でだけ行い、GET では行わない。
   */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未保存のときは null */
  keyErrorMessage: z.string().nullable(),
  /** auth.apiKey.login を持ち、この画面からキーを登録できる */
  canSetApiKey: z.boolean(),
  supportsOAuth: z.boolean(),
  /**
   * この画面でサインインを完了できる provider か。SDK の OAuth flow が求める対話は静的な metadata に
   * 現れないため、サーバーの許可リストで判定する。**任意**で、クライアントは未指定を「サインインできない」
   * として扱う (fail-closed)。OAuth を持つかどうか (`supportsOAuth`) とは別。
   */
  canSignInHere: z.boolean().optional(),
  /**
   * SDK が見ている資格情報の種別 (ModelRuntime.isUsingOAuth)。null = 認証なし。runtime overlay があるときは
   * overlay の api_key になり、auth.json の保存値は見えない (その差は hiddenStoredOAuth が表す)。
   */
  credentialKind: CredentialKindSchema.nullable(),
  /**
   * provider の `oauth.loginLabel` (例: Sign in with ChatGPT)。OAuth の表示名にだけ使う静的 metadata で、
   * トークン・client_id・認可 URL は含めない。
   */
  oauthLoginLabel: z.string().nullable(),
  /**
   * auth.source が runtime のとき、auth.json の OAuth がこの画面のキーに覆われている印。表示専用で、
   * auth.json を読めない / 壊れているときは false (不明) へ縮退させ、認証解決には使わない。
   */
  hiddenStoredOAuth: z.boolean(),
  /** 現在のカタログに provider が無い (DB 行にしか無い) */
  orphan: z.boolean(),
  /**
   * 設定 → モデルで作ったカスタムプロバイダー。通常のプロバイダー一覧からは除外し、
   * 専用セクションと「モデルを選ぶ」タブの候補だけが使う。**このプロセスで register した id だけ**に付け、
   * built-in / `models.json` と衝突して登録できなかった行の runtime entry には付けない。未指定は false。
   */
  custom: z.boolean().optional(),
  /**
   * OAuth サインインの進行状態。null = 進行中も直近の結果も無い。このプロセスのメモリだけが持ち、
   * 再起動で消える。認可 URL は running の間だけ載る。
   */
  login: OAuthLoginStateSchema.nullable(),
  /** このプロセスの SDK 反映が未完了 (apply = 未適用 / remove = 削除未反映) */
  degraded: z.enum(["apply", "remove"]).optional(),
  /**
   * 人間用メモ。provider_memos の行と同じで、null = 未設定。キーの登録有無 (managed) とは独立する。
   * 秘密情報ではないので、マスカーにも載せない (docs/secrets.md)。
   */
  memo: z.string().nullable(),
});
export type ProviderAuthSetting = z.infer<typeof ProviderAuthSettingSchema>;
/**
 * カスタムプロバイダーのモデル。1 provider = 1 model で、contextWindow は入力を必須にする
 * (OpenAI 互換 API からは取得できないため既定値を置かない)。
 */
export const CustomProviderModelSchema = z.object({
  id: z.string(),
  contextWindow: z.number().int(),
  maxTokens: z.number().int(),
});
export type CustomProviderModel = z.infer<typeof CustomProviderModelSchema>;
/**
 * 設定 → モデルのカスタムプロバイダー 1 件。**キーは返さない** (有無だけを hasKey で表す)。
 * api は v1 では openai-completions 固定。定義はアプリ DB が正で、GET は復号しない。
 */
export const CustomProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  api: z.literal("openai-completions"),
  model: CustomProviderModelSchema,
  hasKey: z.boolean(),
  /**
   * このプロセスの SDK 反映が未完了の印。`apply` は DB 行はあるが register / キー適用が済んでいない、
   * `remove` は削除待ち tombstone。未指定は「反映済み」。
   */
  degraded: z.enum(["apply", "remove"]).optional(),
  /** degraded の固定文言 (master key 未設定 / 復号不能 / id 衝突)。クライアントは原因を推測しない */
  degradedMessage: z.string().nullable().optional(),
});
export type CustomProviderSummary = z.infer<typeof CustomProviderSummarySchema>;
/**
 * `/models` の probe の失敗分類。失敗も 200 の結果として返す (HTTP エラーにすると分類と
 * `httpStatus` がクライアントの汎用エラー経路へ落ちる)。
 */
export const CustomProviderProbeFailureSchema = z.enum([
  "unauthorized",
  "not_found",
  "http_error",
  "redirected",
  "invalid_response",
  "timeout",
  "unreachable",
]);
export type CustomProviderProbeFailure = z.infer<typeof CustomProviderProbeFailureSchema>;
/**
 * カスタムプロバイダーのモデル一覧取得の結果。`failure === null` が成功で、`message` も `httpStatus` も
 * null になる。失敗は `models: []` で `message` が非 null。**キーは載せない**。
 */
export const CustomProviderProbeResponseSchema = z.object({
  checkedAt: z.number(),
  baseUrl: z.string(),
  failure: CustomProviderProbeFailureSchema.nullable(),
  /** 接続先が返した HTTP status のうち 400 以上だけ (3xx / 2xx は null) */
  httpStatus: z.number().nullable(),
  models: z.array(z.object({ id: z.string() })),
  truncated: z.boolean(),
  message: z.string().nullable(),
});
export type CustomProviderProbeResponse = z.infer<typeof CustomProviderProbeResponseSchema>;
/** GET /api/settings/models。カタログ全件は載せず、利用可能なモデルは allowedModels だけが持つ */
export const ModelsSettingsResponseSchema = z.object({
  runtimeAvailable: z.boolean(),
  /** `provider/model` の一覧。未設定 (null) = 制限なし。許可されているかの正はこのフィールドだけ */
  allowedModels: z.array(z.string()).nullable(),
  /** 保存値。null は未設定 (既定なし)。実効値は health.model */
  defaultModel: z.string().nullable(),
  /** 設定されていても無視する移行前の環境変数名 */
  ignoredEnvironmentVariables: z.array(z.string()),
  providers: z.array(ProviderAuthSettingSchema),
  /**
   * カスタムプロバイダーの定義。管理の正はこちら (アプリ DB の `custom_providers`) で、
   * `providers[]` にも同じ id が `custom: true` で載る (モデル選択の候補が使う)。
   */
  customProviders: z.array(CustomProviderSummarySchema),
});
export type ModelsSettingsResponse = z.infer<typeof ModelsSettingsResponseSchema>;
/** 変更系 (PUT / DELETE / resync) の応答。GET と同型 + 必須の state (GET は state を持たない) */
export const ModelMutationResponseSchema = ModelsSettingsResponseSchema.extend({
  state: z.enum(["applied", "applied_unsynced"]),
});
export type ModelMutationResponse = z.infer<typeof ModelMutationResponseSchema>;
/**
 * POST /api/settings/models/catalog/refresh。設定は変えず、取得できなくても 200 で現在のカタログを返す
 * (`catalogError` にだけ今回の取得結果の固定文言を載せる。一覧を失わせない)。
 */
export const ModelCatalogRefreshResponseSchema = RuntimeModelsResponseSchema.extend({
  /** 今回の取得試行の結果。null なら成功 */
  catalogError: z.string().nullable(),
});
export type ModelCatalogRefreshResponse = z.infer<typeof ModelCatalogRefreshResponseSchema>;
/** 変更系の失敗応答 (何も変わっていない)。400 は error のみ */
export const ModelMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type ModelMutationError = z.infer<typeof ModelMutationErrorSchema>;
export const UpdateProviderKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateProviderKeyBody = z.infer<typeof UpdateProviderKeyBodySchema>;
/** メモの保存。空文字は行を消して未設定へ戻す (trim は service が行う) */
export const UpdateProviderMemoBodySchema = z.object({
  memo: z.string().max(PROVIDER_MEMO_MAX_LENGTH),
});
export type UpdateProviderMemoBody = z.infer<typeof UpdateProviderMemoBodySchema>;
/** カスタムプロバイダーのモデル入力。上限と正の整数の検証は service が固定文言で行う */
export const CustomProviderModelBodySchema = z.object({
  id: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number().optional(),
});
/** カスタムプロバイダーの作成。id は作成後変更できない。キーは必須で、8..2048 文字 */
export const CreateCustomProviderBodySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: CustomProviderModelBodySchema,
});
export type CreateCustomProviderBody = z.infer<typeof CreateCustomProviderBodySchema>;
/** カスタムプロバイダーの更新。id は変更不可なので body に持たず、apiKey の空欄は既存の維持 */
export const UpdateCustomProviderBodySchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  model: CustomProviderModelBodySchema,
});
export type UpdateCustomProviderBody = z.infer<typeof UpdateCustomProviderBodySchema>;
/**
 * モデル一覧の probe。`provider` を渡すと保存済みのキーを使えて (キーは応答に返らない)、
 * `apiKey` が空欄なら保存済みを維持する。どちらも無ければ service が 400 にする。
 */
export const CustomProviderProbeBodySchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
});
export type CustomProviderProbeBody = z.infer<typeof CustomProviderProbeBodySchema>;
/** OAuth サインインの貼り付け (ブラウザの最後の画面の URL / コード)。値は応答にもログにも載せない */
export const SubmitOAuthLoginCodeBodySchema = z.object({
  code: z.string().trim().min(1).max(OAUTH_LOGIN_CODE_MAX_LENGTH),
});
export type SubmitOAuthLoginCodeBody = z.infer<typeof SubmitOAuthLoginCodeBodySchema>;
/** OAuth サインインの方式選択。進行中の select の選択肢 id だけを受け付ける */
export const SubmitOAuthLoginSelectBodySchema = z.object({
  id: z.string().trim().min(1).max(OAUTH_LOGIN_SELECT_ID_MAX_LENGTH),
});
export type SubmitOAuthLoginSelectBody = z.infer<typeof SubmitOAuthLoginSelectBodySchema>;
/** 利用可能なモデルの一括保存。両方 null が「未設定へ戻す」なので DELETE は持たない */
export const UpdateModelAvailabilityBodySchema = z.object({
  allowedModels: z.array(z.string()).nullable(),
  defaultModel: z.string().nullable(),
});
export type UpdateModelAvailabilityBody = z.infer<typeof UpdateModelAvailabilityBodySchema>;
/**
 * GET /api/settings/cloudflare。トークンは返さず、登録状態とアカウント ID だけを返す。
 * `available: false` は master key が使えず、登録・復号が 503 になる状態。
 */
export const CloudflareSettingsResponseSchema = z.object({
  configured: z.boolean(),
  accountId: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type CloudflareSettingsResponse = z.infer<typeof CloudflareSettingsResponseSchema>;
/**
 * 接続確認の失敗の分類。`CloudflareFailureKind` に、workers.dev サブドメインが空だった場合だけを
 * 接続確認側で足す（`CloudflareFailureKind` 自体は広げない）。
 */
export const CloudflareConnectionFailureSchema = z.enum([
  "unauthorized",
  "not_found",
  "quota",
  "rate_limited",
  "invalid",
  "transient",
  "timeout",
  "network",
  "unverifiable",
  "no_subdomain",
]);
export type CloudflareConnectionFailure = z.infer<typeof CloudflareConnectionFailureSchema>;
/**
 * POST /api/settings/cloudflare/check。保存済みの資格情報で Cloudflare へ届くかを確かめた結果で、
 * 失敗も 200 で返す。成功は `failure === null` かつ `subdomain` が非空、失敗は `subdomain === null`
 * かつ `message` が非 null。`httpStatus` は Cloudflare が返した 400 以上の status だけで、
 * タイムアウト / 通信不能 / 空の subdomain は null。トークンと応答本文は載せない。
 */
export const CloudflareConnectionCheckResponseSchema = z.object({
  checkedAt: z.number(),
  accountId: z.string(),
  subdomain: z.string().nullable(),
  failure: CloudflareConnectionFailureSchema.nullable(),
  httpStatus: z.number().nullable(),
  message: z.string().nullable(),
});
export type CloudflareConnectionCheckResponse = z.infer<typeof CloudflareConnectionCheckResponseSchema>;
/** 変更系 (PUT / DELETE) の応答。何も保存されなかった 503 は `state: "not_stored"` */
export const CloudflareMutationResponseSchema = CloudflareSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type CloudflareMutationResponse = z.infer<typeof CloudflareMutationResponseSchema>;
/**
 * PUT /api/settings/cloudflare。`apiToken` を省略した更新は保存済みトークンを維持する。
 * 形式の検証はサービス側で行い、値そのものは応答・ログへ出さない。
 */
export const UpdateCloudflareSettingsBodySchema = z.object({
  accountId: z.string().min(1).max(64),
  apiToken: z.string().max(512).optional(),
});
export type UpdateCloudflareSettingsBody = z.infer<typeof UpdateCloudflareSettingsBodySchema>;
/**
 * 設定 → ランタイムの実行環境カードが使う状態。`connected` だけが情報を持ち、他は理由の分類だけを返す
 * (URL / トークン / 内部エラーは載せない)。`connected` は診断 API の正常応答だけで、
 * ツール実行の成功を保証しない。
 */
export const RuntimeEnvironmentStateSchema = z.enum([
  "connected",
  "not_configured",
  "unreachable",
  "unauthorized",
  "timeout",
  "probe_failed",
]);
export type RuntimeEnvironmentState = z.infer<typeof RuntimeEnvironmentStateSchema>;
/**
 * サンドボックスの `GET /v1/runtime/info` の応答検証。ワイヤ契約の正は `sandbox/protocol.ts` の
 * `SandboxRuntimeInfo` で、ここは BFF が受けた応答を検証するための写し。
 */
export const SandboxRuntimeInfoSchema = z.object({
  environment: z.object({
    os: z.string(),
    arch: z.string(),
    user: z.string(),
    isRoot: z.boolean(),
    workspace: z.string(),
  }),
  commands: z.array(z.object({ name: z.string(), version: z.string().nullable() })),
  landlock: z.object({
    state: z.enum(["enabled", "unavailable"]),
    abi: z.number().nullable(),
    minAbi: z.number(),
    reason: z.enum(["wrapper_missing", "unsupported", "abi_unsupported", "probe_failed"]).optional(),
  }),
  /** 旧 sandbox は返さない。BFF は空配列として読み、capability の不一致を diagnostics に出す */
  capabilities: z.array(z.string()).optional(),
  /** 旧 sandbox は返さない。null は「アプリの global config を管理していない」 */
  gitConfig: z
    .object({
      state: z.enum(["ready", "failed"]),
      path: z.string(),
      reason: z.enum(["home_unavailable", "inside_workspace", "symlink", "write_failed"]).optional(),
      ownershipWarnings: z.array(z.object({ cwd: z.string() })).optional(),
    })
    .optional(),
});
/**
 * GET /api/runtime/environment の公開 DTO。未接続でも HTTP 200 で返し、UI は HTTP ステータスや
 * 文言ではなく `state` で分岐する。共通の項目は `sandbox/protocol.ts` の型をそのまま使う。
 */
export type RuntimeEnvironmentResponse =
  | {
      state: "connected";
      environment: SandboxRuntimeEnvironment;
      commands: SandboxRuntimeCommand[];
      landlock: SandboxLandlockStatus;
      /** サンドボックスが実装している機能。旧版は空で、BFF が git-config-v1 の不一致を警告する */
      capabilities: string[];
      /** アプリの global gitconfig の状態。旧版は null */
      gitConfig: SandboxGitConfigStatus | null;
    }
  | { state: Exclude<RuntimeEnvironmentState, "connected"> };
/** クライアントへ配るため、ワイヤ契約の共通項目も schema 経由で再 export する */
export type { SandboxGitConfigStatus, SandboxLandlockStatus, SandboxRuntimeCommand, SandboxRuntimeEnvironment };
/** client/src/types.ts の Health に加え、ルート固有のフィールドを optional で許容する。 */
export const HealthSchema = z.object({
  cwd: z.string().optional(),
  ready: z.boolean(),
  model: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.enum(["authentication_required", "model_whitelist_empty", "runtime_unavailable"]).optional(),
  ok: z.boolean().optional(),
  availableModels: z.array(z.string()).optional(),
  modelOptions: z.array(ModelOptionSchema).optional(),
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  /** 保存された既定モデルが利用不能なときの理由 (ready は true のまま) */
  defaultModelError: z.string().optional(),
  /** 保存された既定モデルが無い状態。候補があっても新規会話はモデル未指定では作れない */
  defaultModelUnset: z.boolean().optional(),
  tools: z.array(z.string()).optional(),
  availabilityError: z.string().optional(),
  sandboxConfigured: z.boolean().optional(),
  /** プレビュー オリジン (別リスナー) のブラウザから見たポート。待受は別 env */
  filePreviewPort: z.number().optional(),
  /** サンドボックスで serve した成果物のブラウザから見たポート */
  previewPort: z.number().optional(),
  /** ブラウザから見たアプリのオリジン (env `PI_APP_ORIGIN`)。未設定はキー自体を返さない */
  appOrigin: z.string().optional(),
  /** ブラウザから見たプレビュー オリジン (env `PI_FILE_PREVIEW_ORIGIN`)。未設定はキー自体を返さない */
  filePreviewOrigin: z.string().optional(),
  /** ブラウザから見たサービス オリジン (env `PI_PREVIEW_ORIGIN`)。未設定はキー自体を返さない */
  serviceOrigin: z.string().optional(),
  /** 実行中の SDK バージョン。ランタイムの診断とは独立に出し続ける */
  versions: RuntimeVersionsSchema.optional(),
  /** ダウンロード ZIP の除外規則の実効値。UI は行にダウンロードを出すかの判定に使う */
  archive: z
    .object({
      excludeNames: z.array(z.string()),
    })
    .optional(),
  /** 会話ストアの状態。null は永続化なし (未設定・テスト) */
  sessionStore: z
    .object({
      path: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().optional(),
      /** 保存に失敗している live セッション数 */
      dirty: z.number().optional(),
    })
    .optional(),
  /** アプリデータ (プロジェクト / カタログ) の SQLite。null は永続化なし (未設定・テスト) */
  appDb: z
    .object({
      path: z.string().nullable(),
      ok: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
});
export type Health = z.infer<typeof HealthSchema>;
export const PostMessageResultSchema = z.object({
  queued: z.boolean(),
  queueDepth: z.number(),
  /** 受付ごとの送信ID。再送でも同じ値を返す */
  sendId: z.string(),
  /** 実行へ割り当て済みなら実行ID (待機しただけの送信では省略する) */
  runId: z.string().optional(),
});
export type PostMessageResult = z.infer<typeof PostMessageResultSchema>;
export const StopResultSchema = z.object({
  ok: z.literal(true),
  status: RunStatusSchema,
});
export type StopResult = z.infer<typeof StopResultSchema>;
/** `DELETE /api/sessions/:id/unsent/:runId` の応答 */
export const DiscardUnsentResultSchema = z.object({ ok: z.literal(true) });
export type DiscardUnsentResult = z.infer<typeof DiscardUnsentResultSchema>;
/** `DELETE /api/sessions/:id/queue/:runId` の応答。件数は resync の payload が正なので載せない */
export const CancelQueuedResultSchema = z.object({ ok: z.literal(true) });
export type CancelQueuedResult = z.infer<typeof CancelQueuedResultSchema>;
/** `POST /api/sessions/:id/compact` の応答。完了まで待って実効状態を返す */
export const SessionCompactionResultSchema = z.object({
  sessionId: z.string(),
  status: RunStatusSchema,
});
export type SessionCompactionResult = z.infer<typeof SessionCompactionResultSchema>;
/**
 * `PATCH /api/sessions/:id/notify` の応答。live / 未ロードで同じ形にし、SDK セッションを開かない
 * 未ロードでも返せるよう会話全文 (`messages`) は載せない。
 */
export const SessionNotifyResponseSchema = z.object({
  sessionId: z.string(),
  notify: z.boolean(),
});
export type SessionNotifyResponse = z.infer<typeof SessionNotifyResponseSchema>;
/** `PATCH /api/sessions/:id/pin` の応答。live / 未ロードで同じ小さな DTO を返す。 */
export const SessionPinnedResponseSchema = z.object({
  sessionId: z.string(),
  pinned: z.boolean(),
});
export type SessionPinnedResponse = z.infer<typeof SessionPinnedResponseSchema>;
/**
 * `PATCH /api/sessions/:id/title` の応答。notify と同じく live / 未ロードで同じ形にし、
 * SDK セッションを開かない未ロードでも返せるよう会話全文 (`messages`) は載せない。
 * `title` は正規化 (trim / 秘密のマスク / 上限) 後で、一覧の表示と一致する。
 */
export const SessionTitleResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
});
export type SessionTitleResponse = z.infer<typeof SessionTitleResponseSchema>;
/**
 * `POST /api/sessions/:id/move` の応答。移動後も会話全文は返さず、一覧の更新に必要な最小だけを返す。
 * `spaceId` は移動先で、`title` は一覧と同じ正規化 (未設定は「無題のセッション」) 後の値。
 * `memo` は HANDOFF.md を書いた引き継ぎか、`cleanupPending` は履歴削除の片付けが残っているか。
 */
export const SessionMoveResponseSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  spaceId: z.string(),
  memo: z.boolean().optional(),
  cleanupPending: z.boolean().optional(),
});
export type SessionMoveResponse = z.infer<typeof SessionMoveResponseSchema>;

// ---------------------------------------------------------------------------
// リクエスト body スキーマ
// route が見るのは JSON の形と型だけ。必須判定と正規化 (trim / 上限 / 未知キー) は catalog が正
// ---------------------------------------------------------------------------
export const PostMessageBodySchema = z.object({
  /** 通常の送信は必須。`resendRunId` を指定した再送では本文を送らず、サーバーが保存済みの本文を使う */
  text: z.string().optional(),
  /**
   * タイトル用の入力。定型プロンプト (suggestion) を結合する前の本文で、省略時は `text` を使う
   * (従来形式のクライアントはタイトル用の情報を送らない)。
   */
  titleSource: z.string().optional(),
  /** 添付 (root 相対。既定スペースは `<appdir>/uploads/<sessionId>/` 配下)。件数とパスの検証は attachments.ts が正 */
  attachments: z.array(z.string()).optional(),
  /** 未送信メッセージの再送。本文は保存済みの生テキストを使い、同じ送信IDで実行し直す */
  resendSendId: z.string().optional(),
  /** `resendSendId` の互換名。同時指定は 400 */
  resendRunId: z.string().optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;
/**
 * ask_user の回答。質問数と index の対応、`skipped` の排他は store が正 (route は JSON の形だけを見る)。
 * 全質問に 1 つずつ回答が要り、一部だけの回答は 400 になる。
 */
export const AnswerQuestionBodySchema = z.object({ answers: z.array(AskUserAnswerSchema) });
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBodySchema>;
/** 拒否済みの承認カードから許可へ変える要求。接続先はカードに出たホストをそのまま渡す */
export const ApproveNetworkAccessBodySchema = z.object({ host: z.string().min(1).max(253) });
export type ApproveNetworkAccessBody = z.infer<typeof ApproveNetworkAccessBodySchema>;
export const ApproveNetworkAccessResponseSchema = z.object({
  ok: z.literal(true),
  host: z.string(),
  mode: NetworkAccessModeSchema,
  approved: z.literal(true),
});
export type ApproveNetworkAccessResponse = z.infer<typeof ApproveNetworkAccessResponseSchema>;
export const CreateSessionBodySchema = z.object({
  spaceId: z.string().optional(),
  agentId: z.string().optional(),
  // 未指定ならエージェント定義 → アプリ既定の順に解決する (null は 400)
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  // 未指定は未所属 (cwd = root になるのは永続化なしの既定スペースだけ)。未知の id は 400
  projectId: z.string().min(1).optional(),
  // 新規チャットで選んだ通知トグルを、作成されるセッションへ引き継ぐ (未指定は false)
  notify: z.boolean().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
/** チャット設定変更。省略は現在値維持、null・空 body は 400 */
export const UpdateSessionSettingsBodySchema = z.object({
  model: ModelRefSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type UpdateSessionSettingsBody = z.infer<typeof UpdateSessionSettingsBodySchema>;
/**
 * 会話ごとの通知トグル。model / thinkingLevel の設定変更とは別経路にして、
 * SDK の設定変更と busy 判定を通さずに実行中でも切り替えられるようにする。
 */
export const UpdateSessionNotifyBodySchema = z.object({ notify: z.boolean() });
export type UpdateSessionNotifyBody = z.infer<typeof UpdateSessionNotifyBodySchema>;
/** 会話ごとのサイドバー固定。SDK に触れず busy 中も更新できる。 */
export const UpdateSessionPinnedBodySchema = z.object({ pinned: z.boolean() });
export type UpdateSessionPinnedBody = z.infer<typeof UpdateSessionPinnedBodySchema>;
/**
 * 会話タイトルの変更。notify と同じく SDK に触らないため実行中でも変えられる。
 * 空・空白だけ・上限超えの正規化は store が正 (route は JSON の形だけを見る)。
 */
export const UpdateSessionTitleBodySchema = z.object({ title: z.string() });
export type UpdateSessionTitleBody = z.infer<typeof UpdateSessionTitleBodySchema>;
/**
 * セッションの引き継ぎ (引っ越しの拡張)。要求元スペースは query (`sessionSpaceGuard` が照合する) で、
 * 本文は移動先・引き継ぎ先のエージェント・メモの有無を持つ。`agentId` の省略は現在のエージェントを維持し、
 * `memo` の省略は false (既存の「引っ越す」の意味を変えない)。
 */
export const MoveSessionBodySchema = z.object({
  spaceId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  memo: z.boolean().optional(),
});
export type MoveSessionBody = z.infer<typeof MoveSessionBodySchema>;
/**
 * 会話の分岐。`agentId` の省略は親のスナップショット (エージェント・スキル・ツールの許可) を維持し、
 * 指定時は引き継ぎと同じく現在の定義から作り直す。対象の会話とスペースは path / query で決まる。
 */
export const ForkSessionBodySchema = z.object({
  agentId: z.string().min(1).optional(),
});
export type ForkSessionBody = z.infer<typeof ForkSessionBodySchema>;
/**
 * serve (UI 上の呼称は「サービス」) の状態。稼働判定は常にプローブで、記録は表示と操作権限にだけ使う。
 * `owner.kind` の `mine` / `other` は記録と「いま待受しているプロセス」が一致したときだけ立つ。
 */
export const ServeOwnerKindSchema = z.enum(["mine", "other", "unknown", "none"]);
export type ServeOwnerKind = z.infer<typeof ServeOwnerKindSchema>;
export const ServeOwnerSchema = z.object({
  kind: ServeOwnerKindSchema,
  /** `mine` / `other` のときだけ載る会話名 */
  title: z.string().optional(),
});
export const ServeStatusSchema = z.object({
  reachable: z.boolean(),
  owner: ServeOwnerSchema,
  /** 置き換えの再照合用。記録が無ければ null */
  generation: z.string().nullable(),
  /** 閲覧中の会話の作業ディレクトリの実績。無ければ null */
  command: ServeCommandSchema.nullable(),
  /**
   * 起動時に解決した環境変数の世代。一覧 API の `generation` と比べると「再起動で反映される変更」が
   * 分かる (UI は今回は説明の 1 行まで)。記録が無い / この項目より前の記録は null
   */
  secretGeneration: z.string().nullable(),
});
export type ServeStatus = z.infer<typeof ServeStatusSchema>;
/** 設定 → ランタイム。閲覧中の会話の実績ではなく、いま公開中のサービスを返す。 */
export const RuntimeServeStatusSchema = z.object({
  reachable: z.boolean(),
  /** 起動元の会話。所属スペースが引けない (削除済み等) ときは `spaceId` を載せない */
  owner: z.object({ sessionId: z.string(), title: z.string(), spaceId: z.string().optional() }).nullable(),
  generation: z.string().nullable(),
  command: ServeCommandSchema.nullable(),
});
export type RuntimeServeStatus = z.infer<typeof RuntimeServeStatusSchema>;
export const RuntimeServeStopBodySchema = z
  .object({
    generation: z.string().min(1),
  })
  .strict();
export type RuntimeServeStopBody = z.infer<typeof RuntimeServeStopBodySchema>;
/** 起動。command はエージェントの serve ツールだけが渡す (GUI は実績をそのまま使う) */
export const ServeStartBodySchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1).optional(),
  generation: z.string().nullable().optional(),
});
export type ServeStartBody = z.infer<typeof ServeStartBodySchema>;
export const ServeStopBodySchema = z.object({
  sessionId: z.string().min(1),
  generation: z.string().nullable().optional(),
});
export type ServeStopBody = z.infer<typeof ServeStopBodySchema>;
/**
 * 実行状況から全スペース横断で起動する。会話の所属スペースは問わない (全体管理の面) ため、
 * `/api/serve/start` と違って `?spaceId` との一致を要求しない。
 */
export const RuntimeServeStartBodySchema = z.object({
  sessionId: z.string().min(1),
  generation: z.string().nullable().optional(),
});
export type RuntimeServeStartBody = z.infer<typeof RuntimeServeStartBodySchema>;
/**
 * 設定 → ランタイム のデバッグ一覧。行はレンジ走査で見付かった待受だけで、lease の無い行 (追跡外) は
 * `owner` / `command` / `startedAt` を null にする。`owner` は会話ストアに起動元が残っていて、待受ソケットが
 * lease と一致するときだけ載る (削除済み / 追跡外 / 待受の入れ替わりは null = 所有者不明)。
 */
export const RuntimeDebugServeEntrySchema = z.object({
  port: z.number().int(),
  owner: z.object({ sessionId: z.string(), title: z.string(), spaceId: z.string().optional() }).nullable(),
  command: z.string().nullable(),
  /** 待受プロセスの起動時刻 (epoch ms)。追跡外は null */
  startedAt: z.number().nullable(),
});
export type RuntimeDebugServeEntry = z.infer<typeof RuntimeDebugServeEntrySchema>;
export const RuntimeDebugServeStatusSchema = z.object({ servers: z.array(RuntimeDebugServeEntrySchema) });
export type RuntimeDebugServeStatus = z.infer<typeof RuntimeDebugServeStatusSchema>;
/** 停止対象はレンジ内のポートだけ (対象は常に「いまそのポートで待受している PID」で、世代照合は持たない) */
export const RuntimeDebugServeStopBodySchema = z.object({ port: z.number().int() }).strict();
export type RuntimeDebugServeStopBody = z.infer<typeof RuntimeDebugServeStopBodySchema>;
/** `alreadyStopped` は「そのポートに待受が無い」を表し、成功として返す */
export const RuntimeDebugServeStopResultSchema = z.object({
  port: z.number().int().nullable(),
  released: z.boolean(),
  alreadyStopped: z.boolean(),
});
export type RuntimeDebugServeStopResult = z.infer<typeof RuntimeDebugServeStopResultSchema>;

// ---------------------------------------------------------------------------
// 環境変数 (作業環境 → 環境変数。docs/secrets.md)
// ---------------------------------------------------------------------------
/** 通知設定の更新。キー省略は現在値の維持、webhookUrl / baseUrl の null は解除 */
export const UpdateNotificationsBodySchema = z.object({
  enabled: z.boolean().optional(),
  askUser: z.boolean().optional(),
  webhookUrl: z.string().nullish(),
  baseUrl: z.string().nullish(),
});
export type UpdateNotificationsBody = z.infer<typeof UpdateNotificationsBodySchema>;
/** アーカイブ除外名の更新。一覧は丸ごと差し替える（空配列は「除外なし」を表す） */
export const UpdateArchiveSettingsBodySchema = z.object({ excludeNames: z.array(z.string()) });
export type UpdateArchiveSettingsBody = z.infer<typeof UpdateArchiveSettingsBodySchema>;
/** 共有の除外名の更新。同じく丸ごと差し替える */
export const UpdateSharedContentExclusionsBodySchema = z.object({ excludeNames: z.array(z.string()) });
export type UpdateSharedContentExclusionsBody = z.infer<typeof UpdateSharedContentExclusionsBodySchema>;
export const EventDataSchemas = {
  // `startedAt` は payload の `run.startedAt` と同じ値。クライアントは受信時刻ではなくこれを使う
  // (切断中に始まった run の `run_start` がリプレイされても開始時刻がぶれない)
  run_start: z.object({
    runId: z.string(),
    /** この実行を開始した送信のID (旧サーバーは載せない) */
    initialSendId: z.string().optional(),
    prompt: z.string(),
    startedAt: z.number(),
  }),
  text: z.object({ delta: z.string(), assistantId: z.string().optional() }),
  tool_start: z.object({
    id: z.string(),
    name: z.string(),
    args: z.string(),
    skill: SkillLoadSchema.optional(),
    questions: z.array(AskUserQuestionSchema).optional(),
    /** BFF がイベントの到着時刻で測った開始時刻。`run.toolCalls[].startedAt` と同じ値 */
    startedAt: z.number().optional(),
    /** このツールを要求した assistant 応答のID */
    assistantId: z.string().optional(),
  }),
  tool_end: z.object({
    id: z.string(),
    name: z.string().optional(),
    isError: z.boolean(),
    output: z.string(),
    answers: z.array(AskUserAnswerSchema).optional(),
    /** BFF がイベントの到着時刻で測った終了時刻。`run.toolCalls[].endedAt` と同じ値 */
    endedAt: z.number().optional(),
  }),
  // investigate の子の進捗。`id` は tool_start / tool_end と同じ toolCallId で、ライブの
  // `ToolCall.progress` だけを更新する (payload の `run.toolCalls` には載せない)
  tool_progress: z.object({ id: z.string(), text: z.string() }),
  // 状態行の活動ラベル。`thinking` は live 専用の thinking 末尾で、保存せずリプレイでも落とす。
  // mask 済み・最大 `LIVE_THINKING_MAX_CHARS` code point (`server/src/live-thinking.ts`)
  status: z.object({ state: z.string(), text: z.string(), thinking: z.string().optional() }),
  queued: z.object({
    position: z.number(),
    queueDepth: z.number(),
    /** 待機した送信のID。応答が届く前でも、この値で自分の待機を特定できる */
    sendId: z.string().optional(),
    prompt: z.string(),
  }),
  // 停止で破棄した待機メッセージの送信ID。クライアントが「未送信」へ切り替えるために使う
  queue_cleared: z.object({ sendIds: z.array(z.string()).optional() }).strict(),
  // assistant の message_end ごとに 1 件。usage はプロバイダが報告したときだけ入る
  usage: z.object({
    usage: UsageSchema.optional(),
    metrics: MessageMetricsSchema.optional(),
    context: ContextUsageSchema.optional(),
    assistantId: z.string().optional(),
  }),
  /**
   * assistant の応答が終わった (message_end)。クライアントは開いている応答カードを閉じ、
   * 続く delta を次のカードへ入れる。usage とは別で、model だけを載せる
   */
  assistant_end: z.object({
    assistantId: z.string().optional(),
    /** 応答を生成したモデル (`provider/model`)。null は不明、未指定は旧サーバー */
    model: z.string().nullable().optional(),
  }),
  run_end: z.object({
    runId: z.string().optional(),
    status: RunStatusSchema,
    queueDepth: z.number(),
    /**
     * BFF 計測のラン全体の所要時間。クライアントが完了時の合計時間として表示する。
     * キュー待ちは含めない (開始は `startRun()` の時刻)。旧サーバーは載せない
     */
    durationMs: z.number().optional(),
    error: z.string().optional(),
    /** 最終失敗の分類コード。payload の `run.errorCode` と同じ値で、error と組で載る */
    errorCode: RunErrorCodeSchema.optional(),
    messageCount: z.number().optional(),
    /** ラン中の再試行スケジュール累計 (error の文言にも含まれる。構造で読むクライアント用) */
    totalRetryCount: z.number().optional(),
    // message_end 時点の context は SDK が履歴へ入れる前で古いため、確定値は run_end で配る
    context: ContextUsageSchema.optional(),
  }),
  // 自動再試行の開始 / 再実行開始 / 解除。payload.run.retry と同じ形を serverNow と組で配る
  run_retry: z.object({
    retry: RunRetryStateSchema.nullable(),
    totalRetryCount: z.number(),
    serverNow: z.number(),
  }),
  // compaction_end の 1 件分と、その時点の累計回数。続けて resync が同じ状態を配る
  compaction: z.object({
    compaction: CompactionInfoSchema,
    count: z.number(),
  }),
  resync: SessionPayloadSchema,
  session_deleted: z.object({ sessionId: z.string() }),
} as const;
export type SSEEventType = keyof typeof EventDataSchemas;
export type SSEEventData = {
  [T in SSEEventType]: z.infer<(typeof EventDataSchemas)[T]>;
};
type EventEntryFor<T extends SSEEventType> = {
  seq: number;
  type: T;
  data: SSEEventData[T];
  at: number;
};
export type EventEntry = {
  [T in SSEEventType]: EventEntryFor<T>;
}[SSEEventType];

// ---------------------------------------------------------------------------
// セッション診断 (GET /api/sessions/:id/diagnostics。docs/diagnostics.md)
// ---------------------------------------------------------------------------
/** diagnostics の items が持つ種別。SSE の型と 1:1 で、イベントを足すとこの enum も型で要求される */
const SSEEventTypeSchema = z.enum(Object.keys(EventDataSchemas) as [SSEEventType, ...SSEEventType[]]);
/**
 * 1 件のイベント。`data` は mask 済みの値をそのまま載せ、上限を超えた分だけ切り詰める (そのときは
 * `truncated` を立て、元の schema を満たさない可能性がある)。
 */
export const DiagnosticsEventSchema = z.object({
  seq: z.number(),
  type: SSEEventTypeSchema,
  /** サーバーが発行した時刻 (epoch ms) */
  at: z.number(),
  /** `data` の JSON バイト数 (切り詰め前) */
  bytes: z.number(),
  data: z.unknown(),
  /** `data` を上限へ切り詰めた */
  truncated: z.literal(true).optional(),
});
export type DiagnosticsEvent = z.infer<typeof DiagnosticsEventSchema>;
/**
 * `GET /api/sessions/:id/diagnostics` の応答。不具合の切り分け用に、サーバー側の観測を 1 回ぶんまとめる。
 * 本文 (メッセージ / 質問 / 回答) は載せず、件数と mask 済みの要約だけを持つ。上限で落とした件数は
 * `events.dropped` に残し、無言で切り詰めない。会話タイトルも本文の先頭を含み得るため載せない。
 */
export const SessionDiagnosticsSchema = z.object({
  kind: z.literal("u7agent-session-diagnostics"),
  version: z.literal(1),
  sessionId: z.string(),
  /** 採取時刻 (epoch ms) */
  capturedAt: z.number(),
  /** SSE の世代。client 側の lastCursor.generation と突き合わせる */
  eventGeneration: z.string(),
  /** この時点で最後に発行した seq */
  lastSeq: z.number(),
  status: RunStatusSchema,
  meta: z.object({
    spaceId: z.string(),
    agentId: z.string(),
    agentName: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    /** 作業ディレクトリ (workspace root 相対) */
    workdir: z.string(),
    createdAt: z.number(),
    lastUsedAt: z.number(),
    messageCount: z.number(),
    model: z.string().optional(),
    /** 実効 thinkingLevel。SDK が補正した値なので、定義上の列挙より広い文字列で返す (payload と同じ) */
    thinkingLevel: z.string().optional(),
    notify: z.boolean(),
    pinned: z.boolean(),
    /** 直近の保存失敗 (meta / JSONL 共通)。成功していれば省略 */
    persistError: z.string().optional(),
    /** 直近の送信対応記録の保存失敗 */
    sendsError: z.string().optional(),
    /** 送信対応記録がディスクと食い違ったまま (書込みの再試行待ち) */
    sendsDirty: z.boolean(),
  }),
  /** 待機中の送信。本文は載せず、件数と run id だけを持つ */
  queue: z.object({ depth: z.number(), sendIds: z.array(z.string()) }),
  run: z
    .object({
      id: z.string(),
      status: RunStatusSchema,
      startedAt: z.number(),
      endedAt: z.number().optional(),
      /** ラン中の自動再試行のスケジュール累計 */
      totalRetryCount: z.number(),
      retry: RunRetryStateSchema.optional(),
      errorCode: RunErrorCodeSchema.optional(),
      error: z.string().optional(),
    })
    .nullable(),
  /** ask_user の待機 / 回答済み (toolCallId と件数だけ。質問文と回答本文は載せない) */
  questions: z.array(z.object({ toolCallId: z.string(), questionCount: z.number(), settled: z.boolean() })),
  /**
   * タイトルの由来と AI 要約の試行 (状態・モデル・usage)。依頼本文と生成タイトルは載せない
   * (診断 JSON が本文を含まない契約の一部)。旧サーバーは載せないため省略可。
   */
  title: SessionTitleSummarySchema.optional(),
  events: z.object({
    /** 件数の上限 (これより古い分は返さない) */
    limit: z.number(),
    /** 応答全体のバイト上限 */
    maxBytes: z.number(),
    /** リングバッファに残っている件数 */
    available: z.number(),
    /** 古い→新しい順のイベント */
    items: z.array(DiagnosticsEventSchema),
    /** 件数とバイトの上限で落とした件数 */
    dropped: z.number(),
    /** `data` を切り詰めたイベントの件数 */
    truncated: z.number(),
  }),
  /** 生ログ (`session.jsonl`) の有無。無いときは UI がダウンロードを押せないようにする */
  raw: z.object({ available: z.boolean(), bytes: z.number().optional() }),
});
export type SessionDiagnostics = z.infer<typeof SessionDiagnosticsSchema>;
/**
 * GET / PUT /api/settings/web-search。`web_search` の有効 / 無効と既定 provider を持つ。
 * 行が無い = 既定（無効 / 先頭の provider）なので、初期状態では `enabled: false` が返る。
 */
export const WebSearchProviderIdSchema = z.enum(WEB_SEARCH_PROVIDER_IDS);
export type WebSearchProviderId = z.infer<typeof WebSearchProviderIdSchema>;
/** provider 1 件の公開情報。`host` は外部送信先を画面で隠さないために出し、キーの値は返さない */
export const WebSearchProviderSchema = z.object({
  id: WebSearchProviderIdSchema,
  name: z.string(),
  host: z.string(),
  keyless: z.boolean(),
  /** キーが登録済みか。keyless の provider は常に true */
  configured: z.boolean(),
  /** APIキーの暗号文がある。keyless は常に false */
  keyStored: z.boolean(),
  /** キーを復号でき、検索に使える。keyless は常に true */
  keyAvailable: z.boolean(),
  /** 復号を評価済みか。keyless は常に true */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未保存のときは null */
  keyErrorMessage: z.string().nullable(),
});
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;
export const WebSearchSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  /** 既定の provider。設定した値が次の検索から使われる */
  provider: WebSearchProviderIdSchema,
  providers: z.array(WebSearchProviderSchema),
  /** 無効のときに `web_search` がモデルへ返す固定文言。画面は同じ文言をそのまま出す */
  disabledMessage: z.string(),
});
export type WebSearchSettingsResponse = z.infer<typeof WebSearchSettingsResponseSchema>;
/** 変更系（PUT / DELETE）の応答。即時反映なので `applied` だけを返す（コンテンツ生成と同じ契約） */
export const WebSearchMutationResponseSchema = WebSearchSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type WebSearchMutationResponse = z.infer<typeof WebSearchMutationResponseSchema>;
/** トグルの変更。既存セッションにも次の呼び出しから効く（ツール側が毎回読む） */
export const UpdateWebSearchBodySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateWebSearchBody = z.infer<typeof UpdateWebSearchBodySchema>;
/** 既定 provider の変更。provider の選択と「既定にする」は同じ操作にする（GUI もそう振る舞う） */
export const UpdateWebSearchProviderBodySchema = z.object({
  provider: WebSearchProviderIdSchema,
});
export type UpdateWebSearchProviderBody = z.infer<typeof UpdateWebSearchProviderBodySchema>;
/** provider の APIキーの登録・上書き。長さは provider_credentials / 画像と同じ */
export const UpdateWebSearchKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateWebSearchKeyBody = z.infer<typeof UpdateWebSearchKeyBodySchema>;
/**
 * テスト検索の入力。空白だけは 400 にし、上限は GUI の入力欄に合わせる
 * (チャットの `web_search` は provider 側の上限に任せていて、こことは独立)。
 */
export const WEB_SEARCH_TEST_QUERY_MAX_LENGTH = 500;
export const WebSearchTestBodySchema = z.object({
  query: z.string().trim().min(1).max(WEB_SEARCH_TEST_QUERY_MAX_LENGTH),
});
export type WebSearchTestBody = z.infer<typeof WebSearchTestBodySchema>;
/** テスト検索が実際に送った provider。解決できなかった / 無効のときは null */
export const WebSearchTestProviderSchema = z.object({
  id: WebSearchProviderIdSchema,
  name: z.string(),
  host: z.string(),
});
export type WebSearchTestProvider = z.infer<typeof WebSearchTestProviderSchema>;
/**
 * テスト検索の応答。`output` は成功ならモデルへ返る本文、失敗なら throw する文言 (どちらもマスク済み) で、
 * 画面はそのまま出す。失敗も 200 で返し、保存状態は変えない (会話タイトルの動作確認と同じ契約)。
 */
export const WebSearchTestResponseSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  provider: WebSearchTestProviderSchema.nullable(),
  /** 出典の件数。失敗時は 0 */
  resultCount: z.number(),
  durationMs: z.number(),
});
export type WebSearchTestResponse = z.infer<typeof WebSearchTestResponseSchema>;
/** 変更系の失敗応答（何も変わっていない） */
export const WebSearchMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type WebSearchMutationError = z.infer<typeof WebSearchMutationErrorSchema>;
/**
 * GET / PUT `/api/settings/session-title`。会話タイトルの AI 要約 (On/Off・要約モデル・Effort・定義) を持つ。
 * 行が無い = 既定 (Off・モデル未選択・Effort 未指定・既定の定義)。モデルは本会話のモデルと独立で、
 * `provider/id` で表す。Effort はモデルが対応する段階だけを保存できる。
 */
export const TitleSummaryModelChoiceSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  /** そのモデルが選べる Effort。推論非対応は ["off"] */
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type TitleSummaryModelChoice = z.infer<typeof TitleSummaryModelChoiceSchema>;
export const TitleSummarySettingsResponseSchema = z.object({
  enabled: z.boolean(),
  /** 選択中のモデル (`provider/id`)。未選択は null */
  model: z.string().nullable(),
  /** 保存済みの Effort。null は未指定 (実効値は effectiveThinkingLevel) */
  thinkingLevel: ThinkingLevelSchema.nullable(),
  /** 実際の要約に使う Effort。未指定ならモデルの最小段階、モデル不在なら null */
  effectiveThinkingLevel: ThinkingLevelSchema.nullable(),
  definition: z.string(),
  /** 既定の定義 (画面の「既定に戻す」が使う) */
  defaultDefinition: z.string(),
  /** 認証済みで選択できるモデル。候補が無ければ空 */
  models: z.array(TitleSummaryModelChoiceSchema),
  /** 保存済みモデルが現在の候補に無い。true の間は要約だけを飛ばし、会話の送信は止めない */
  modelAvailable: z.boolean(),
});
export type TitleSummarySettingsResponse = z.infer<typeof TitleSummarySettingsResponseSchema>;
/**
 * 4 項目をまとめて保存する。省略した項目は保存値を保つ (Off から On への切替でモデルを消さない)。
 * thinkingLevel は null で未指定へ戻せる。モデルを変えて Effort を省略した場合、新しいモデルが
 * 対応しない保存値は未指定へ戻す。
 */
export const UpdateTitleSummaryBodySchema = z.object({
  enabled: z.boolean(),
  model: z.string().nullable().optional(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  definition: z.string().optional(),
});
export type UpdateTitleSummaryBody = z.infer<typeof UpdateTitleSummaryBodySchema>;

// --- Git のグローバル identity (設定 → Git) ---
/**
 * GET /api/settings/git の応答。未設定は両方 null と configured: false で表し、
 * 片方だけ保存された状態は作らない (片方だけの PUT は 400)。
 */
export const GitSettingsResponseSchema = z.object({
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  /** 両方が保存されているか。設定画面の「Git identity 未設定」バッジの根拠 */
  configured: z.boolean(),
});
export type GitSettingsResponse = z.infer<typeof GitSettingsResponseSchema>;
/** 変更系の応答。`applied` は「DB 保存済みで、サンドボックスへは次の bash から反映」の意 */
export const GitSettingsMutationResponseSchema = GitSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type GitSettingsMutationResponse = z.infer<typeof GitSettingsMutationResponseSchema>;
/** 両方必須。片方だけ・空・制御文字・`<` `>`・形状違反は server/src/git-identity.ts が 400 にする */
export const UpdateGitSettingsBodySchema = z.object({
  userName: z.string(),
  userEmail: z.string(),
});
export type UpdateGitSettingsBody = z.infer<typeof UpdateGitSettingsBodySchema>;
/**
 * GET /api/runtime/in-use。設定 → ランタイム の環境タブが「いま何が使われるか」を 1 回で読む。
 * カタログ・APIキー・OAuth トークン・暗号文は載せない（表示専用。詳細は docs/api.md）。
 */
export const RuntimeInUseTitleSchema = z.object({
  enabled: z.boolean(),
  /** 保存済みの要約モデル。無効にしても消さない既存仕様のまま返す */
  model: z.string().nullable(),
  /** 保存値。未指定は null で、実効値とは食い違い得る */
  thinkingLevel: ThinkingLevelSchema.nullable(),
  effectiveThinkingLevel: ThinkingLevelSchema.nullable(),
  /** 保存済みモデルが現在の候補にあるか */
  modelAvailable: z.boolean(),
});
export type RuntimeInUseTitle = z.infer<typeof RuntimeInUseTitleSchema>;
export const RuntimeInUseContentSchema = z.object({
  /** 設定行がある（キーの保存とは別） */
  configured: z.boolean(),
  /** 画像・音声・BGM 共通の実行時トグル */
  enabled: z.boolean(),
  /** キーを復号でき、生成ツールへ渡せる */
  keyAvailable: z.boolean(),
  imageModel: z.string().nullable(),
  speechModel: z.string().nullable(),
  /** 空文字（指定なし）は null へ正規化する。表示側で値と取り違えないようにする */
  speechVoice: z.string().nullable(),
  bgmModel: z.string().nullable(),
});
export type RuntimeInUseContent = z.infer<typeof RuntimeInUseContentSchema>;
export const RuntimeInUseWebSearchSchema = z.object({
  enabled: z.boolean(),
  provider: WebSearchProviderIdSchema,
  /** provider の外部送信先。画面で隠さない */
  host: z.string(),
});
export type RuntimeInUseWebSearch = z.infer<typeof RuntimeInUseWebSearchSchema>;
export const RuntimeInUseCloudflareSchema = z.object({
  configured: z.boolean(),
  /** master key が使えるか（false は登録・復号が 503） */
  available: z.boolean(),
  /** GET /api/settings/cloudflare と同じ公開情報 */
  accountId: z.string().nullable(),
});
export type RuntimeInUseCloudflare = z.infer<typeof RuntimeInUseCloudflareSchema>;
export const RuntimeInUseResponseSchema = z.object({
  title: RuntimeInUseTitleSchema,
  content: RuntimeInUseContentSchema,
  webSearch: RuntimeInUseWebSearchSchema,
  cloudflare: RuntimeInUseCloudflareSchema,
});
export type RuntimeInUseResponse = z.infer<typeof RuntimeInUseResponseSchema>;

// --- バックアップ (定義の書き出し / 復元 / 全削除) ---
/**
 * バックアップ ZIP の形式。`app` / `schema` が違うものは移行せず 400 にする (docs/backup.md)。
 * 形式の読み書きと検証は `server/src/backup/format.ts` が持ち、ここは境界の型だけを定義する。
 */
export const BACKUP_APP = "u7agent";
export const BACKUP_SCHEMA_VERSION = 1;
/** JSON 3 本 (manifest / prompts / agents) の合計上限。ZIP 全体の上限とは別に持つ */
export const BACKUP_JSON_MAX_BYTES = 16 * 1024 * 1024;
/** バックアップ ZIP のトップレベルエントリ名。manifest.targets と実エントリを完全一致させる */
export const BACKUP_MANIFEST_ENTRY = "manifest.json";
export const BACKUP_PROMPTS_FILE_ENTRY = "prompts.json";
export const BACKUP_AGENTS_FILE_ENTRY = "agents.json";
export const BACKUP_SKILLS_ENTRY = "skills.zip";
/** 復元で受ける対象。manifest の `targets` と query の `targets` はこの語彙だけを使う */
export const BackupTargetSchema = z.enum(["prompts", "agents", "skills"]);
export type BackupTarget = z.infer<typeof BackupTargetSchema>;
export const BackupManifestSchema = z
  .object({
    app: z.string(),
    schema: z.number().int(),
    /** 書き出した時刻 (ISO 8601)。同一判定には使わない (docs/backup.md) */
    exportedAt: z.string(),
    targets: z.array(BackupTargetSchema),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
/** 自作の定型プロンプト 1 件。並びが表示順で、ID はそのまま復元先の主キーになる */
export const BackupPromptSchema = z.object({ id: z.string(), label: z.string(), prompt: z.string() }).strict();
export type BackupPrompt = z.infer<typeof BackupPromptSchema>;
/**
 * ユーザー定義エージェント 1 件。API の `AgentDef` と違い、解決済みの `prompts` ではなく
 * `promptIds` を持つ (本文は `prompts.json` に 1 回だけ書く)。
 */
export const BackupAgentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    icon: z.string().optional(),
    model: ModelRefSchema.optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    commonSkillNames: z.array(z.string()).optional(),
    builtinSkillNames: z.array(z.string()).optional(),
    allowNaturalInvocationBuiltin: z.boolean().optional(),
    allowNaturalInvocationFile: z.boolean().optional(),
    toolNames: z.array(z.string()).optional(),
    promptIds: z.array(z.string()).optional(),
  })
  .strict();
export type BackupAgent = z.infer<typeof BackupAgentSchema>;
export const BackupPromptsFileSchema = z.object({ prompts: z.array(BackupPromptSchema) }).strict();
export type BackupPromptsFile = z.infer<typeof BackupPromptsFileSchema>;
export const BackupAgentsFileSchema = z.object({ agents: z.array(BackupAgentSchema) }).strict();
export type BackupAgentsFile = z.infer<typeof BackupAgentsFileSchema>;
/** 警告とブロッカーのコード。日本語の文言は `client/src/lib/backup.ts` が持つ */
export const BackupWarningSchema = z.object({ code: z.string(), name: z.string().optional() });
export type BackupWarning = z.infer<typeof BackupWarningSchema>;
export const BackupBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  names: z.array(z.string()),
});
export type BackupBlocker = z.infer<typeof BackupBlockerSchema>;
export const BackupDiffStatusSchema = z.enum([
  "added",
  "updated",
  "identical",
  "removed",
  "reordered",
  /** 取り込めない行 (スキルの invalid など)。件数には数えず、ブロッカーとして扱う */
  "blocked",
]);
export type BackupDiffStatus = z.infer<typeof BackupDiffStatusSchema>;
export const BackupDiffItemSchema = z.object({ id: z.string(), name: z.string(), status: BackupDiffStatusSchema });
export type BackupDiffItem = z.infer<typeof BackupDiffItemSchema>;
/** 差分の件数。`reordered` は内容が同一で並びだけが変わる行を数える */
export const BackupDiffCountsSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  identical: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  reordered: z.number().int().nonnegative(),
});
export type BackupDiffCounts = z.infer<typeof BackupDiffCountsSchema>;
export const BackupTargetPlanSchema = z.object({
  target: BackupTargetSchema,
  counts: BackupDiffCountsSchema,
  /** プレビューに出す行。上限で打ち切ったときは `truncated` が true */
  items: z.array(BackupDiffItemSchema),
  truncated: z.boolean(),
  /** 適用後の件数 */
  total: z.number().int().nonnegative(),
  warnings: z.array(BackupWarningSchema),
  blocker: BackupBlockerSchema.nullable(),
});
export type BackupTargetPlan = z.infer<typeof BackupTargetPlanSchema>;
export const BackupRestorePlanSchema = z.object({
  manifest: BackupManifestSchema,
  /** 実際に置き換える対象 (query で絞った結果) */
  selected: z.array(BackupTargetSchema),
  plans: z.array(BackupTargetPlanSchema),
  /** 選択した全対象に差分が無く、ブロッカーも無い */
  changed: z.boolean(),
  blocked: z.boolean(),
  /** 変更しないもの (文言のコード。日本語はクライアントが持つ) */
  kept: z.array(z.string()),
});
export type BackupRestorePlan = z.infer<typeof BackupRestorePlanSchema>;
export const BackupAppliedSchema = z.object({
  target: BackupTargetSchema,
  counts: BackupDiffCountsSchema,
});
export type BackupApplied = z.infer<typeof BackupAppliedSchema>;
export const BackupFailureSchema = z.object({ target: BackupTargetSchema, message: z.string() });
export type BackupFailure = z.infer<typeof BackupFailureSchema>;
/** apply の結果。DB は 1 トランザクション、スキルは別なので `complete: false` の partial を取り得る */
export const BackupRestoreResultSchema = z.object({
  complete: z.boolean(),
  plan: BackupRestorePlanSchema,
  applied: z.array(BackupAppliedSchema),
  failed: z.array(BackupFailureSchema),
});
export type BackupRestoreResult = z.infer<typeof BackupRestoreResultSchema>;
export const BackupExportTargetSchema = z.object({
  target: BackupTargetSchema,
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** スキルだけが持つ。false のときは `reason` を添える */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type BackupExportTarget = z.infer<typeof BackupExportTargetSchema>;
/** GET /api/backup/export/check。dry-run はせず、復元可否は restore plan で確かめる */
export const BackupExportCheckSchema = z.object({
  targets: z.array(BackupTargetSchema),
  entries: z.array(BackupExportTargetSchema),
  bytes: z.number().int().nonnegative(),
  fileName: z.string(),
});
export type BackupExportCheck = z.infer<typeof BackupExportCheckSchema>;
export const BackupResetResultSchema = z.object({
  complete: z.boolean(),
  agents: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  failed: z.array(BackupFailureSchema),
});
export type BackupResetResult = z.infer<typeof BackupResetResultSchema>;

export * from "./schema/common";
export * from "./schema/messages";
export * from "./schema/spaces";
export * from "./schema/files";
export * from "./schema/skills";
export * from "./schema/secrets";
export * from "./schema/catalog";
export * from "./schema/content";
export * from "./schema/sharing";
