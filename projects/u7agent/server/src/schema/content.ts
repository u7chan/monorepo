/** コンテンツ生成 (画像 / 音声 / BGM / 試行 / 価格表) の DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import {
  CONTENT_TRIAL_ARTIFACT_STATES,
  CONTENT_TRIAL_FAILURE_CODES,
  CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH,
  CONTENT_TRIAL_KINDS,
  CONTENT_TRIAL_PROMPT_MAX_LENGTH,
  CONTENT_TRIAL_STATES,
  COST_SIDES,
  COST_UNITS,
  TRIAL_ARTIFACT_FORMATS,
} from "../content-vocabulary";
import { z } from "zod";
import { PROVIDER_API_KEY_MAX_LENGTH, PROVIDER_API_KEY_MIN_LENGTH } from "./common";

/**
 * 画像生成のパラメータ値。**6 キー固定の strict object** で、`seed` だけが整数、他は文字列。
 * `z.record` で受けると `"42"` と `42` で正規化キーが変わるため、キーを明示する。
 */
export const ImageParameterValuesSchema = z
  .object({
    aspect_ratio: z.string().min(1).optional(),
    resolution: z.string().min(1).optional(),
    quality: z.string().min(1).optional(),
    output_format: z.string().min(1).optional(),
    background: z.string().min(1).optional(),
    /** 0 以上 2^31-1 以下の整数（`server/src/images.ts` の宣言検証と同じ上限） */
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
  })
  .strict();
export type ImageParameterValues = z.infer<typeof ImageParameterValuesSchema>;
/**
 * 生成パラメータの宣言 1 件。`boolean` は「そのパラメータを受け付ける」の意味で、値は送らない。
 * 宣言の正規化（未知キーの除去・`output_format` の積）は `server/src/images.ts` が行う。
 */
export const ImageParameterDescriptorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), values: z.array(z.string()) }),
  z.object({ type: z.literal("range"), min: z.number(), max: z.number() }),
  z.object({ type: z.literal("boolean") }),
]);
/** 宣言の集まり。名前は許可リストの 6 つに固定し、読めなかった項目は載せない */
export const ImageParameterDeclarationsSchema = z
  .object({
    aspect_ratio: ImageParameterDescriptorSchema.optional(),
    resolution: ImageParameterDescriptorSchema.optional(),
    quality: ImageParameterDescriptorSchema.optional(),
    output_format: ImageParameterDescriptorSchema.optional(),
    background: ImageParameterDescriptorSchema.optional(),
    seed: ImageParameterDescriptorSchema.optional(),
  })
  .strict();
/** 価格 1 件。`billable`（上流の語彙）は DTO へ持ち込まない。`variant` は加算オプションを含む */
export const ModelPriceSchema = z.object({
  unit: z.enum(COST_UNITS),
  /** 入力側 / 出力側。画像は出力だけ、音声は指標になる側をそのまま返す */
  side: z.enum(COST_SIDES),
  /** 無ければ ""（基本単価）。画面は空の行を基本として扱い、無いときだけ範囲を出す */
  variant: z.string(),
  costUsd: z.number(),
  /** 契約は USD 固定（上流が通貨を宣言しないためマスタが付与する） */
  currency: z.literal("USD"),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
/** 画像だけを扱う既存コードの別名。中身は `ModelPrice` と同じ（音声と共有する） */
export type ImageModelPrice = ModelPrice;
/** 画像生成のカタログ 1 件。provider は将来の追加に備えて載せ、値は開放しない */
export const ImageModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  /**
   * live が宣言する生成パラメータ。宣言が無い / 読めないモデル（SDK 同梱・古いキャッシュ）は載せない
   * （＝不明）。画面はこれだけを見て選択肢を描き、サーバーは送信本文と生成前検証に使う。
   */
  parameters: ImageParameterDeclarationsSchema.optional(),
  /** 出力側の単価。不明（マスタに無い・読めない）は空配列で、`0` とは区別する */
  prices: z.array(ModelPriceSchema),
  /** マスタの人手判断。false でも一覧（`image.models`）からは落とさず、画面の選択肢から外すだけ */
  visible: z.boolean(),
  /** マスタの人手メモ。無ければ null */
  note: z.string().nullable(),
});
export type ImageModel = z.infer<typeof ImageModelSchema>;
/** カタログの出どころ。live 以外は取得に失敗しており、前回の一覧か SDK 同梱を表示している */
export const ImageCatalogSourceSchema = z.enum(["live", "stored", "sdk"]);
export type ImageCatalogSource = z.infer<typeof ImageCatalogSourceSchema>;
/**
 * 音声カタログ 1 件。`voices` は live が宣言する話者で、宣言が無いとき（Fish Audio / Seed Audio など）は
 * 載せない（UI は自由記述を許し、サーバーも生成前ガードをしない）。
 */
