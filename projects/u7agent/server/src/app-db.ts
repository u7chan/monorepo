/**
 * アプリデータ (プロジェクト / エージェント / 設定) の SQLite ストア。
 * 置き場所・スキーマの作り直し・失敗時の扱いは docs/persistence.md を正とする。
 * スキル定義はこの DB ではなくファイル (`.agents/skills`) を正とする。
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDbSchema, APP_DB_SCHEMA_VERSION } from "./app-db-schema";
import { spaceDirRel } from "./app-paths";
import { jsonArrayColumn, jsonObject, optionalBlob, optionalNumber, optionalText, text, type Row } from "./db-values";
import { httpError, messageFor } from "./http";
import {
  imageParameterBody,
  imageParameterDeclarationsOf,
  type ImageInputDeclaration,
  type ImageParameterDeclarations,
} from "./images";
import type { SecretKind } from "./secret-crypto";
import { ImageParameterValuesSchema } from "./schema";
import type { AgentDef, ImageParameterValues, ModelRef, NotificationResult, Project, PromptRef, Space } from "./schema";
import type { SpeechAudioFormat } from "./speech";
import { SharedContentRepository } from "./shared-content-repository";

export const APP_DB_FILENAME = "u7agent.db";

/**
 * AEAD で保存する値の保存形。GCM の認証タグは ciphertext の末尾に含む。
 * 方式と AAD の規約は docs/secrets.md を正とする。
 */
export interface StoredAppSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
}

/** 列がすべて揃っているときだけ保存形へ写す (欠けた行は「未保存」と読み違えないよう例外にする) */
function storedAppSecretOf(
  row: Row,
  table: string,
  columns: { ciphertext: string; nonce: string; keyVersion: string } = {
    ciphertext: "ciphertext",
    nonce: "nonce",
    keyVersion: "keyVersion",
  },
): StoredAppSecret | null {
  const ciphertext = optionalBlob(row[columns.ciphertext]);
  const nonce = optionalBlob(row[columns.nonce]);
  const keyVersion = optionalNumber(row[columns.keyVersion]);
  const present = [ciphertext !== null, nonce !== null, keyVersion !== null];
  if (present.every((value) => !value)) return null;
  if (!ciphertext || !nonce || keyVersion === null || !Number.isInteger(keyVersion)) {
    throw new Error(`${table} secret columns are incomplete`);
  }
  return { ciphertext, nonce, keyVersion };
}

/** プロバイダー API キーの保存行。値は AEAD の暗号文で、復号は docs/secrets.md の契約に従う */
export interface ProviderCredentialRow extends StoredAppSecret {
  provider: string;
  /** 最終保存時刻 (epoch ms)。NULL は移行前の行で不明 */
  updatedAt: number | null;
}

/** プロバイダーに紐づく人間用メモの保存行。空文字の行は未設定として返す (optionalText) */
export interface ProviderMemoRow {
  provider: string;
  memo: string;
}

/**
 * 設定 → モデルのカスタムプロバイダーの保存行。1 provider = 1 model の定義と AEAD の暗号文を
 * 同じ行に持ち、キーの平文列は持たない (復号はサービス側で行う)。
 */
