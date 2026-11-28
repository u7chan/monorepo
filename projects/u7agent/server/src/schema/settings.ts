/** 設定 (通知 / アーカイブ / モデル / OAuth / Cloudflare / Web 検索 / タイトル要約 / Git) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { WEB_SEARCH_PROVIDER_IDS } from "../web-search-providers";
import { PROVIDER_FAILURE_CODES } from "../provider-failure";
import { z } from "zod";
import { PROVIDER_API_KEY_MAX_LENGTH, PROVIDER_API_KEY_MIN_LENGTH, ThinkingLevelSchema } from "./common";

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
/** OAuth サインインの方式選択。進行中の select の選択肢 id だけを受け付ける */
export const SubmitOAuthLoginSelectBodySchema = z.object({
  id: z.string().trim().min(1).max(OAUTH_LOGIN_SELECT_ID_MAX_LENGTH),
});
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
 * GET / PUT / DELETE `/api/settings/voice-input`。設定 → 音声入力の OpenAI Platform のキーを持つ。
 * 行が無い = キー未設定で、有効 / 無効のトグルは持たない（キーが使えるときだけマイクを出す）。
 * v1 は行がキーだけなので `configured`（行の有無）と `keyStored`（暗号文の有無）は同じ値になる。
 * 両者を分けて返すのは、保存はあるが復号できない状態を「未設定」と同じ見た目にしないため。
 */
export const VoiceInputSettingsResponseSchema = z.object({
  configured: z.boolean(),
  keyStored: z.boolean(),
  /** 復号でき、録音の開始に使える */
  keyAvailable: z.boolean(),
  /** 復号を評価済みか。false は「まだ確認できていない」で、失敗とは区別する */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未保存のときは null */
  keyErrorMessage: z.string().nullable(),
  /** 固定モデル。画面は読取専用で出し、client からは送らない */
  model: z.string(),
  /** マスカーを持てる起動（pi あり）か。false はキーの登録・置換・疎通確認が 503 */
  runtimeAvailable: z.boolean(),
});
export type VoiceInputSettingsResponse = z.infer<typeof VoiceInputSettingsResponseSchema>;
/** 変更系（PUT / DELETE）の応答。即時反映なので `applied` だけを返す */
export const VoiceInputMutationResponseSchema = VoiceInputSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type VoiceInputMutationResponse = z.infer<typeof VoiceInputMutationResponseSchema>;
/**
 * キーの登録・上書き。長さは provider_credentials / 画像と同じで、印字可能 ASCII に限る。
 * 改行や制御文字を Authorization ヘッダーへ渡さないための境界で、形式の変更で保存できなくしない。
 */
export const VOICE_INPUT_API_KEY_MIN_LENGTH = 8;
export const VOICE_INPUT_API_KEY_MAX_LENGTH = 2048;
export const UpdateVoiceInputKeyBodySchema = z.object({
  apiKey: z
    .string()
    .min(VOICE_INPUT_API_KEY_MIN_LENGTH)
    .max(VOICE_INPUT_API_KEY_MAX_LENGTH)
    .regex(/^[\x20-\x7e]+$/),
});
export type UpdateVoiceInputKeyBody = z.infer<typeof UpdateVoiceInputKeyBodySchema>;
/**
 * POST `/api/settings/voice-input/test`。短命キーの発行だけを確かめ、**上流の確認失敗だけ**を
 * 200 の `ok: false` で返す（未登録 / キー利用不可 / DB 障害は HTTP エラー）。
 * `code` は provider 呼び出しの共通分類で、`message` は音声入力向けの固定文言。
 */
export const VoiceInputTestFailureSchema = z.object({
  ok: z.literal(false),
  code: z.enum(PROVIDER_FAILURE_CODES),
  message: z.string(),
});
export type VoiceInputTestFailure = z.infer<typeof VoiceInputTestFailureSchema>;
export const VoiceInputTestResponseSchema = z.union([
  z.object({ ok: z.literal(true), model: z.string() }),
  VoiceInputTestFailureSchema,
]);
export type VoiceInputTestResponse = z.infer<typeof VoiceInputTestResponseSchema>;
/**
 * POST `/api/voice-input/session` の失敗応答。成功は SDP そのもの（200 `application/sdp` +
 * `Cache-Control: no-store`）で、失敗だけ JSON になる。上流失敗（502）だけ `code` を持つ。
 */
export const VoiceInputSessionFailureSchema = z.object({
  error: z.string(),
  code: z.enum(PROVIDER_FAILURE_CODES).optional(),
});
export type VoiceInputSessionFailure = z.infer<typeof VoiceInputSessionFailureSchema>;
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

// Git のグローバル identity (設定 → Git)
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
/** 一時共有の起動基盤 (cloudflared) がこの BFF で使えるか。GUI の入口は使えない行を出さない */
export const RuntimeInUseTunnelSchema = z.object({
  available: z.boolean(),
  /** 利用できない理由の文言。使えるときは null */
  unavailableReason: z.string().nullable(),
});
export type RuntimeInUseTunnel = z.infer<typeof RuntimeInUseTunnelSchema>;
export const RuntimeInUseResponseSchema = z.object({
  title: RuntimeInUseTitleSchema,
  content: RuntimeInUseContentSchema,
  webSearch: RuntimeInUseWebSearchSchema,
  cloudflare: RuntimeInUseCloudflareSchema,
  tunnel: RuntimeInUseTunnelSchema,
});
export type RuntimeInUseResponse = z.infer<typeof RuntimeInUseResponseSchema>;

// バックアップ (定義の書き出し / 復元 / 全削除)