export const SpeechModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  voices: z.array(z.string()).optional(),
  /** 入力 / 出力の単価。不明（マスタに無い・読めない）は空配列で、`0` とは区別する */
  prices: z.array(ModelPriceSchema),
  /** マスタの人手判断。false でも一覧からは落とさず、画面の選択肢から外すだけ */
  visible: z.boolean(),
  /** マスタの人手メモ。無ければ null */
  note: z.string().nullable(),
});
export type SpeechModel = z.infer<typeof SpeechModelSchema>;
/**
 * 音声カタログの出どころ。live 以外は取得に失敗しており、前回の一覧か同梱の既定 1 件を表示している。
 * 画像の `sdk` と同じ位置付けだが、同梱が SDK ではなく 1 件だけなので別名にする（docs/speech-generation.md）。
 */
export const SpeechCatalogSourceSchema = z.enum(["live", "stored", "default"]);
export type SpeechCatalogSource = z.infer<typeof SpeechCatalogSourceSchema>;
/**
 * 画像の生成元。値の正は `server/src/images.ts` の `IMAGE_GENERATION_PROVIDERS`。
 * provider 間の自動フォールバックはなく、設定で明示的に選んだ片方だけを使う。
 */
export const ImageGenerationProviderSchema = z.enum(["openrouter", "codex"]);
export type ImageGenerationProvider = z.infer<typeof ImageGenerationProviderSchema>;
/** 画像の認証状態。値を伏せたまま「使えるか / 何を入れれば使えるか」だけを返す */
export const ContentImageAuthSchema = z.object({
  state: z.enum(["configured", "missing", "expired"]),
  kind: z.enum(["api_key", "oauth"]).nullable(),
});
export type ContentImageAuth = z.infer<typeof ContentImageAuthSchema>;
/**
 * GET /api/settings/content の `image`。`configured: false` のとき `model` は null（行が無い = 未設定）。
 * 音声など別の生成物を足すときは、この兄弟として項目を増やす（`image` の形は変えない）。
 */
export const ContentImageSettingsSchema = z.object({
  model: z.string().nullable(),
  /** 画像の生成元。既定は openrouter（行が無いときも openrouter） */
  provider: ImageGenerationProviderSchema,
  /** 選択中の provider が使える認証を持っているか。値そのものは返さない */
  auth: ContentImageAuthSchema,
  /** 選択肢。Codex は画像モデルを選ばないため空配列（ルーティングモデルを画像モデルとして見せない） */
  models: z.array(ImageModelSchema),
  /** 上の models の出どころ。live 以外は取得に失敗した状態 */
  catalogSource: ImageCatalogSourceSchema,
  /** live を最後に取得できた時刻 (epoch ms)。SDK 同梱を表示しているときは null */
  fetchedAt: z.number().nullable(),
  /**
   * 保存済みの生成パラメータの既定（bare なモデル id → 値）。各エントリはそのモデルの宣言で
   * 絞り、宣言が読めないモデルのエントリは空になる（画面は空のエントリに欄を出さない）。
   */
  parametersByModel: z.record(z.string(), ImageParameterValuesSchema),
});
export type ContentImageSettings = z.infer<typeof ContentImageSettingsSchema>;
/**
 * GET /api/settings/content の `speech`。行があるときは `model` / `voice` を返し、`NULL` の既存列は
 * 既定モデルと「そのモデルが宣言する先頭ボイス」へフォールバックして返す（UI に「（未設定）」を出さない）。
 * `configured: false` のときは `model` が null で、`voice` は空文字になる。
 */