export interface CustomProviderRow extends StoredAppSecret {
  provider: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * 利用可能なモデル / アプリ既定モデルの保存行。allowedModels の null は制限なし、
 * defaultModel の null は「既定なし」を表す (候補の先頭では代用しない)
 */
export interface ModelSettingsRow {
  allowedModels: ModelRef[] | null;
  defaultModel: string | null;
}

/**
 * コンテンツ生成の保存行。**行が無い = 未設定**で、キー削除は行ごと消す。APIキーは AEAD の暗号文で、
 * 3 列がすべて NULL = キー未設定 (契約は docs/secrets.md / docs/image-generation.md)。
 * `enabled` はアプリ全体の有効 / 無効（既存行は ON）。OFF でも行は残すため、
 * キーと選択は消えない（削除は別操作）。
 * 音声の 2 列は nullable 列で、NULL は既定（モデル）と「宣言する先頭ボイス」
 * （voice）へフォールバックして読む。
 */
export interface ContentSettingsRow {
  provider: string;
  imageModel: string;
  speechModel: string | null;
  speechVoice: string | null;
  enabled: boolean;
  /**
   * 画像の生成パラメータの既定（bare なモデル id → 値）。null = 既定なし、`{}` = 空の map を保存済み
   * （既存行は NULL のまま）。
   */
  imageParams: ImageParameterDefaults | null;
  /** APIキーの暗号文。null = キー未設定 */
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  keyVersion: number | null;
}

/**
 * モデル id をキーにした生成パラメータの既定。画面が使う `provider/id` ではなく bare id をキーにし、
 * `PUT /api/settings/content/image` の `model` と揃える。
 */
export type ImageParameterDefaults = Record<string, ImageParameterValues>;

/**
 * 画像の生成元の保存行。**行が無い = 既定（openrouter）**で、キー削除では消さない別テーブルに持つ。
 * OpenRouter のモデルは `content_settings.imageModel` が正のまま（同じ値を 2 箇所へ写さない）。
 * `codexParams` は将来の Codex 用パラメータの枠で、v1 の API / 画面は読み書きしない（値は保持する）。
 */
export interface ImageSettingsRow {
  provider: string;
  codexParams: string | null;
}

/**
 * 試行の成果物のメタデータ。実体は `<storeDir>/trials/<id>.<ext>` にあり、DB はパスと大きさだけを持つ
 * (BLOB では持たない)。`path` は置き場からの相対名で、配信も保存名だけを使う。
 */
export interface ContentTrialArtifactRow {
  /** `<trialId>.<ext>`。ディレクトリを含まない */
  path: string;
  bytes: number;
  /** `png` / `jpeg` / `webp`。保存時に確定した値だけを持つ */
  format: string;
  width: number | null;
  height: number | null;
}

/**
 * コンテンツ生成の試行ジョブの保存行。成果物を持たない段階 1 の行は `artifactState: none` と
 * `artifact: null` のまま残す。**行は履歴そのもの**なので、未知の版を開いたときの作り直しでも
 * 消さない (`DROP_TABLES` に入れない)。APIキーは保存しない（世代番号 `keyEpoch` だけを持つ）。
 */
export interface ContentTrialRow {
  id: string;
  kind: string;
  /** 生成元。NULL の既存行は openrouter として読む */
  provider: string;
  /** 送信時のモデル (`provider/id`)。現在の保存値とは別に持つ */
  model: string;
  prompt: string;
  /** 音声の入力スナップショット。画像の行は 3 列とも null */
  voice: string | null;
  instructions: string | null;
  speed: number | null;
  /**
   * 画像の入力スナップショット。null = 未指定。表示用の別列は持たず、
   * 保存する正規化 JSON をそのまま再利用の照合に使う
   */
  parameters: ImageParameterValues | null;
  state: string;
  keyEpoch: number;
  artifactState: string;
  /** 生成が成功して課金されたか。保存に失敗した成功も true になる */
  charged: boolean;
  /** `artifactState: stored` のときだけ非 null */
  artifact: ContentTrialArtifactRow | null;
  failureCode: string | null;
  failureMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

/** アプリデータの SQLite に保存する通知設定。Webhook URL は AEAD の暗号文で、応答へは出さない (write-only) */
export interface NotificationSettingsRow {
  enabled: boolean;
  askUser: boolean;
  /** Webhook URL の暗号文。null = 未設定 (通知は送らない) */
  webhook: StoredAppSecret | null;
  baseUrl: string | null;
  lastResult: NotificationResult | null;
}

/**
 * Web 検索の設定の保存行。**行が無い = 既定（無効 / Exa）**で、行があるときは enabled と provider が正。
 * 保存値は 0 / 1 のどちらかで、API では boolean に読み替える。provider は未知の値もそのまま返し、
 * 既定への畳み込みはサービス側で行う（docs/web-search.md）。
 */
export interface WebSearchSettingsRow {
  enabled: boolean;
  provider: string;
}

/**
 * 音声入力のキーの保存行（id = 1）。**行が無い = キー未設定**で、列は AEAD の暗号文だけを持つ。
 * v1 はキーだけなので行の型を別にせず保存形をそのまま使う（列を足すときに行の型を作る）。
 * キーは OpenAI Platform のもので、コンテンツ生成（OpenRouter）とは共有しない。
 */
export type VoiceInputSettingsRow = StoredAppSecret;

/**
 * 会話タイトルの AI 要約の保存行。**行が無い = 既定 (Off・モデル未選択・定義は既定文)**。
 * model は `provider/id` で、本会話のモデルとは独立に選ぶ。定義は編集可能な指示で、固定指示は
 * アプリ側の実装が持ち、この行では解除できない (docs/session-title.md)。
 */
export interface TitleSummarySettingsRow {
  enabled: boolean;
  /** `provider/id`。null は未選択 */
  model: string | null;
  /** 保存済みの Effort。null は未指定 (実行時にモデルの最小段階へフォールバックする) */
  thinkingLevel: string | null;
  definition: string;
}

/**
 * Git のグローバル identity の保存行。**行が無い = 未設定**で、両方揃って 1 行。
 * サンドボックスへは exec のたびにこの行を読み、未設定・読取失敗は useConfigOnly だけの config にする
 * (docs/sandbox.md#git-identity)。
 */
export interface GitSettingsRow {
  userName: string;
  userEmail: string;
}

/** カタログ 1 件の保存形。provider は v1 では openrouter 固定なので id と表示名、あれば形式 / 入力の宣言を残す */
export interface ImageCatalogModelRow {
  id: string;
  name: string;
  /** live が宣言する出力形式。無い行（この項目より前のキャッシュ）は「宣言なし」として読む */
  outputFormats?: string[] | undefined;
  /** live が宣言する画像入力の能力。無い行（この項目より前のキャッシュ）は「不明」として読む */
  input?: ImageInputDeclaration | undefined;
  /**
   * live が宣言する生成パラメータ。無い行（この項目より前のキャッシュ）と壊れた descriptor は
   * 「宣言なし」として読む（列は増やさない）
   */
  parameters?: ImageParameterDeclarations | undefined;
}

/**
 * live カタログのキャッシュ行。**行が無い = 取得できていない**で、SDK 同梱カタログへ落ちる。
 * 利用者データではなくキャッシュなので、壊れた行は未保存として扱い、設定 API を 503 にしない。
 */
export interface ImageCatalogRow {
  /** 最後に live を取得できた時刻 (epoch ms) */
  fetchedAt: number;
  models: ImageCatalogModelRow[];
}

/** 音声カタログ 1 件の保存形。provider は v1 では openrouter 固定なので id と表示名、話者の宣言を残す */
export interface SpeechCatalogModelRow {
  id: string;
  name: string;
  /** live が宣言する話者。無い行（宣言の無いモデル・この項目より前のキャッシュ）は「宣言なし」として読む */
  voices?: string[] | undefined;
}

/**
 * live 音声カタログのキャッシュ行。テーブルの形は `image_catalog` と同型だが、item の JSON は違う
 * （`voices` を持つ）。行が無い = 取得できておらず、同梱の既定 1 件へ落ちる。
 */
export interface SpeechCatalogRow {
  /** 最後に live を取得できた時刻 (epoch ms) */
  fetchedAt: number;
  models: SpeechCatalogModelRow[];
}

/**
 * コストマスタの接続先。**行が無い = 未設定**で、`enabled: false` + 空 URL は行を消す
 * （キー削除で行ごと消える `content_settings` とは別に持つ。docs/persistence.md）。
 */
export interface ContentCostSettingsRow {
  enabled: boolean;
  /** http / https のホスト名。空にはならない（空は未設定として読む） */
  url: string;
}

/** 価格スナップショットの 1 行。入力 / 出力の単価を、モデル単位の判断を写して持つ */
export interface ContentCostCatalogModelRow {
  modelId: string;
  unit: string;
  /** 旧スナップショット（この項目より前）は `output` として読む */
  side: "input" | "output";
  /** 解像度ティアとは限らない（加算オプションを含む）。無ければ "" */
  variant: string;
  costUsd: number;
  currency: string;
  /** マスタの人手判断。同じモデルの行は同じ値になる（マスタが繰り返す） */
  enabled: boolean;
  note: string | null;
}

/**
 * コストマスタの価格スナップショット。**行が無い = 未取得**で、取得に失敗したときは前回の行を残す。
 * 派生データなので、壊れた行は未取得として読み、設定 API を 503 にしない。
 */
export interface ContentCostCatalogRow {
  /** 取得した時刻 (epoch ms) */
  fetchedAt: number;
  /** 取得元の URL。設定の URL と一致しないスナップショットは使わない */
  sourceUrl: string;
  /** マスタの世代。契約外で読めないときは null */
  version: number | null;
  models: ContentCostCatalogModelRow[];
}

/**
 * エージェント 1 体の保存形。定型プロンプトの参照 (`promptIds`) は別テーブル `agent_prompts` に持ち、
 * 応答用の解決済みの値 (`AgentDef.prompts`) はカタログ側が付ける。
 */
export interface StoredAgent extends Omit<AgentDef, "prompts"> {
  /** 参照するマスタの ID (並び = 表示順)。未指定は参照なしとして書く */
  promptIds?: string[];
}

/**
 * 定型プロンプトのマスタ 1 件。ラベルと本文には一意制約を付けず、同じ本文を別マスタとして持てる。
 * kind と ID はサーバーが決め、組み込みは起動時に定義へ同期される (docs/persistence.md)。
 */
export type PromptRow = PromptRef;

/**
 * serve (サービス) の起動実績。**作業ディレクトリ単位**で、同じプロジェクトの他会話でも使える。
 * 稼働記録 (誰が動かしているか) ではないため、プロセスが消えても残る。
 */
export interface ServeCommandRow {
  /** ワークスペース root 相対の作業ディレクトリ (`""` は root) */
  cwd: string;
  command: string;
  updatedAt: number;
}

/**
 * 作業フォルダ単位の環境変数。所有者は cwd で、`serve_commands` と同じキー空間。
 * 種別ごとに使う列が排他で、`variable` は plaintext、`secret` は ciphertext / nonce / keyVersion。
 * 暗号化の書式と、値の再取得を許さない契約は docs/secrets.md を正とする。
 */
export interface SecretRow {
  secretId: string;
  /** ワークスペース root 相対の作業ディレクトリ (`""` は root) */
  cwd: string;
  /** 正規化済み (大文字)。変更できないため AEAD の AAD に含めてよい */
  name: string;
  kind: SecretKind;
  /** kind='variable' のときだけ値を持つ */
  plaintext: string | null;
  /** kind='secret' の暗号文 (GCM の認証タグを末尾に含む) */
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  keyVersion: number | null;
  /** 表示順。cwd 内で昇順 (削除しても詰めない) */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Cloudflare の資格情報。**行が無い = 未登録**で、BFF 専用 (agent / sandbox へ渡さない)。
 * 暗号化の書式は `secrets` と同じ AES-256-GCM を再利用する (docs/static-sharing-design.md)。
 */
export interface CloudflareSettingsRow {
  accountId: string;
  /** 認証トークンの暗号文 (GCM の認証タグを末尾に含む) */
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
  updatedAt: number;
}

export interface AppDbStatus {
  /** null は永続化なし (メモリ DB)。開けなかったときも null */
  path: string | null;
  ok: boolean;
  error?: string;
}

/** セッションの引っ越しが使う、cwd をキーにする行の付け替えだけの狭い IF */
export type CwdKeyStore = Pick<AppDb, "moveCwd">;

/** 応答 1 件分の実測。正は JSONL で、再起動・sweep をまたいで読み戻すための派生データ (docs/persistence.md) */
export interface AssistantMetricsRow {
  sessionId: string;
  /** JSONL の entry へ写した応答ID (`<runId>:<seq>`)。復元時の引き当てキー */
  assistantId: string;
  /** assistant の timestamp (epoch ms) */
  at: number;
  provider: string;
  model: string;
  durationMs: number;
  /** 最初の delta が出なかった応答は null */
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** `stopReason` が無いメッセージは null */
  stopReason: string | null;
}

/** 応答メトリクスの読み書きだけの狭い IF。会話ストアが構造的に満たす (docs/persistence.md) */
export type AssistantMetricsStore = Pick<
  AppDb,
  "recordAssistantMetrics" | "loadAssistantMetrics" | "deleteAssistantMetrics"
>;

export interface OpenAppDbOptions {
  /** 会話ストアと同じディレクトリ。null ならメモリ DB (テスト) */
  storeDir: string | null;
  /**
   * ログと health / 503 に載る DB エラー文言の境界。bootstrap が可変マスカーを渡し、
   * 登録済みのAPIキーが例外文言へ現れても生のまま記録しない。未指定は identity (テストの明示 opt-out)。
   */
  sanitizeError?: (text: string) => string;
}

function projectOf(row: Row): Project {
  return {
    id: text(row.id),
    name: text(row.name),
    cwd: text(row.cwd),
    createdAt: Number(row.createdAt),
  };
}

function providerCredentialOf(row: Row): ProviderCredentialRow {
  const secret = storedAppSecretOf(row, "provider_credentials");
  // 暗号文の欠けた行を「未登録」と読み違えて上書きしない (サービスが 503 へ変換し、削除だけは通す)
  if (!secret) throw new Error("provider_credentials row is incomplete");
  return { provider: text(row.provider), ...secret, updatedAt: optionalNumber(row.updatedAt) };
}

/** 空文字の行は未設定として落とす (手編集された DB を「メモあり」と読み違えない) */
function providerMemoOf(row: Row): ProviderMemoRow | undefined {
  const memo = optionalText(row.memo);
  return memo === undefined ? undefined : { provider: text(row.provider), memo };
}

/**
 * カスタムプロバイダーの行。暗号文の欠けた行は「未登録」と読み違えて上書きしないよう例外にする
 * (#secretQuery が値の断片を漏らさない固定文言へ置き換える)。
 * 一方で定義の妥当性はここで判定しない: 1 行の不正値 (contextWindow = 0 など) で一覧全体を止めると、
 * 正常な行の復元もその行の削除もできなくなる。行単位の検証はサービス側が degraded として扱う。
 */
function customProviderOf(row: Row): CustomProviderRow {
  const secret = storedAppSecretOf(row, "custom_providers");
  if (!secret) throw new Error("custom_providers row is incomplete");
  return {
    provider: text(row.provider),
    name: text(row.name),
    baseUrl: text(row.baseUrl),
    modelId: text(row.modelId),
    contextWindow: optionalNumber(row.contextWindow) ?? 0,
    maxTokens: optionalNumber(row.maxTokens) ?? 0,
    ...secret,
  };
}

/** 手編集で空文字にされた provider / imageModel の行は未設定として読む (メモと同じ規約) */
function contentSettingsOf(row: Row): ContentSettingsRow | undefined {
  const provider = optionalText(row.provider);
  const imageModel = optionalText(row.imageModel);
  if (!provider || !imageModel) return undefined;
  // 暗号文が NULL = キー未設定。3 列の片方だけが埋まった行は保存値の破損として失敗させる
  const secret = storedAppSecretOf(row, "content_settings");
  return {
    provider,
    imageModel,
    // 空文字も NULL と同じく「未設定」として既定へフォールバックさせる
    speechModel: optionalText(row.speechModel) ?? null,
    speechVoice: optionalText(row.speechVoice) ?? null,
    // 足した列なので、手編集で NULL にされた行も既定 (ON) として読む
    enabled: Number(row.enabled) !== 0,
    imageParams: imageParameterDefaultsOf(row.imageParams),
    ciphertext: secret?.ciphertext ?? null,
    nonce: secret?.nonce ?? null,
    keyVersion: secret?.keyVersion ?? null,
  };
}

/** 画像の生成元。行が無ければ undefined（既定 openrouter）。空文字は未設定として読む */
function imageSettingsOf(row: Row): ImageSettingsRow | undefined {
  const provider = optionalText(row.provider);
  if (!provider) return undefined;
  return { provider, codexParams: optionalText(row.codexParams) ?? null };
}

/**
 * 試行ジョブの行。数値列は INTEGER で書いているため、手編集で NULL / 小数になっていたら保存値の破損として
 * 失敗させる (未設定と読み違えない)。終端時刻と所要時間だけは `running` / `interrupted` で NULL を許す。
 * 成果物の 3 列も `stored` のときだけ揃っていなければならない (半端な行を配信経路へ渡さない)。
 */
function contentTrialOf(row: Row): ContentTrialRow {
  const id = optionalText(row.id);
  const kind = optionalText(row.kind);
  const model = optionalText(row.model);
  const state = optionalText(row.state);
  const artifactState = optionalText(row.artifactState);
  const startedAt = optionalNumber(row.startedAt);
  const keyEpoch = optionalNumber(row.keyEpoch);
  if (!id || !kind || !model || !state || !artifactState || startedAt === null || keyEpoch === null) {
    throw new Error("content_trials row is incomplete");
  }
  return {
    id,
    kind,
    // 列を足す前に書かれた行は NULL で、v1 の試行は openrouter だけだった
    provider: optionalText(row.provider) ?? "openrouter",
    model,
    // 空のプロンプトは作らないが、手編集された行は空のまま返す (履歴を消さない)
    prompt: optionalText(row.prompt) ?? "",
    voice: optionalText(row.voice) ?? null,
    instructions: optionalText(row.instructions) ?? null,
    speed: optionalNumber(row.speed) ?? null,
    parameters: imageParametersOf(row.imageParams),
    state,
    keyEpoch,
    artifactState,
    charged: Number(row.charged) !== 0,
    artifact: contentTrialArtifactOf(row, artifactState),
    failureCode: optionalText(row.failureCode) ?? null,
    failureMessage: optionalText(row.failureMessage) ?? null,
    startedAt,
    finishedAt: optionalNumber(row.finishedAt),
    durationMs: optionalNumber(row.durationMs),
  };
}

/**
 * 正規化したパラメータの保存値。許可リストのキーだけを許可リストの順で載せ、未指定は null にする
 * （同じ正規化から表示用の別列を作ると片方だけ更新する余地ができる）。
 */
function imageParamsJsonOf(parameters: ImageParameterValues | null): string | null {
  if (!parameters) return null;
  const body = imageParameterBody(parameters);
  return Object.keys(body).length === 0 ? null : JSON.stringify(body);
}

/** モデルごとの既定の保存値。null は NULL（既定なし）のまま書き、空 map は `{}` として残す */
function imageParameterDefaultsJsonOf(defaults: ImageParameterDefaults | null): string | null {
  return defaults === null ? null : JSON.stringify(defaults);
}

/**
 * モデルごとの既定を読む。壊れた保存値は未設定へ落とさず、行の破損として例外にする（利用者データなので
 * `image_catalog` のキャッシュとは扱いが違う）。
 */
function imageParameterDefaultsOf(value: unknown): ImageParameterDefaults | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("content_settings.imageParams is not a valid parameters map");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("content_settings.imageParams is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("content_settings.imageParams is not a valid parameters map");
  }
  const defaults: ImageParameterDefaults = {};
  for (const [model, parameters] of Object.entries(parsed)) {
    const result = ImageParameterValuesSchema.safeParse(parameters);
    if (!result.success) throw new Error("content_settings.imageParams is not a valid parameters map");
    defaults[model] = result.data;
  }
  return defaults;
}

/**
 * 利用者が指定したパラメータを読む。壊れた保存値は未指定へ落とさず、行の破損として例外にする
 * （キャッシュであるカタログの宣言とは扱いが違う）。
 */
function imageParametersOf(value: unknown): ImageParameterValues | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("content_trials.imageParams is not a valid parameters object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("content_trials.imageParams is not valid JSON");
  }
  const result = ImageParameterValuesSchema.safeParse(parsed);
  if (!result.success) throw new Error("content_trials.imageParams is not a valid parameters object");
  return result.data;
}

/** 成果物のメタデータ。`stored` 以外は null で、`stored` で欠けた列は破損として失敗させる */
function contentTrialArtifactOf(row: Row, artifactState: string): ContentTrialArtifactRow | null {
  if (artifactState !== "stored") return null;
  const path = optionalText(row.artifactPath);
  const bytes = optionalNumber(row.artifactBytes);
  const format = optionalText(row.artifactFormat);
  if (!path || bytes === null || !format) throw new Error("content_trials artifact is incomplete");
  return {
    path,
    bytes,
    format,
    width: optionalNumber(row.artifactWidth),
    height: optionalNumber(row.artifactHeight),
  };
}

/**
 * キャッシュ行の JSON 配列。派生データなので、JSON が壊れていても、形が違っても、空でも「未取得」として読む
 * (保存値の破損として health / 503 にはしない。読めなければ SDK カタログへ落ち、次の取得成功が行を上書きして直る)。
 */
function imageCatalogModelsOf(value: unknown): ImageCatalogModelRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const models: ImageCatalogModelRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name, outputFormats, input, parameters } = entry as {
      id?: unknown;
      name?: unknown;
      outputFormats?: unknown;
      input?: unknown;
      parameters?: unknown;
    };
    if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
    // 形式 / 入力 / 生成パラメータの宣言は任意フィールド。形が違えば「宣言なし」として読み、
    // id / 表示名が正しい行まで捨てない
    const formats = Array.isArray(outputFormats)
      ? outputFormats.filter((format): format is string => typeof format === "string" && format !== "")
      : [];
    const declaration = imageInputDeclarationOf(input);
    const declaredParameters = imageParameterDeclarationsOf(parameters);
    models.push({
      id,
      name,
      ...(formats.length > 0 ? { outputFormats: formats } : {}),
      ...(declaration ? { input: declaration } : {}),
      ...(declaredParameters ? { parameters: declaredParameters } : {}),
    });
  }
  return models;
}