export const ContentSpeechSettingsSchema = z.object({
  model: z.string().nullable(),
  /** 再開時に送る話者。空文字は「指定なし」（宣言が無いモデル）で、本文から `voice` を落とす */
  voice: z.string(),
  /** 選択肢。live カタログ（取得できないときは前回の一覧 / 同梱の既定 1 件）。話者の宣言を含む */
  models: z.array(SpeechModelSchema),
  /** 上の models の出どころ。live 以外は取得に失敗した状態 */
  catalogSource: SpeechCatalogSourceSchema,
  /** live を最後に取得できた時刻 (epoch ms)。同梱の既定を表示しているときは null */
  fetchedAt: z.number().nullable(),
});
export type ContentSpeechSettings = z.infer<typeof ContentSpeechSettingsSchema>;
export const ContentBgmSettingsSchema = z.object({
  model: z.string().nullable(),
  format: z.literal("mp3"),
  expectedDurationSeconds: z.literal(30),
});
export type ContentBgmSettings = z.infer<typeof ContentBgmSettingsSchema>;
/**
 * GET /api/settings/content。`configured: false` のとき provider は null（行が無い = 未設定）。
 * APIキーは返さない。`enabled` はアプリ全体の有効 / 無効で、行が無いときは既定 (ON) を返す
 * （`configured` が false ならツールはどちらにせよ公開されない）。
 */
export const ContentSettingsResponseSchema = z.object({
  configured: z.boolean(),
  provider: z.string().nullable(),
  /** キーの暗号文がある (復号できるかは keyAvailable) */
  keyStored: z.boolean(),
  /** キーを復号でき、生成ツールへ渡せる。「設定行がある」「enabled」「keyAvailable」の積が公開ゲート */
  keyAvailable: z.boolean(),
  /** 復号を評価済みか。false は未評価で、失敗とは区別する */
  keyEvaluated: z.boolean(),
  /** 未評価 / 復号失敗の固定文言。使えるときと未設定のときは null */
  keyErrorMessage: z.string().nullable(),
  /**
   * コンテンツ生成のAPIキーの世代。キーの保存 / 上書き / 削除で進み、試行の証拠を
   * 「現在のキーでの実績」に限るために使う（docs/api-settings.md）。
   */
  keyEpoch: z.number(),
  /** 画像・音声・BGM の 3 ツール共通の実行時トグル。行が無ければ true（既定） */
  enabled: z.boolean(),
  /** 画面が同じ文言を出すため、ツールが OFF の間に返す固定文言も応答に載せる */
  disabledMessage: z.string(),
  /** SDK ランタイムの初期化に成功したか。false のときキー登録は 503（model-settings と同じ） */
  runtimeAvailable: z.boolean(),
  image: ContentImageSettingsSchema,
  speech: ContentSpeechSettingsSchema,
  /**
   * コストマスタの接続先と最後に取得できた時刻。画像・音声で共有するタブ非依存の設定。
   * 未設定・OFF でも null にせず、`enabled: false` / `url: null` を返す
   * （`prices` は全件空、`visible` は全件 true に投影する）。
   */
  cost: z.object({
    enabled: z.boolean(),
    url: z.string().nullable(),
    /** 価格スナップショットを最後に取得できた時刻 (epoch ms)。未取得は null */
    fetchedAt: z.number().nullable(),
    /** マスタの世代。未取得・契約外で読めないときは null */
    version: z.number().nullable(),
  }),
  bgm: ContentBgmSettingsSchema,
});
export type ContentSettingsResponse = z.infer<typeof ContentSettingsResponseSchema>;
/** 変更系（PUT / DELETE）の応答。SDK への反映を持たないため `applied` だけを返す */
export const ContentMutationResponseSchema = ContentSettingsResponseSchema.extend({
  state: z.literal("applied"),
});
export type ContentMutationResponse = z.infer<typeof ContentMutationResponseSchema>;
/**
 * 試行ジョブの状態。終端（`succeeded` / `failed` / `canceled` / `interrupted`）は不変で、
 * `running` からしか遷移しない。値の正は `server/src/content-trials.ts`。
 */
export const ContentTrialStateSchema = z.enum(CONTENT_TRIAL_STATES);
export type ContentTrialStateValue = z.infer<typeof ContentTrialStateSchema>;
/** 試行の種別。画像 / 音声 / BGM は同じジョブの仕組みと履歴を使う */
export const ContentTrialKindSchema = z.enum(CONTENT_TRIAL_KINDS);
export type ContentTrialKindValue = z.infer<typeof ContentTrialKindSchema>;
/** 成果物の状態。`none` は保存していない行（段階 1 の行と、保存に失敗した成功）で `stored` は保存済み */
export const ContentTrialArtifactStateSchema = z.enum(CONTENT_TRIAL_ARTIFACT_STATES);
export type ContentTrialArtifactStateValue = z.infer<typeof ContentTrialArtifactStateSchema>;
/** 保存できる成果物の形式。値の正は `server/src/content-trial-artifacts.ts` */
export const ContentTrialArtifactFormatSchema = z.enum(TRIAL_ARTIFACT_FORMATS);
export type ContentTrialArtifactFormatValue = z.infer<typeof ContentTrialArtifactFormatSchema>;
/**
 * 保存済みの成果物のメタデータ。実体の置き場（パス）は応答に載せず、配信は trial id だけで引く。
 * 寸法は画像だけの値で、読めなかったときは null。
 */