/** 旧キャッシュの入力宣言。読めた項目だけを残し、1 つも読めなければ「不明」（鍵ごと落とす）にする */
function imageInputDeclarationOf(value: unknown): ImageInputDeclaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { modalities, references, endpoints } = value as {
    modalities?: unknown;
    references?: unknown;
    endpoints?: unknown;
  };
  const modalityList = Array.isArray(modalities)
    ? modalities.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  const endpointList = Array.isArray(endpoints)
    ? endpoints.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  const range = (() => {
    if (typeof references !== "object" || references === null) return undefined;
    const { min, max } = references as { min?: unknown; max?: unknown };
    if (typeof min !== "number" || typeof max !== "number") return undefined;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return undefined;
    return { min, max };
  })();
  if (modalityList.length === 0 && !range && endpointList.length === 0) return undefined;
  return {
    ...(modalityList.length > 0 ? { modalities: modalityList } : {}),
    ...(range ? { references: range } : {}),
    ...(endpointList.length > 0 ? { endpoints: endpointList } : {}),
  };
}

/**
 * 音声キャッシュ行の JSON 配列。`image_catalog` と同じく派生データなので、JSON が壊れていても、
 * 形が違っても、空でも「未取得」として読む（同梱の既定カタログへ落ち、次の取得成功が行を上書きする）。
 */
function speechCatalogModelsOf(value: unknown): SpeechCatalogModelRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const models: SpeechCatalogModelRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { id, name, voices } = entry as { id?: unknown; name?: unknown; voices?: unknown };
    if (typeof id !== "string" || id === "" || typeof name !== "string") return undefined;
    // 話者の宣言は任意フィールド。形が違えば「宣言なし」として読み、id / 表示名が正しい行まで捨てない
    const names = Array.isArray(voices)
      ? voices.filter((voice): voice is string => typeof voice === "string" && voice !== "")
      : [];
    models.push(names.length > 0 ? { id, name, voices: names } : { id, name });
  }
  return models;
}

/**
 * コストスナップショット行。`image_catalog` と同じ派生データなので、JSON が壊れていても、
 * 1 行でも形が違えば「未取得」として読む（取得し直せば直る。health の失敗にはしない）。
 */
function contentCostCatalogOf(row: Row): ContentCostCatalogRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(row.models));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const models: ContentCostCatalogModelRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { modelId, unit, side, variant, costUsd, currency, enabled, note } = entry as Record<string, unknown>;
    if (typeof modelId !== "string" || modelId === "") return undefined;
    if (typeof unit !== "string" || unit === "") return undefined;
    const normalizedSide = side === undefined ? "output" : side;
    if (normalizedSide !== "input" && normalizedSide !== "output") continue;
    if (typeof variant !== "string") return undefined;
    if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
    if (typeof currency !== "string" || typeof enabled !== "boolean") return undefined;
    if (note !== null && typeof note !== "string") return undefined;
    models.push({ modelId, unit, side: normalizedSide, variant, costUsd, currency, enabled, note });
  }
  const fetchedAt = Number(row.fetchedAt);
  const sourceUrl = text(row.sourceUrl);
  const version = optionalNumber(row.version);
  if (!Number.isInteger(fetchedAt) || fetchedAt < 0 || sourceUrl === "") return undefined;
  if (version !== null && (!Number.isInteger(version) || version < 0)) return undefined;
  return { fetchedAt, sourceUrl, version, models };
}

function serveCommandOf(row: Row): ServeCommandRow {
  return { cwd: text(row.cwd), command: text(row.command), updatedAt: Number(row.updatedAt) };
}

function assistantMetricsOf(row: Row): AssistantMetricsRow {
  return {
    sessionId: text(row.session_id),
    assistantId: text(row.assistant_id),
    at: Number(row.at),
    provider: text(row.provider),
    model: text(row.model),
    durationMs: Number(row.duration_ms),
    ttftMs: optionalNumber(row.ttft_ms),
    inputTokens: optionalNumber(row.input_tokens),
    outputTokens: optionalNumber(row.output_tokens),
    cacheRead: optionalNumber(row.cache_read),
    cacheWrite: optionalNumber(row.cache_write),
    reasoningTokens: optionalNumber(row.reasoning_tokens),
    costUsd: optionalNumber(row.cost_usd),
    stopReason: optionalText(row.stop_reason) ?? null,
  };
}

/** 未知の種別は秘密側へ寄せる (復号できない行を平文として扱わない) */
function secretOf(row: Row): SecretRow {
  return {
    secretId: text(row.secretId),
    cwd: text(row.cwd),
    name: text(row.name),
    kind: row.kind === "variable" ? "variable" : "secret",
    plaintext: typeof row.plaintext === "string" ? row.plaintext : null,
    ciphertext: optionalBlob(row.ciphertext),
    nonce: optionalBlob(row.nonce),
    keyVersion: row.keyVersion === null || row.keyVersion === undefined ? null : Number(row.keyVersion),
    sortOrder: Number(row.sortOrder),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function notificationSettingsOf(row: Row): NotificationSettingsRow {
  const baseUrl = optionalText(row.baseUrl);
  const lastResult = jsonObject<NotificationResult>(row.lastResult);
  return {
    enabled: Number(row.enabled) === 1,
    // 列の無い旧 DB と NULL は既定 (ON) として読む
    askUser: row.askUser === null || row.askUser === undefined ? true : Number(row.askUser) === 1,
    // URL は暗号文だけを持ち、GET では復号しない (復号は起動時と保存 / 置換のときだけ)
    webhook: storedAppSecretOf(row, "notification_settings", {
      ciphertext: "webhookCiphertext",
      nonce: "webhookNonce",
      keyVersion: "webhookKeyVersion",
    }),
    baseUrl: baseUrl ?? null,
    lastResult: lastResult ?? null,
  };
}

function agentOf(row: Row): AgentDef {
  const agent: AgentDef = {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    systemPrompt: text(row.systemPrompt),
  };
  const icon = optionalText(row.icon);
  const model = jsonObject<ModelRef>(row.model);
  const thinkingLevel = optionalText(row.thinkingLevel);
  const commonSkillNames = agentSkillNames(row, "commonSkillNames");
  const builtinSkillNames = agentSkillNames(row, "builtinSkillNames");
  const toolNames = agentSkillNames(row, "toolNames");
  // 未指定の項目はキーごと省略する (応答に null は現れない)
  if (icon) agent.icon = icon;
  if (model) agent.model = model;
  if (thinkingLevel) agent.thinkingLevel = thinkingLevel as AgentDef["thinkingLevel"];
  if (commonSkillNames) agent.commonSkillNames = commonSkillNames;
  if (builtinSkillNames) agent.builtinSkillNames = builtinSkillNames;
  if (toolNames) agent.toolNames = toolNames;
  // NULL = 既定 (自然文でも発火する)、0 = false。1 は保存しない (true は NULL へ正規化する)。2 列は独立
  if (row.allowNaturalInvocationBuiltin === 0) agent.allowNaturalInvocationBuiltin = false;
  if (row.allowNaturalInvocationFile === 0) agent.allowNaturalInvocationFile = false;
  return agent;
}

/**
 * 許可リストの列。NULL = 未指定 (全可視 / 全部 ON) と `"[]"` = すべて OFF を区別する。
 * 行がある以上 NULL 以外は JSON 配列のはずなので、壊れた値は未指定へ黙って落とさず失敗させる
 * (model_settings.allowedModels と同じ形)。
 */
function agentSkillNames(
  row: Row,
  column: "commonSkillNames" | "builtinSkillNames" | "toolNames",
): string[] | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  const names = jsonArrayColumn<string>("agents", column, value);
  if (!names) throw new Error(`agents.${column} is not a JSON array`);
  return names;
}

/**
 * エージェントごとの参照マスタ ID を表示順でまとめる。全件取得 (引数なし) と 1 体だけを同じ形で読む。
 */
function promptIdsByAgent(db: DatabaseSync, agentId?: string): Map<string, string[]> {
  const rows = (
    agentId === undefined
      ? db.prepare("SELECT agentId, promptId FROM agent_prompts ORDER BY agentId, position").all()
      : db.prepare("SELECT agentId, promptId FROM agent_prompts WHERE agentId = ? ORDER BY position").all(agentId)
  ) as Row[];
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const id = text(row.agentId);
    const ids = result.get(id) ?? [];
    ids.push(text(row.promptId));
    result.set(id, ids);
  }
  return result;
}