export const ContentTrialArtifactSchema = z.object({
  format: ContentTrialArtifactFormatSchema,
  bytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
export type ContentTrialArtifact = z.infer<typeof ContentTrialArtifactSchema>;
/**
 * 試行 1 件の要約。`prompt` と `instructions` は長いため一覧には載せず、選んだ行の全文は
 * `GET /api/settings/content/trials/:id` で取る（`promptPreview` は行に出す抜粋）。
 * `recorded: false` は「終端を DB へ記録できず、メモリの状態を返している」を表し、
 * この間の行は `running` のまま保存されている（docs/api-settings.md）。APIキーは載らない。
 * 音声の `voice` / `speed` は送信時のスナップショットで、画像と BGM の行は null。
 * `parameters` も送信時のスナップショットで、未指定（未指定のまま生成した行を含む）は null。
 */
export const ContentTrialSummarySchema = z.object({
  id: z.string(),
  kind: ContentTrialKindSchema,
  /** 送信時のモデル（画像は `provider/id`、音声はカタログの id）。現在の保存値とは混ぜない */
  model: z.string(),
  /** 本文の抜粋。全文は `ContentTrialSchema.prompt` にだけ載る */
  promptPreview: z.string(),
  voice: z.string().nullable(),
  speed: z.number().nullable(),
  /**
   * 画像の生成パラメータ（許可リストのキーだけ）。未指定は null で、[もう一度生成] は全文の取得を待たずに
   * この値を使える（`ContentTrialSchema` も要約を extends するため全文にも載る）。
   */
  parameters: ImageParameterValuesSchema.nullable(),
  state: ContentTrialStateSchema,
  keyEpoch: z.number(),
  artifactState: ContentTrialArtifactStateSchema,
  /** 保存済みのときだけ非 null */
  artifact: ContentTrialArtifactSchema.nullable(),
  /** 生成が成功して課金されたか（保存に失敗した成功も true） */
  charged: z.boolean(),
  failureCode: z.enum(CONTENT_TRIAL_FAILURE_CODES).nullable(),
  failureMessage: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  recorded: z.boolean(),
});
export type ContentTrialSummary = z.infer<typeof ContentTrialSummarySchema>;
/** 試行 1 件の全文。要約に本文と演技指示を足した形（単体取得・開始・中断の応答） */
export const ContentTrialSchema = ContentTrialSummarySchema.extend({
  prompt: z.string(),
  instructions: z.string().nullable(),
});
export type ContentTrial = z.infer<typeof ContentTrialSchema>;
/** POST /api/settings/content/trials の 202（開始）と 200（同じ入力の再利用）と、GET / cancel の 200 */
export const ContentTrialResponseSchema = z.object({ trial: ContentTrialSchema });
export type ContentTrialResponse = z.infer<typeof ContentTrialResponseSchema>;
/**
 * 開始の応答。`reused: true` は「同じ入力の保存済み成功を返した」を表し、provider を呼ばず課金しない
 * （status は 200、開始したときは 202）。
 */
export const ContentTrialStartResponseSchema = z.object({ trial: ContentTrialSchema, reused: z.boolean() });
export type ContentTrialStartResponse = z.infer<typeof ContentTrialStartResponseSchema>;
/**
 * GET /api/settings/content/trials。`keyEpoch` は現在の世代で、各行の `keyEpoch` と比べて
 * 旧キーの実績を証拠から外す。並びは新しい順（時間ベースの自動削除はしない）。
 * `artifactUsage` は `succeeded` かつ保存済みの件数とバイト数の合計で、画面の保存容量に出す。
 * `items` は要約で、`nextBefore`（不透明なカーソル）と `hasMore` で続きを取る。
 */
export const ContentTrialArtifactUsageSchema = z.object({ count: z.number(), bytes: z.number() });
export type ContentTrialArtifactUsageValue = z.infer<typeof ContentTrialArtifactUsageSchema>;
/**
 * 保存容量の警告。しきい値は server の定数（`server/src/content-trial-artifacts.ts`）で、
 * `artifactUsage.bytes` がこれを**超えた**とき `warning: true`。
 */
export const ContentTrialArtifactWarningSchema = z.object({ thresholdBytes: z.number(), warning: z.boolean() });
export type ContentTrialArtifactWarningValue = z.infer<typeof ContentTrialArtifactWarningSchema>;
export const ContentTrialListResponseSchema = z.object({
  items: z.array(ContentTrialSummarySchema),
  keyEpoch: z.number(),
  artifactUsage: ContentTrialArtifactUsageSchema,
  /** server は常に返すが、追加フィールドなので省略可（旧い client の応答組み立てと互換） */
  artifactWarning: ContentTrialArtifactWarningSchema.optional(),
  /** 続きの位置。`hasMore` が false のときは null */
  nextBefore: z.string().nullable(),
  hasMore: z.boolean(),
});
export type ContentTrialListResponse = z.infer<typeof ContentTrialListResponseSchema>;
/** 削除の応答。個別削除は 0 / 1、すべて削除は消した件数（`running` は対象にしない） */
export const ContentTrialDeleteResponseSchema = z.object({ removed: z.number() });
export type ContentTrialDeleteResponse = z.infer<typeof ContentTrialDeleteResponseSchema>;
/**
 * POST /api/settings/content/trials。試行は画面の値で実行し、設定には反映しない。
 * 種別ごとに同時 1 本で、実行中は 409。`voice` / `instructions` / `speed` は音声のときだけ受け付け、
 * 音声の試行の入力スナップショットとして履歴に残る（同じ入力の再利用もこの 3 つで照合する）。
 * `parameters` は画像のときだけ受け付け、宣言との突き合わせは課金前に行う（同じ入力の再利用もこの値で照合する）。
 * BGM の `model` は固定で、それ以外は 400（設定画面は固定値を送る）。
 */
export const CreateContentTrialBodySchema = z.object({
  kind: ContentTrialKindSchema,
  /** 画像は `provider/id`、音声はカタログのモデル id、BGM は固定のモデル id だけを受け付ける */
  model: z.string().min(1),
  prompt: z.string().min(1).max(CONTENT_TRIAL_PROMPT_MAX_LENGTH),
  /** 保存済み結果を無視して新しい試行を開始する。結果カードの「別のテイク」だけが true を送る */
  force: z.boolean().optional(),
  /** 空文字は「指定なし」（宣言が無いモデル）で、本文から `voice` を落とす */
  voice: z.string().max(200).optional(),
  instructions: z.string().max(CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH).optional(),
  speed: z.number().optional(),
  /** 画像の生成パラメータ。未指定は送らず、モデルが宣言した範囲だけを通す */
  parameters: ImageParameterValuesSchema.optional(),
});
export type CreateContentTrialBody = z.infer<typeof CreateContentTrialBodySchema>;
/**
 * POST /api/settings/content/catalog/refresh。取得できなくても常に 200 で、その時点の
 * `ContentSettingsResponse` と同じ形を返す。失敗は系統ごとに `errors` へ分け、1 系統の失敗で
 * 他の結果を捨てない（一覧も前回値のまま返す）。
 */
export const ContentCatalogRefreshErrorsSchema = z.object({
  image: z.string().optional(),
  speech: z.string().optional(),
  cost: z.string().optional(),
});
export type ContentCatalogRefreshErrors = z.infer<typeof ContentCatalogRefreshErrorsSchema>;
export const ContentCatalogRefreshResponseSchema = ContentSettingsResponseSchema.extend({
  errors: ContentCatalogRefreshErrorsSchema,
});
export type ContentCatalogRefreshResponse = z.infer<typeof ContentCatalogRefreshResponseSchema>;
/**
 * PUT /api/settings/content/cost-url。コストマスタの接続先とトグルを 1 回で保存する。
 * `enabled: true` は URL 必須で、`enabled: false` + 空 URL は行の削除（未設定）として扱う。
 */
export const UpdateContentCostBodySchema = z.object({
  enabled: z.boolean(),
  url: z.string().max(2048),
});
export type UpdateContentCostBody = z.infer<typeof UpdateContentCostBodySchema>;
/** 変更系の失敗応答（何も変わっていない）。400 は error のみ */
export const ContentMutationErrorSchema = z.object({
  error: z.string(),
  state: z.literal("not_stored"),
});
export type ContentMutationError = z.infer<typeof ContentMutationErrorSchema>;
/**
 * provider / model の変更。キーは保持したまま差し替える（行が無ければ 400）。
 * `parameters` は保存する生成パラメータの既定で、省略 = 据え置き / `{}` = そのモデルの既定を削除 /
 * 値あり = 置き換え。値はモデルの宣言と突き合わせ、宣言外は 400 にする（保存しない）。
 */
export const UpdateContentImageBodySchema = z.object({
  provider: z.string(),
  model: z.string(),
  parameters: ImageParameterValuesSchema.optional(),
});
export type UpdateContentImageBody = z.infer<typeof UpdateContentImageBodySchema>;
/**
 * PUT /api/settings/content/image/provider。画像の生成元の切り替えで、キーもモデルも伴わない。
 * 未設定の行でも受け付ける（Codex は APIキーを使わない）。
 */
export const UpdateContentImageProviderBodySchema = z.object({
  provider: ImageGenerationProviderSchema,
});
export type UpdateContentImageProviderBody = z.infer<typeof UpdateContentImageProviderBodySchema>;
/**
 * 音声モデル / 話者の変更。キーと provider は保持したまま差し替える（行が無ければ 400）。
 * `voice` の空文字は「指定なし」で、宣言が無いモデルへの自由記述もここを通す（照合はサービス側）。
 */
export const UpdateContentSpeechBodySchema = z.object({
  model: z.string(),
  voice: z.string(),
});
export type UpdateContentSpeechBody = z.infer<typeof UpdateContentSpeechBodySchema>;
/**
 * PUT /api/settings/content。有効 / 無効の切り替え。キーと選択は保持し、行が無ければ 400（キー登録が先）。
 * 画像・音声・BGM は 1 つのトグルを共有する。
 */
export const UpdateContentEnabledBodySchema = z.object({
  enabled: z.boolean(),
});
export type UpdateContentEnabledBody = z.infer<typeof UpdateContentEnabledBodySchema>;
/** 画像APIキーの登録・上書き。長さは provider_credentials と同じ */
export const UpdateContentKeyBodySchema = z.object({
  apiKey: z.string().min(PROVIDER_API_KEY_MIN_LENGTH).max(PROVIDER_API_KEY_MAX_LENGTH),
});
export type UpdateContentKeyBody = z.infer<typeof UpdateContentKeyBodySchema>;