function promptOf(row: Row): PromptRow {
  const kind = text(row.kind) === "builtin" ? "builtin" : "custom";
  return { id: text(row.id), kind, label: text(row.label), prompt: text(row.prompt) };
}

/**
 * DB を持てない状態でもインスタンスを返し、クエリで 503 を投げる (メモリ DB へは逃がさない)。
 * 理由は health へ出し、ルートはこの例外で 503 になる。
 */
/**
 * provider メモは retainSecret に登録しない方針なので、SQLite の例外文言に値が写り得る。
 * ログ・health・503 へは、この値を含まない固定文言だけを渡す。
 */
const PROVIDER_MEMO_QUERY_FAILED = "provider memo query failed";

/**
 * 暗号文を読むクエリの失敗文言。暗号文・平文を例外文言へ反射させられても、ログ・health・503 へは
 * この固定文言だけを渡す (可変マスカーは暗号文の hex / base64 を守れない)。
 */
const APP_SECRET_QUERY_FAILED = "app secret query failed";

export class AppDb {
  #db: DatabaseSync | null;
  #path: string | null;
  #error: string | undefined;
  /**
   * 壊れた保存値のように、別テーブルの読取成功で消してはいけない失敗。テーブル名ごとに持ち、
   * 同じテーブルの読取が成功したときだけ解除する。一過性の失敗 (#error) と違い probe() では消えない。
   */
  #storedValueErrors = new Map<string, string>();
  #sanitizeError: (text: string) => string;

  /**
   * 共有コンテンツの読み書き。SQL は `shared-content-repository.ts` が持ち、ここは接続を貸す。
   * 同じ接続を共有するので、`transaction()` の内側から他のドメインの書き込みと混ぜられる
   */
  readonly sharedContents: SharedContentRepository;

  /**
   * テーブル定義と移行。SQL は `app-db-schema.ts` が持ち、接続・トランザクション・値の境界はここが貸す
   * (移行は `open()` の中だけで、以後の読み書きはこの module を通らない)
   */
  readonly #schema: AppDbSchema;

  private constructor(
    db: DatabaseSync | null,
    path: string | null,
    sanitizeError: (text: string) => string,
    error?: string,
  ) {
    this.#db = db;
    this.#path = path;
    this.#sanitizeError = sanitizeError;
    this.#error = error;
    this.sharedContents = new SharedContentRepository({ query: (fn, key) => this.#query(fn, key) });
    this.#schema = new AppDbSchema({
      query: (fn, key) => this.#query(fn, key),
      secretQuery: (fn) => this.#secretQuery(fn),
      transaction: (fn) => this.transaction(fn),
    });
  }

  static open({ storeDir, sanitizeError }: OpenAppDbOptions): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    const path = storeDir === null ? null : join(storeDir, APP_DB_FILENAME);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path ?? ":memory:");
      // 会話ストアと同じ方針 (メモリ DB では無視される)
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      // 定型プロンプトの参照は外部キー (CASCADE / RESTRICT) で整合性を守る。接続ごとの設定なので
      // トランザクションの外で有効にする
      db.exec("PRAGMA foreign_keys = ON");
      const instance = new AppDb(db, path, sanitize);
      const version = instance.#schemaVersion();
      // user_version が 0 = 未初期化 (新規ファイル・0 バイトの残骸・メモリ DB)。このときだけ初期値を入れる
      if (version === 0) instance.#schema.recreate(true);
      // 古い版は加算的に移行する (定義を消さない)。未知の新しい版だけ作り直す
      else if (version < APP_DB_SCHEMA_VERSION) instance.#schema.migrate(version);
      else if (version > APP_DB_SCHEMA_VERSION) instance.#schema.recreate(false);
      // 廃止した組み込みプロンプトの行を、新規作成・移行・再起動のすべての経路で消す
      instance.#schema.removeBuiltinPrompts();
      return instance;
    } catch (error) {
      try {
        // 失敗した接続を残さない (後始末の失敗で元の理由を隠さない)
        db?.close();
      } catch {
        // noop
      }
      console.error(`[u7agent] app db unavailable: ${sanitize(messageFor(error))}`);
      return new AppDb(null, path, sanitize, sanitize(messageFor(error)));
    }
  }

  /** パス解決の失敗など、開く前に DB を使えないと分かっている状態 */
  static unavailable({
    storeDir,
    error,
    sanitizeError,
  }: {
    storeDir: string | null;
    error: string;
    sanitizeError?: (text: string) => string;
  }): AppDb {
    const sanitize = sanitizeError ?? ((text: string) => text);
    return new AppDb(null, storeDir === null ? null : join(storeDir, APP_DB_FILENAME), sanitize, sanitize(error));
  }

  status(): AppDbStatus {
    if (!this.#db) return { path: this.#path, ok: false, error: this.#error ?? "unknown error" };
    // 壊れた保存値は別テーブルの成功で消さない (health が失敗を示し続ける)。解消はその行の修正か保存し直し
    const [storedValueError] = this.#storedValueErrors.values();
    const error = storedValueError ?? this.#error;
    return error ? { path: this.#path, ok: false, error } : { path: this.#path, ok: true };
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /** 途中で失敗したら部分適用を残さない。呼び出し側の例外はそのまま伝える */
  transaction<T>(fn: () => T): T {
    this.#query((db) => db.exec("BEGIN"));
    try {
      const result = fn();
      this.#query((db) => db.exec("COMMIT"));
      return result;
    } catch (error) {
      try {
        // 失敗した操作の後始末なので、成功しても #error を消さない (壊れたことを次の読み取りまで隠さない)
        this.#handle().exec("ROLLBACK");
      } catch {
        // rollback の失敗で元の例外を隠さない (接続が壊れている場合は次のクエリで 503 になる)
      }
      throw error;
    }
  }

  /** 入口ガードが失敗状態から戻れるかを確かめる軽い読み取り (成功したら #error が消える) */
  probe(): boolean {
    return this.#query((db) => Boolean(db.prepare("SELECT 1").get()));
  }

  #handle(): DatabaseSync {
    if (!this.#db) throw httpError(503, `アプリデータ（SQLite）を利用できません: ${this.#error ?? "unknown error"}`);
    return this.#db;
  }

  /**
   * 稼働中の失敗も 503 に寄せる (成功したら解除する)。理由は health にも出る。
   * `storedValueKey` を渡した読取は「壊れた保存値」として扱い、別テーブルの成功では消さない。
   * 呼び出し側は理由 (例外文言) を写さず、操作の分類だけを返す (マスクと記録はここで済ませている)。
   */
  #query<T>(fn: (db: DatabaseSync) => T, storedValueKey?: string): T {
    const db = this.#handle();
    try {
      const result = fn(db);
      if (storedValueKey) this.#storedValueErrors.delete(storedValueKey);
      this.#error = undefined;
      return result;
    } catch (error) {
      const message = this.#sanitizeError(messageFor(error));
      this.#error = message;
      if (storedValueKey) this.#storedValueErrors.set(storedValueKey, message);
      console.error(`[u7agent] app db query failed: ${message}`);
      throw httpError(503, `アプリデータ（SQLite）を利用できません: ${message}`);
    }
  }

  /**
   * provider メモ専用のクエリ入口。メモはマスカーへ登録しないため、トリガーの RAISE などで例外文言に
   * 値が写っても、#query がログ / #error へ渡す前に値を含まない固定文言へ置き換える。
   */
  #memoQuery<T>(fn: (db: DatabaseSync) => T): T {
    return this.#query((db) => {
      try {
        return fn(db);
      } catch {
        throw new Error(PROVIDER_MEMO_QUERY_FAILED);
      }
    });
  }

  /**
   * 暗号文を読む / 書くクエリ専用の入口。`#query` がログ・health・503 へ値を渡す前に、
   * 操作の分類だけを表す固定文言へ置き換える。SQLite のトリガーなどで `hex(NEW.ciphertext)` を
   * 例外へ反射させても、値はここより外へ出ない。
   */
  #secretQuery<T>(fn: (db: DatabaseSync) => T): T {
    return this.#query((db) => {
      try {
        return fn(db);
      } catch {
        throw new Error(APP_SECRET_QUERY_FAILED);
      }
    });
  }

  /**
   * 応答メトリクス専用の入口。失敗しても `#error` を立てず、health / アプリデータ API を 503 に
   * 巻き込まない: メタを保存できないことで会話を止めないため (#query の catch は 503 へ倒す)。
   * 値は数値とモデル識別子だけなので、例外文言のマスクは `sanitizeError` に任せる。
   */
  #metricsQuery<T>(fn: (db: DatabaseSync) => T): T | undefined {
    try {
      return fn(this.#handle());
    } catch (error) {
      console.warn(`[u7agent] app db assistant metrics failed: ${this.#sanitizeError(messageFor(error))}`);
      return undefined;
    }
  }

  #schemaVersion(): number {
    const row = this.#handle().prepare("PRAGMA user_version").get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  getNotificationSettings(): NotificationSettingsRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM notification_settings WHERE id = 1").get() as Row | undefined,
    );
    return row ? notificationSettingsOf(row) : undefined;
  }

  /** Webhook URL は暗号文だけを書く。平文の列は持たない (値は呼び出し側が暗号化して渡す) */
  saveNotificationSettings(settings: NotificationSettingsRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO notification_settings
             (id, enabled, askUser, webhookCiphertext, webhookNonce, webhookKeyVersion, baseUrl, mention, lastResult)
           VALUES (1, ?, ?, ?, ?, ?, ?, 'none', ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, askUser = excluded.askUser,
             webhookCiphertext = excluded.webhookCiphertext, webhookNonce = excluded.webhookNonce,
             webhookKeyVersion = excluded.webhookKeyVersion, baseUrl = excluded.baseUrl, mention = 'none',
             lastResult = excluded.lastResult`,
        )
        .run(
          settings.enabled ? 1 : 0,
          settings.askUser ? 1 : 0,
          settings.webhook?.ciphertext ?? null,
          settings.webhook?.nonce ?? null,
          settings.webhook?.keyVersion ?? null,
          settings.baseUrl,
          settings.lastResult ? JSON.stringify(settings.lastResult) : null,
        ),
    );
  }

  readArchiveExcludeNames(): string[] | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM archive_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      const names = jsonArrayColumn<string>("archive_settings", "excludeNames", row.excludeNames);
      // 行がある以上は配列のはず。壊れた値は黙って既定へ落とさず、他の列と同じく 503 にする
      if (!names) throw new Error("archive_settings.excludeNames is not a JSON array");
      return names;
    }, "archive_settings");
  }

  saveArchiveExcludeNames(names: readonly string[]): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO archive_settings (id, excludeNames) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET excludeNames = excluded.excludeNames`,
        )
        .run(JSON.stringify(names)),
    );
  }

  /** 行を消して未設定へ戻す (既定名を保存し直すと、以後の既定の更新に追随しなくなる) */
  resetArchiveExcludeNames(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM archive_settings WHERE id = 1").run().changes > 0);
  }

  listProviderCredentials(): ProviderCredentialRow[] {
    return this.#secretQuery((db) =>
      (db.prepare("SELECT * FROM provider_credentials ORDER BY rowid").all() as Row[]).map(providerCredentialOf),
    );
  }

  getProviderCredential(provider: string): ProviderCredentialRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM provider_credentials WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerCredentialOf(row) : undefined;
  }

  /**
   * 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定し、
   * ここが成功して返れば行は永続化されている (呼び出し側の not_stored 判定の根拠)。
   * 値は暗号化済みの保存形だけを受け取り、`updatedAt` (epoch ms) は呼び出し側が渡す。
   */
  saveProviderCredential(provider: string, secret: StoredAppSecret, updatedAt: number): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO provider_credentials (provider, ciphertext, nonce, keyVersion, updatedAt)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion, updatedAt = excluded.updatedAt`,
        )
        .run(provider, secret.ciphertext, secret.nonce, secret.keyVersion, updatedAt),
    );
  }

  /** 復号せずに行を消す (master key が無くても削除できる) */
  deleteProviderCredential(provider: string): boolean {
    return this.#secretQuery(
      (db) => db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider).changes > 0,
    );
  }

  listProviderMemos(): ProviderMemoRow[] {
    return this.#memoQuery((db) =>
      (db.prepare("SELECT * FROM provider_memos ORDER BY rowid").all() as Row[])
        .map(providerMemoOf)
        .filter((row): row is ProviderMemoRow => row !== undefined),
    );
  }

  getProviderMemo(provider: string): ProviderMemoRow | undefined {
    const row = this.#memoQuery(
      (db) => db.prepare("SELECT * FROM provider_memos WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? providerMemoOf(row) : undefined;
  }

  /** 登録と上書きで同じ (provider が主キー)。単一ステートメントなので自動コミットで確定する */
  saveProviderMemo(provider: string, memo: string): void {
    this.#memoQuery((db) =>
      db
        .prepare(
          `INSERT INTO provider_memos (provider, memo) VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET memo = excluded.memo`,
        )
        .run(provider, memo),
    );
  }

  deleteProviderMemo(provider: string): boolean {
    return this.#memoQuery(
      (db) => db.prepare("DELETE FROM provider_memos WHERE provider = ?").run(provider).changes > 0,
    );
  }

  listCustomProviders(): CustomProviderRow[] {
    return this.#secretQuery((db) =>
      (db.prepare("SELECT * FROM custom_providers ORDER BY rowid").all() as Row[]).map(customProviderOf),
    );
  }

  getCustomProvider(provider: string): CustomProviderRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM custom_providers WHERE provider = ?").get(provider) as Row | undefined,
    );
    return row ? customProviderOf(row) : undefined;
  }

  /**
   * 作成と更新で同じ (provider が主キー)。単一ステートメントなので自動コミットで確定し、
   * ここが成功して返れば行は永続化されている (呼び出し側の not_stored 判定の根拠)。
   * 値は暗号化済みの保存形だけを受け取る (平文キーは書かない)。
   */
  saveCustomProvider(row: CustomProviderRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO custom_providers
             (provider, name, baseUrl, modelId, contextWindow, maxTokens, ciphertext, nonce, keyVersion)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET name = excluded.name, baseUrl = excluded.baseUrl,
             modelId = excluded.modelId, contextWindow = excluded.contextWindow, maxTokens = excluded.maxTokens,
             ciphertext = excluded.ciphertext, nonce = excluded.nonce, keyVersion = excluded.keyVersion`,
        )
        .run(
          row.provider,
          row.name,
          row.baseUrl,
          row.modelId,
          row.contextWindow,
          row.maxTokens,
          row.ciphertext,
          row.nonce,
          row.keyVersion,
        ),
    );
  }

  /** 復号せずに行を消す (master key が無くても削除できる) */
  deleteCustomProvider(provider: string): boolean {
    return this.#secretQuery(
      (db) => db.prepare("DELETE FROM custom_providers WHERE provider = ?").run(provider).changes > 0,
    );
  }

  /** 行が無ければ undefined。壊れた JSON は黙って未設定へ落とさず 503 にする */
  readModelSettings(): ModelSettingsRow | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM model_settings WHERE id = 1").get() as Row | undefined;
      if (!row) return undefined;
      // 行がある以上 allowedModels は JSON 配列か NULL のはず。壊れた値を制限なしと読み違えない
      const parsed =
        row.allowedModels === null
          ? null
          : jsonArrayColumn<ModelRef>("model_settings", "allowedModels", row.allowedModels);
      if (row.allowedModels !== null && !parsed) throw new Error("model_settings.allowedModels is not a JSON array");
      return {
        allowedModels: parsed && parsed.length > 0 ? parsed : null,
        defaultModel: optionalText(row.defaultModel) ?? null,
      };
    }, "model_settings");
  }

  /** 空配列は制限なしへ正規化する。両方 null になったら行を消して未設定へ戻す */
  saveModelSettings(settings: ModelSettingsRow): void {
    const allowedModels = settings.allowedModels && settings.allowedModels.length > 0 ? settings.allowedModels : null;
    const defaultModel = settings.defaultModel || null;
    if (!allowedModels && !defaultModel) {
      this.resetModelSettings();
      return;
    }
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO model_settings (id, allowedModels, defaultModel) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET allowedModels = excluded.allowedModels, defaultModel = excluded.defaultModel`,
        )
        .run(allowedModels ? JSON.stringify(allowedModels) : null, defaultModel),
    );
  }

  /** 行を消して未設定へ戻す (保存値が残っていないことを応答で確かめる導線) */
  resetModelSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM model_settings WHERE id = 1").run().changes > 0);
  }

  /** 行が無ければ undefined。空文字へ手編集された行も未設定として読む (キーは暗号文だけを返す) */
  readContentSettings(): ContentSettingsRow | undefined {
    // 行の写像も #secretQuery の内側で行う（手編集された列の破損を、未設定へ落とさず 503 に寄せる）
    return this.#secretQuery((db) => {
      const row = db.prepare("SELECT * FROM content_settings WHERE id = 1").get() as Row | undefined;
      return row ? contentSettingsOf(row) : undefined;
    });
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。単一ステートメントなので自動コミットで確定する */
  saveContentSettings(settings: ContentSettingsRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO content_settings
             (id, provider, imageModel, speechModel, speechVoice, enabled, imageParams, ciphertext, nonce, keyVersion)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, imageModel = excluded.imageModel,
             speechModel = excluded.speechModel, speechVoice = excluded.speechVoice, enabled = excluded.enabled,
             imageParams = excluded.imageParams, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion`,
        )
        .run(
          settings.provider,
          settings.imageModel,
          settings.speechModel,
          settings.speechVoice,
          settings.enabled ? 1 : 0,
          imageParameterDefaultsJsonOf(settings.imageParams),
          settings.ciphertext,
          settings.nonce,
          settings.keyVersion,
        ),
    );
  }

  /** 行を消して未設定へ戻す (キー削除は provider / imageModel も含めて行ごと消す)。復号は不要 */
  deleteContentSettings(): boolean {
    return this.#secretQuery((db) => db.prepare("DELETE FROM content_settings WHERE id = 1").run().changes > 0);
  }

  /** 行が無ければ undefined（既定 openrouter）。キー削除でもこの行は消さない */
  readImageSettings(): ImageSettingsRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM image_settings WHERE id = 1").get() as Row | undefined);
    return row ? imageSettingsOf(row) : undefined;
  }

  /** provider の保存。id = 1 の upsert で、codexParams は渡された行の値をそのまま書く */
  saveImageSettings(settings: ImageSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO image_settings (id, provider, codexParams) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, codexParams = excluded.codexParams`,
        )
        .run(settings.provider, settings.codexParams),
    );
  }

  /** 現在のキー世代。行が無ければ 0 (まだ一度もキーを保存していない) */
  readContentKeyEpoch(): number {
    const row = this.#query(
      (db) => db.prepare("SELECT epoch FROM content_key_epoch WHERE id = 1").get() as Row | undefined,
    );
    const epoch = optionalNumber(row?.epoch);
    return epoch !== null && Number.isInteger(epoch) && epoch >= 0 ? epoch : 0;
  }

  /** キーの保存・上書き・削除で世代を 1 つ進め、進めた後の値を返す (単一ステートメントで確定する) */
  advanceContentKeyEpoch(): number {
    return this.transaction(() => {
      this.#query((db) =>
        db
          .prepare(
            `INSERT INTO content_key_epoch (id, epoch) VALUES (1, 1)
             ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1`,
          )
          .run(),
      );
      return this.readContentKeyEpoch();
    });
  }

  /** 試行を `running` で先に作り、終端は #finishContentTrial で書く */
  saveContentTrial(row: ContentTrialRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO content_trials
             (id, kind, provider, model, prompt, voice, instructions, speed, imageParams, state, keyEpoch,
              artifactState, charged, artifactPath, artifactBytes, artifactFormat, artifactWidth, artifactHeight,
              failureCode, failureMessage, startedAt, finishedAt, durationMs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.kind,
          row.provider,
          row.model,
          row.prompt,
          row.voice,
          row.instructions,
          row.speed,
          imageParamsJsonOf(row.parameters),
          row.state,
          row.keyEpoch,
          row.artifactState,
          row.charged ? 1 : 0,
          row.artifact?.path ?? null,
          row.artifact?.bytes ?? null,
          row.artifact?.format ?? null,
          row.artifact?.width ?? null,
          row.artifact?.height ?? null,
          row.failureCode,
          row.failureMessage,
          row.startedAt,
          row.finishedAt,
          row.durationMs,
        ),
    );
  }

  /**
   * 終端への更新。**`running` の行だけ**を対象にし、終端状態から別の状態へは進めない
   * (完了直後のキャンセルや、遅れて届いた結果で状態を戻さない)。状態と成果物のメタデータを 1 文で書き、
   * ファイルと行の片側だけが確定しないようにする。更新したかを返す。
   */
  finishContentTrial(input: {
    id: string;
    state: string;
    failureCode: string | null;
    failureMessage: string | null;
    finishedAt: number;
    durationMs: number | null;
    charged: boolean;
    artifact: ContentTrialArtifactRow | null;
  }): boolean {
    return this.#query(
      (db) =>
        db
          .prepare(
            `UPDATE content_trials
               SET state = ?, failureCode = ?, failureMessage = ?, finishedAt = ?, durationMs = ?,
                   charged = ?, artifactState = ?, artifactPath = ?, artifactBytes = ?, artifactFormat = ?,
                   artifactWidth = ?, artifactHeight = ?
             WHERE id = ? AND state = 'running'`,
          )
          .run(
            input.state,
            input.failureCode,
            input.failureMessage,
            input.finishedAt,
            input.durationMs,
            input.charged ? 1 : 0,
            input.artifact ? "stored" : "none",
            input.artifact?.path ?? null,
            input.artifact?.bytes ?? null,
            input.artifact?.format ?? null,
            input.artifact?.width ?? null,
            input.artifact?.height ?? null,
            input.id,
          ).changes > 0,
    );
  }

  /**
   * 同じ入力（種別 / 生成元 / モデル / プロンプト / 音声のパラメーター / 画像のパラメーター）の保存済み成功。
   * あれば provider を呼ばずにその結果を見せる (課金しない)。並びは新しい順の先頭 1 件で、
   * `artifactState = 'stored'` だけを対象にする。音声の 3 列と `imageParams` は `IS` で比べ、
   * NULL（未指定）同士も一致させる。
   */
  findReusableContentTrial(input: {
    kind: string;
    provider: string;
    model: string;
    prompt: string;
    voice: string | null;
    instructions: string | null;
    speed: number | null;
    parameters: ImageParameterValues | null;
    keyEpoch: number;
  }): ContentTrialRow | undefined {
    const row = this.#query(
      (db) =>
        db
          .prepare(
            `SELECT * FROM content_trials
             WHERE kind = ? AND COALESCE(provider, 'openrouter') IS ? AND model = ? AND prompt = ?
               AND voice IS ? AND instructions IS ? AND speed IS ? AND imageParams IS ?
               AND keyEpoch = ?
               AND state = 'succeeded' AND artifactState = 'stored'
               AND artifactPath IS NOT NULL
             ORDER BY startedAt DESC, rowid DESC LIMIT 1`,
          )
          .get(
            input.kind,
            input.provider,
            input.model,
            input.prompt,
            input.voice,
            input.instructions,
            input.speed,
            imageParamsJsonOf(input.parameters),
            input.keyEpoch,
          ) as Row | undefined,
    );
    return row ? contentTrialOf(row) : undefined;
  }

  /**
   * 保存容量。ディレクトリは走査せず、`succeeded` かつ `stored` の行のバイト数を合計する
   * (再照合で消えるはずの中途ファイルを容量に数えない)。
   */
  readContentTrialArtifactUsage(): { count: number; bytes: number } {
    const row = this.#query(
      (db) =>
        db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(artifactBytes), 0) AS bytes FROM content_trials
             WHERE state = 'succeeded' AND artifactState = 'stored'`,
          )
          .get() as Row,
    );
    return { count: Number(row.count), bytes: Number(row.bytes) };
  }

  /** 行が無ければ undefined。`kind` は問わない (id は不透明なので、未知の種別もそのまま返す) */
  readContentTrial(id: string): ContentTrialRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM content_trials WHERE id = ?").get(id) as Row | undefined);
    return row ? contentTrialOf(row) : undefined;
  }

  /** 新しい順。`kind` を省略すると全種別 (段階 1 は画像だけだが、種別は列で分ける) */
  listContentTrials(kind?: string): ContentTrialRow[] {
    return this.#query((db) => {
      const rows = kind
        ? (db
            .prepare("SELECT * FROM content_trials WHERE kind = ? ORDER BY startedAt DESC, rowid DESC")
            .all(kind) as Row[])
        : (db.prepare("SELECT * FROM content_trials ORDER BY startedAt DESC, rowid DESC").all() as Row[]);
      return rows.map(contentTrialOf);
    });
  }

  /**
   * 一覧の 1 ページ。`startedAt` と rowid の降順で、`before` より古い範囲を `limit` 件返す (呼び出し側が
   * 1 件多く取って `hasMore` を決める)。行を削除してもページの残りがずれないよう、位置は行の値で持つ。
   */
  listContentTrialPage(input: {
    kind?: string | undefined;
    limit: number;
    before?: { startedAt: number; seq: number } | undefined;
  }): (ContentTrialRow & { seq: number })[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.kind !== undefined) {
      where.push("kind = ?");
      params.push(input.kind);
    }
    if (input.before !== undefined) {
      where.push("(startedAt < ? OR (startedAt = ? AND rowid < ?))");
      params.push(input.before.startedAt, input.before.startedAt, input.before.seq);
    }
    const filter = where.length === 0 ? "" : `WHERE ${where.join(" AND ")} `;
    const sql = `SELECT rowid AS seq, * FROM content_trials ${filter}ORDER BY startedAt DESC, rowid DESC LIMIT ?`;
    return this.#query((db) => {
      const rows = db.prepare(sql).all(...params, input.limit) as Row[];
      return rows.map((row) => ({ ...contentTrialOf(row), seq: Number(row.seq) }));
    });
  }

  /** `running` の行だけ。一覧の再照合と実行中のポーリングは履歴の全件を読まない */
  listRunningContentTrials(kind?: string): ContentTrialRow[] {
    return this.#query((db) => {
      const rows = kind
        ? (db
            .prepare(
              "SELECT * FROM content_trials WHERE state = 'running' AND kind = ? ORDER BY startedAt DESC, rowid DESC",
            )
            .all(kind) as Row[])
        : (db
            .prepare("SELECT * FROM content_trials WHERE state = 'running' ORDER BY startedAt DESC, rowid DESC")
            .all() as Row[]);
      return rows.map(contentTrialOf);
    });
  }

  deleteContentTrial(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM content_trials WHERE id = ?").run(id).changes > 0);
  }

  /** 終端状態の行だけを消す。`running` は呼び出し側が拒否し、全削除でも残す */
  deleteTerminalContentTrials(kind?: string): number {
    return this.#query((db) => {
      const statement = kind
        ? db.prepare("DELETE FROM content_trials WHERE state <> 'running' AND kind = ?")
        : db.prepare("DELETE FROM content_trials WHERE state <> 'running'");
      return Number((kind ? statement.run(kind) : statement.run()).changes);
    });
  }

  /**
   * 実行中ジョブのレジストリを失った起動で `running` を `interrupted` へ倒す。再開はしない
   * (docs/api-settings.md)。終了時刻だけは判定時刻で埋め、所要時間は不明として NULL のままにする。
   */
  interruptRunningContentTrials(now: number): number {
    return this.#query(
      (db) =>
        db.prepare("UPDATE content_trials SET state = 'interrupted', finishedAt = ? WHERE state = 'running'").run(now)
          .changes as number,
    );
  }

  /**
   * 行が無ければ undefined。NOT NULL の列が欠けた行は、未登録と読み違えて上書きしないよう例外にする
   * (サービスが 503 へ変換し、DELETE だけは通す)。
   */
  readCloudflareSettings(): CloudflareSettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM cloudflare_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    const accountId = optionalText(row.accountId);
    const ciphertext = optionalBlob(row.ciphertext);
    const nonce = optionalBlob(row.nonce);
    const keyVersion = optionalNumber(row.keyVersion);
    if (!accountId || !ciphertext || !nonce || keyVersion === null || !Number.isInteger(keyVersion)) {
      throw new Error("cloudflare_settings row is incomplete");
    }
    return { accountId, ciphertext, nonce, keyVersion, updatedAt: Number(row.updatedAt) };
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。単一ステートメントなので自動コミットで確定する */
  saveCloudflareSettings(settings: CloudflareSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO cloudflare_settings (id, accountId, ciphertext, nonce, keyVersion, updatedAt)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET accountId = excluded.accountId, ciphertext = excluded.ciphertext,
             nonce = excluded.nonce, keyVersion = excluded.keyVersion, updatedAt = excluded.updatedAt`,
        )
        .run(settings.accountId, settings.ciphertext, settings.nonce, settings.keyVersion, settings.updatedAt),
    );
  }

  /** 行を消して未登録へ戻す。資格情報を消しても shared_contents の providerAccount は変えない */
  deleteCloudflareSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM cloudflare_settings WHERE id = 1").run().changes > 0);
  }

  /** 行が無ければ undefined = 既定（無効 / exa）。0 / 1 以外へ手編集された行も 1 として読む */
  readWebSearchSettings(): WebSearchSettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM web_search_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    return {
      enabled: Number(row.enabled) !== 0,
      provider: typeof row.provider === "string" ? row.provider : "",
    };
  }

  /** 保存は id = 1 の upsert。単一ステートメントなので自動コミットで確定する */
  saveWebSearchSettings(settings: WebSearchSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO web_search_settings (id, enabled, provider) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider`,
        )
        .run(settings.enabled ? 1 : 0, settings.provider),
    );
  }

  /** 行が無ければ undefined = 既定。空白だけの定義も既定として読む */
  readTitleSummarySettings(): TitleSummarySettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM title_summary_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    return {
      enabled: Number(row.enabled) !== 0,
      model: typeof row.model === "string" && row.model !== "" ? row.model : null,
      thinkingLevel: typeof row.thinkingLevel === "string" && row.thinkingLevel !== "" ? row.thinkingLevel : null,
      definition: typeof row.definition === "string" ? row.definition : "",
    };
  }

  /** 保存は id = 1 の upsert (web_search_settings と同じ形) */
  saveTitleSummarySettings(settings: TitleSummarySettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO title_summary_settings (id, enabled, model, thinkingLevel, definition) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, model = excluded.model,
             thinkingLevel = excluded.thinkingLevel, definition = excluded.definition`,
        )
        .run(settings.enabled ? 1 : 0, settings.model, settings.thinkingLevel, settings.definition),
    );
  }

  /** 行が無ければ undefined = 未設定。片方だけの行は壊れた保存値として未設定に倒す */
  readGitSettings(): GitSettingsRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM git_settings WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const userName = text(row.userName);
    const userEmail = text(row.userEmail);
    return userName && userEmail ? { userName, userEmail } : undefined;
  }

  /** 保存は id = 1 の upsert (title_summary_settings と同じ形)。両方揃った行だけを受ける */
  saveGitSettings(settings: GitSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO git_settings (id, userName, userEmail) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET userName = excluded.userName, userEmail = excluded.userEmail`,
        )
        .run(settings.userName, settings.userEmail),
    );
  }

  /** 未設定へ戻す。行が無いときも成功 (冪等) */
  clearGitSettings(): void {
    this.#query((db) => db.prepare("DELETE FROM git_settings WHERE id = 1").run());
  }

  /** 行が無ければ undefined。値は暗号文だけで、復号はサービス側が行う */
  readWebSearchProviderKey(provider: string): StoredAppSecret | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM web_search_provider_keys WHERE provider = ?").get(provider) as Row | undefined,
    );
    if (!row) return undefined;
    const secret = storedAppSecretOf(row, "web_search_provider_keys");
    if (!secret) throw new Error("web_search_provider_keys row is incomplete");
    return secret;
  }

  /** 登録と上書きで同じ (provider 主キーの upsert)。値は暗号化済みの保存形だけを受け取る */
  saveWebSearchProviderKey(provider: string, secret: StoredAppSecret): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO web_search_provider_keys (provider, ciphertext, nonce, keyVersion) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion`,
        )
        .run(provider, secret.ciphertext, secret.nonce, secret.keyVersion),
    );
  }

  /** 行を消して未設定へ戻す。未設定でも false を返すだけで失敗にはしない (復号不要) */
  deleteWebSearchProviderKey(provider: string): boolean {
    return this.#secretQuery(
      (db) => db.prepare("DELETE FROM web_search_provider_keys WHERE provider = ?").run(provider).changes > 0,
    );
  }

  /** 行が無ければ undefined。値は暗号文だけで、復号はサービス側が行う */
  readVoiceInputSettings(): VoiceInputSettingsRow | undefined {
    const row = this.#secretQuery(
      (db) => db.prepare("SELECT * FROM voice_input_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    const secret = storedAppSecretOf(row, "voice_input_settings");
    if (!secret) throw new Error("voice_input_settings row is incomplete");
    return secret;
  }

  /** 登録と上書きで同じ (id = 1 の upsert)。値は暗号化済みの保存形だけを受け取る */
  saveVoiceInputSettings(secret: VoiceInputSettingsRow): void {
    this.#secretQuery((db) =>
      db
        .prepare(
          `INSERT INTO voice_input_settings (id, ciphertext, nonce, keyVersion) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
             keyVersion = excluded.keyVersion`,
        )
        .run(secret.ciphertext, secret.nonce, secret.keyVersion),
    );
  }

  /** 行を消して未設定へ戻す。未設定でも false を返すだけで失敗にはしない (復号不要) */
  deleteVoiceInputSettings(): boolean {
    return this.#secretQuery((db) => db.prepare("DELETE FROM voice_input_settings WHERE id = 1").run().changes > 0);
  }

  /** 行が無い / 形が崩れているときは undefined（未取得として SDK カタログへ落とす。health の失敗にはしない） */
  readImageCatalog(): ImageCatalogRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM image_catalog WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const models = imageCatalogModelsOf(row.models);
    const fetchedAt = Number(row.fetchedAt);
    if (!models || !Number.isFinite(fetchedAt)) return undefined;
    return { fetchedAt, models };
  }

  /** 取得成功時の上書き (id = 1 の upsert)。キャッシュなので、失敗しても呼び出し側は続行する */
  saveImageCatalog(row: ImageCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO image_catalog (id, fetchedAt, models) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, models = excluded.models`,
        )
        .run(row.fetchedAt, JSON.stringify(row.models)),
    );
  }

  /** 行が無い / 形が崩れているときは undefined（未取得として同梱の既定カタログへ落とす。health の失敗にはしない） */
  readSpeechCatalog(): SpeechCatalogRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM speech_catalog WHERE id = 1").get() as Row | undefined);
    if (!row) return undefined;
    const models = speechCatalogModelsOf(row.models);
    const fetchedAt = Number(row.fetchedAt);
    if (!models || !Number.isFinite(fetchedAt)) return undefined;
    return { fetchedAt, models };
  }

  /** 行が無い / 空 URL の行は undefined（未設定。GET は OFF の投影を返す） */
  readContentCostSettings(): ContentCostSettingsRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM content_cost_settings WHERE id = 1").get() as Row | undefined,
    );
    if (!row) return undefined;
    const url = text(row.url);
    if (url === "") return undefined;
    return { enabled: Number(row.enabled) === 1, url };
  }

  /** id = 1 の upsert。URL を空にする保存は呼び出し側が行の削除にする */
  saveContentCostSettings(settings: ContentCostSettingsRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO content_cost_settings (id, enabled, url) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, url = excluded.url`,
        )
        .run(settings.enabled ? 1 : 0, settings.url),
    );
  }

  /** 行を消して未設定へ戻す（未設定でも false を返すだけで失敗にはしない） */
  deleteContentCostSettings(): boolean {
    return this.#query((db) => db.prepare("DELETE FROM content_cost_settings WHERE id = 1").run().changes > 0);
  }

  /** 行が無い / 形が崩れているときは undefined（未取得として `--` の表示へ倒す。health の失敗にはしない） */
  readContentCostCatalog(): ContentCostCatalogRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM content_cost_catalog WHERE id = 1").get() as Row | undefined,
    );
    return row ? contentCostCatalogOf(row) : undefined;
  }

  /** 取得成功時の上書き (id = 1 の upsert)。派生データなので、失敗しても前回値で続行する */
  saveContentCostCatalog(row: ContentCostCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO content_cost_catalog (id, fetchedAt, sourceUrl, version, models) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, sourceUrl = excluded.sourceUrl,
             version = excluded.version, models = excluded.models`,
        )
        .run(row.fetchedAt, row.sourceUrl, row.version, JSON.stringify(row.models)),
    );
  }

  /** 接続先の変更・解除で前回値を破棄する（別マスタの価格を現在値として出さない） */
  deleteContentCostCatalog(): void {
    this.#query((db) => db.prepare("DELETE FROM content_cost_catalog WHERE id = 1").run());
  }

  /** 行が無い / 形式が読めない行は undefined（未学習として mp3 から試す。health の失敗にはしない） */
  readSpeechFormat(model: string): SpeechAudioFormat | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT format FROM speech_formats WHERE model = ?").get(model) as Row | undefined,
    );
    if (!row) return undefined;
    const format = row.format;
    return format === "mp3" || format === "pcm" ? format : undefined;
  }

  /** 学習した形式の上書き (モデル行の upsert)。派生データなので、失敗しても生成結果は変えない */
  saveSpeechFormat(model: string, format: SpeechAudioFormat): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO speech_formats (model, format, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(model) DO UPDATE SET format = excluded.format, updatedAt = excluded.updatedAt`,
        )
        .run(model, format, Date.now()),
    );
  }

  /** 取得成功時の上書き (id = 1 の upsert)。キャッシュなので、失敗しても呼び出し側は続行する */
  saveSpeechCatalog(row: SpeechCatalogRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO speech_catalog (id, fetchedAt, models) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fetchedAt = excluded.fetchedAt, models = excluded.models`,
        )
        .run(row.fetchedAt, JSON.stringify(row.models)),
    );
  }

  listSpaces(): Space[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM spaces ORDER BY sortOrder, rowid").all() as Row[]).map((row) => ({
        id: text(row.id),
        name: text(row.name),
        createdAt: Number(row.createdAt),
      })),
    );
  }

  /** 追加は末尾 (MAX + 1)。削除で詰めないため、並びは追加順に安定する */
  insertSpace(space: Space): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO spaces (id, name, createdAt, sortOrder)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM spaces))`,
        )
        .run(space.id, space.name, space.createdAt),
    );
  }

  /** 表示名だけを書き換える。行が無ければ false (id・作成日時・sortOrder は触らない) */
  renameSpace(id: string, name: string): boolean {
    return this.#query((db) => db.prepare("UPDATE spaces SET name = ? WHERE id = ?").run(name, id).changes > 0);
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。
   * 採用する id の絞り込みは SpaceStore 側が行う (docs/api.md#スペース)。
   */
  reorderSpaces(ids: readonly string[]): void {
    this.transaction(() => {
      this.#query((db) => {
        const update = db.prepare("UPDATE spaces SET sortOrder = ? WHERE id = ?");
        ids.forEach((id, index) => update.run(index + 1, id));
      });
    });
  }

  /**
   * スペースの行と、その根を cwd に持つ行 (serve_commands / secrets) を 1 トランザクションで消す。
   * 前方一致は LIKE ではなく substr で行う (`%` / `_` を含む cwd で別の行を消さない)。戻り値は
   * `spaces` 行を消せたか (= commit point)。
   */
  deleteSpace(id: string): boolean {
    const dir = `${spaceDirRel(id)}/`;
    return this.transaction(() => {
      this.#query((db) => db.prepare("DELETE FROM serve_commands WHERE substr(cwd, 1, length(?)) = ?").run(dir, dir));
      this.#query((db) => db.prepare("DELETE FROM secrets WHERE substr(cwd, 1, length(?)) = ?").run(dir, dir));
      return this.#query((db) => db.prepare("DELETE FROM spaces WHERE id = ?").run(id).changes > 0);
    });
  }

  listProjects(): Project[] {
    return this.#query((db) => (db.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]).map(projectOf));
  }

  getProject(id: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  findProjectByCwd(cwd: string): Project | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM projects WHERE cwd = ?").get(cwd) as Row | undefined);
    return row ? projectOf(row) : undefined;
  }

  insertProject(project: Project): void {
    this.#query((db) =>
      db
        .prepare("INSERT INTO projects (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)")
        .run(project.id, project.name, project.cwd, project.createdAt),
    );
  }

  deleteProject(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0);
  }

  /** 表示順 (sortOrder 昇順)。移行前の行は NULL なので、同じ NULL 同士は rowid = 作成順で並ぶ */
  listAgents(): StoredAgent[] {
    return this.#query((db) => {
      const links = promptIdsByAgent(db);
      return (db.prepare("SELECT * FROM agents ORDER BY sortOrder, rowid").all() as Row[]).map((row) => {
        const ids = links.get(text(row.id)) ?? [];
        // 参照が無い行はキーごと省略する (未指定と [] を応答で区別しない)
        return ids.length ? { ...agentOf(row), promptIds: ids } : agentOf(row);
      });
    });
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。
   * 採用する id の絞り込みはカタログ側が行う (docs/api-catalog.md)。
   */
  reorderAgents(ids: readonly string[]): void {
    this.transaction(() => this.#reorderAgentsInTransaction(ids));
  }

  /** 既存のトランザクション内から呼ぶ本体。単体で呼ばない (BEGIN の入れ子を作らない) */
  #reorderAgentsInTransaction(ids: readonly string[]): void {
    this.#query((db) => {
      const update = db.prepare("UPDATE agents SET sortOrder = ? WHERE id = ?");
      ids.forEach((id, index) => update.run(index + 1, id));
    });
  }

  getAgent(id: string): StoredAgent | undefined {
    return this.#query((db) => {
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
      if (!row) return undefined;
      const ids = promptIdsByAgent(db, id).get(id) ?? [];
      return ids.length ? { ...agentOf(row), promptIds: ids } : agentOf(row);
    });
  }

  /**
   * 作成と更新で同じ (id が主キー)。**sortOrder は挿入のときだけ振る** (更新で `DO UPDATE SET` へ
   * 入れると、名前やアイコンの保存だけで位置が動く)。本体と参照の書き換えは 1 トランザクションで行い、
   * 途中で失敗したら部分適用を残さない。
   */
  saveAgent(agent: StoredAgent): void {
    this.transaction(() => this.#saveAgent(agent));
  }

  /** 既存のトランザクション内から呼ぶ本体 (移行など)。単体で呼ばない */
  #saveAgent(agent: StoredAgent): void {
    this.#query((db) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, systemPrompt, icon, model, thinkingLevel, commonSkillNames, builtinSkillNames, toolNames, allowNaturalInvocationBuiltin, allowNaturalInvocationFile, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM agents))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           systemPrompt = excluded.systemPrompt, icon = excluded.icon, model = excluded.model,
           thinkingLevel = excluded.thinkingLevel,
           commonSkillNames = excluded.commonSkillNames, builtinSkillNames = excluded.builtinSkillNames,
           toolNames = excluded.toolNames,
           allowNaturalInvocationBuiltin = excluded.allowNaturalInvocationBuiltin,
           allowNaturalInvocationFile = excluded.allowNaturalInvocationFile`,
      ).run(
        agent.id,
        agent.name,
        agent.description,
        agent.systemPrompt,
        agent.icon ?? null,
        agent.model ? JSON.stringify(agent.model) : null,
        agent.thinkingLevel ?? null,
        // 未指定は NULL、`[]` は "[]" (undefined と [] を混同しない)
        agent.commonSkillNames === undefined ? null : JSON.stringify(agent.commonSkillNames),
        agent.builtinSkillNames === undefined ? null : JSON.stringify(agent.builtinSkillNames),
        agent.toolNames === undefined ? null : JSON.stringify(agent.toolNames),
        // false だけ 0 を書き、true / 未指定は NULL (既定) へ寄せる。2 列は独立
        agent.allowNaturalInvocationBuiltin === false ? 0 : null,
        agent.allowNaturalInvocationFile === false ? 0 : null,
      );
      // 参照は丸ごと差し替える。position は並びそのもので、重複・上限は DB の制約でも守る
      db.prepare("DELETE FROM agent_prompts WHERE agentId = ?").run(agent.id);
      const insert = db.prepare("INSERT INTO agent_prompts (agentId, promptId, position) VALUES (?, ?, ?)");
      (agent.promptIds ?? []).forEach((promptId, index) => insert.run(agent.id, promptId, index + 1));
    });
  }

  deleteAgent(id: string): boolean {
    // 参照 (agent_prompts) は外部キーの ON DELETE CASCADE で一緒に消え、マスタは残る
    return this.#query((db) => db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0);
  }

  /**
   * 一覧の並びは組み込みが先、その中は作成順。自作は保存した sortOrder の昇順で、未設定 (移行前の行) は
   * NULL が先に並ぶため作成順のまま、後から追加した行が末尾に付く (ID は不透明なのでソートキーにしない)。
   */
  listPrompts(): PromptRow[] {
    return this.#query((db) =>
      (
        db
          .prepare("SELECT * FROM prompts ORDER BY CASE kind WHEN 'builtin' THEN 0 ELSE 1 END, sortOrder, rowid")
          .all() as Row[]
      ).map(promptOf),
    );
  }

  getPrompt(id: string): PromptRow | undefined {
    const row = this.#query((db) => db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as Row | undefined);
    return row ? promptOf(row) : undefined;
  }

  /** 自作の追加は末尾。sortOrder の最大 + 1 を振る (組み込みは NULL なので数に入らない) */
  insertPrompt(row: PromptRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO prompts (id, kind, label, prompt, sortOrder)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM prompts))`,
        )
        .run(row.id, row.kind, row.label, row.prompt),
    );
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。
   * 採用する id の絞り込みはカタログ側が行う (docs/api-catalog.md)。
   */
  reorderPrompts(ids: readonly string[]): void {
    this.transaction(() => this.#reorderPromptsInTransaction(ids));
  }

  /** 既存のトランザクション内から呼ぶ本体。単体で呼ばない (BEGIN の入れ子を作らない) */
  #reorderPromptsInTransaction(ids: readonly string[]): void {
    this.#query((db) => {
      const update = db.prepare("UPDATE prompts SET sortOrder = ? WHERE id = ?");
      ids.forEach((id, index) => update.run(index + 1, id));
    });
  }

  /** 組み込み行は編集しない (条件に入れて、サービス側の判定が漏れても行が変わらないようにする) */
  updatePrompt(row: PromptRow): boolean {
    return this.#query(
      (db) =>
        db
          .prepare("UPDATE prompts SET label = ?, prompt = ? WHERE id = ? AND kind = 'custom'")
          .run(row.label, row.prompt, row.id).changes > 0,
    );
  }

  /** 使用中の行は外部キー (ON DELETE RESTRICT) でも消せない。戻り値は消せたか */
  deletePrompt(id: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM prompts WHERE id = ? AND kind = 'custom'").run(id).changes > 0);
  }

  /**
   * バックアップの差分適用。同一行は呼び出し側が除き、ここは「削除するエージェント → プロンプトの
   * upsert → エージェントの upsert → 削除するプロンプト → 並べ替え」の順で 1 トランザクションに閉じる。
   * この順序でないと `agent_prompts.promptId` の ON DELETE RESTRICT に当たる (docs/backup.md)。
   */
  applyDefinitions(batch: {
    deleteAgentIds: readonly string[];
    promptUpserts: readonly PromptRow[];
    agentUpserts: readonly StoredAgent[];
    deletePromptIds: readonly string[];
    agentOrder: readonly string[];
    promptOrder: readonly string[];
  }): void {
    this.transaction(() => {
      for (const id of batch.deleteAgentIds) {
        this.#query((db) => db.prepare("DELETE FROM agents WHERE id = ?").run(id));
      }
      for (const row of batch.promptUpserts) this.#upsertPromptInTransaction(row);
      for (const agent of batch.agentUpserts) this.#saveAgent(agent);
      for (const id of batch.deletePromptIds) {
        this.#query((db) => db.prepare("DELETE FROM prompts WHERE id = ? AND kind = 'custom'").run(id));
      }
      if (batch.agentOrder.length > 0) this.#reorderAgentsInTransaction(batch.agentOrder);
      if (batch.promptOrder.length > 0) this.#reorderPromptsInTransaction(batch.promptOrder);
    });
  }

  /** 組み込み行は書き換えない (条件で守り、サービス側の判定が漏れても定義が変わらないようにする) */
  #upsertPromptInTransaction(row: PromptRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO prompts (id, kind, label, prompt, sortOrder)
           VALUES (?, 'custom', ?, ?, (SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM prompts))
           ON CONFLICT(id) DO UPDATE SET label = excluded.label, prompt = excluded.prompt
           WHERE prompts.kind = 'custom'`,
        )
        .run(row.id, row.label, row.prompt),
    );
  }

  /**
   * 全削除。エージェントを先に消し、その後で自作プロンプトを消す (残った紐づけで RESTRICT に当たらない)。
   * ユーザー定義 (サンプルを含む) だけが対象で、組み込みプロンプトには触らない。
   */
  deleteAllDefinitions(): { agents: number; prompts: number } {
    return this.transaction(() => {
      const agents = this.#query((db) => Number(db.prepare("DELETE FROM agents").run().changes));
      const prompts = this.#query((db) =>
        Number(db.prepare("DELETE FROM prompts WHERE kind = 'custom'").run().changes),
      );
      return { agents, prompts };
    });
  }

  /** 全マスタの使用先 (エージェント ID とマスタ ID の組)。一覧の `usedBy` を 1 クエリで組む */
  listAgentPromptLinks(): { agentId: string; promptId: string }[] {
    return this.#query((db) =>
      (db.prepare("SELECT agentId, promptId FROM agent_prompts ORDER BY agentId, position").all() as Row[]).map(
        (row) => ({ agentId: text(row.agentId), promptId: text(row.promptId) }),
      ),
    );
  }

  getServeCommand(cwd: string): ServeCommandRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM serve_commands WHERE cwd = ?").get(cwd) as Row | undefined,
    );
    return row ? serveCommandOf(row) : undefined;
  }

  /** 成功した起動だけを記録する (失敗したコマンドで以前の成功を上書きしない) */
  saveServeCommand(row: ServeCommandRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO serve_commands (cwd, command, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT(cwd) DO UPDATE SET command = excluded.command, updatedAt = excluded.updatedAt`,
        )
        .run(row.cwd, row.command, row.updatedAt),
    );
  }

  /** 表示順 (sortOrder 昇順、同じなら名前順)。`serve_commands` と同じく cwd がキー */
  listSecrets(cwd: string): SecretRow[] {
    return this.#query((db) =>
      (db.prepare("SELECT * FROM secrets WHERE cwd = ? ORDER BY sortOrder ASC, name ASC").all(cwd) as Row[]).map(
        secretOf,
      ),
    );
  }

  getSecret(secretId: string): SecretRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM secrets WHERE secretId = ?").get(secretId) as Row | undefined,
    );
    return row ? secretOf(row) : undefined;
  }

  /** 同じ cwd 内の一意性判定 (UNIQUE(cwd, name) の事前確認。cwd が違えば同名を許す) */
  findSecretByName(cwd: string, name: string): SecretRow | undefined {
    const row = this.#query(
      (db) => db.prepare("SELECT * FROM secrets WHERE cwd = ? AND name = ?").get(cwd, name) as Row | undefined,
    );
    return row ? secretOf(row) : undefined;
  }

  /** 追加は MAX(sortOrder) + 1。削除で詰めないため、並びは追加順に安定する */
  nextSecretSortOrder(cwd: string): number {
    const row = this.#query(
      (db) => db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS next FROM secrets WHERE cwd = ?").get(cwd) as Row,
    );
    return Number(row.next);
  }

  /**
   * 並べ替え。与えた順に 1..n を振り直す (途中で失敗したら 1 つも書かない)。cwd も条件に入れ、
   * 他会話の secret_id が混ざっても並びを動かさない。採用する id の絞り込みは `SecretService` が行う。
   */
  reorderSecrets(cwd: string, ids: readonly string[]): void {
    this.transaction(() => {
      this.#query((db) => {
        const update = db.prepare("UPDATE secrets SET sortOrder = ? WHERE secretId = ? AND cwd = ?");
        ids.forEach((id, index) => update.run(index + 1, id, cwd));
      });
    });
  }

  /** 値は必ずバインドして渡す (SQL 文字列へ埋め込まない)。単一ステートメントなので自動コミットで確定する */
  insertSecret(row: SecretRow): void {
    this.#query((db) =>
      db
        .prepare(
          `INSERT INTO secrets (secretId, cwd, name, kind, plaintext, ciphertext, nonce, keyVersion, sortOrder, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.secretId,
          row.cwd,
          row.name,
          row.kind,
          row.plaintext,
          row.ciphertext,
          row.nonce,
          row.keyVersion,
          row.sortOrder,
          row.createdAt,
          row.updatedAt,
        ),
    );
  }

  /** 値の上書きのみ (名前・種別・並びは変えない)。使わない列は null にして種別の排他を保つ */
  updateSecretValue(
    secretId: string,
    patch: {
      plaintext: string | null;
      ciphertext: Uint8Array | null;
      nonce: Uint8Array | null;
      keyVersion: number | null;
      updatedAt: number;
    },
  ): void {
    this.#query((db) =>
      db
        .prepare(
          `UPDATE secrets SET plaintext = ?, ciphertext = ?, nonce = ?, keyVersion = ?, updatedAt = ? WHERE secretId = ?`,
        )
        .run(patch.plaintext, patch.ciphertext, patch.nonce, patch.keyVersion, patch.updatedAt, secretId),
    );
  }

  deleteSecret(secretId: string): boolean {
    return this.#query((db) => db.prepare("DELETE FROM secrets WHERE secretId = ?").run(secretId).changes > 0);
  }

  /**
   * 保存は (session_id, assistant_id) の upsert。**best-effort** で、失敗しても例外を投げない
   * (呼び出し側はランを止めない)。単一ステートメントなので自動コミットで確定する。
   */
  recordAssistantMetrics(row: AssistantMetricsRow): void {
    this.#metricsQuery((db) =>
      db
        .prepare(
          `INSERT INTO assistant_metrics
             (session_id, assistant_id, at, provider, model, duration_ms, ttft_ms, input_tokens, output_tokens,
              cache_read, cache_write, reasoning_tokens, cost_usd, stop_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, assistant_id) DO UPDATE SET at = excluded.at, provider = excluded.provider,
             model = excluded.model, duration_ms = excluded.duration_ms, ttft_ms = excluded.ttft_ms,
             input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
             cache_read = excluded.cache_read, cache_write = excluded.cache_write,
             reasoning_tokens = excluded.reasoning_tokens, cost_usd = excluded.cost_usd,
             stop_reason = excluded.stop_reason`,
        )
        .run(
          row.sessionId,
          row.assistantId,
          row.at,
          row.provider,
          row.model,
          row.durationMs,
          row.ttftMs,
          row.inputTokens,
          row.outputTokens,
          row.cacheRead,
          row.cacheWrite,
          row.reasoningTokens,
          row.costUsd,
          row.stopReason,
        ),
    );
  }

  /** 読めないときは空で返す (メタが出ないだけで会話は開ける)。行は `at` の昇順 */
  loadAssistantMetrics(sessionId: string): AssistantMetricsRow[] {
    const rows = this.#metricsQuery(
      (db) =>
        db
          .prepare("SELECT * FROM assistant_metrics WHERE session_id = ? ORDER BY at, assistant_id")
          .all(sessionId) as Row[],
    );
    return rows?.map(assistantMetricsOf) ?? [];
  }

  /** セッションの行をまとめて消す。失敗しても孤児行が残るだけで、セッションの削除は成功させる */
  deleteAssistantMetrics(sessionId: string): void {
    this.#metricsQuery((db) => db.prepare("DELETE FROM assistant_metrics WHERE session_id = ?").run(sessionId));
  }

  /**
   * cwd をキーにする行 (secrets / serve_commands) を移動先へ付け替える。移動先に同名の行があると
   * UNIQUE 制約で失敗するため、部分適用を残さないよう 1 トランザクションで行う。
   */
  moveCwd(from: string, to: string): void {
    this.transaction(() => {
      this.#query((db) => db.prepare("UPDATE serve_commands SET cwd = ? WHERE cwd = ?").run(to, from));
      this.#query((db) => db.prepare("UPDATE secrets SET cwd = ? WHERE cwd = ?").run(to, from));
    });
  }
}
