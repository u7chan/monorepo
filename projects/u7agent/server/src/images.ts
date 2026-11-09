/**
 * 画像生成の薄い関数。provider の選択と失敗の分類をこの 1 箇所へ閉じ、
 * 将来 OpenAI を足すときは models の差し替えで済ませる（docs/image-generation.md）。
 *
 * 送信先は OpenRouter の画像専用 API（`POST {baseUrl}/images`）。SDK の openrouter-images は
 * chat/completions へ投げるが、画像生成専用モデルはそちらでは 404 になり `/images` でしか
 * 受け付けない。カタログだけ SDK を使い、要求は自前で組む。
 */
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  classifyProviderFailure,
  parseJsonBody,
  providerMessageOf,
  type ProviderFailureCode,
  type ProviderFailureContext,
  type ProviderFailureMessages,
} from "./provider-failure";
import type { SpeechGenerationSettings } from "./speech";
import type { BgmGenerationSettings } from "./bgm";
import type { ImageParameterValues } from "./schema";

/** 失敗の公開分類。分類の規則と provider メッセージの扱いは provider-failure.ts を正とする */
export type ImageFailureCode = ProviderFailureCode;

export interface GeneratedImage {
  mimeType: string;
  /** base64 */
  data: string;
}

export type ImageGenerationResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; code: ImageFailureCode; message: string };

/**
 * 参照画像入力の宣言。live 一覧の `architecture.input_modalities` と
 * `supported_parameters.input_references`、`endpoints`（endpoint 一覧の URL）から読み、
 * 無い項目は「不明」として残す（`server/src/image-catalog.ts` が課金前に判定する）。
 */
export interface ImageInputDeclaration {
  /** 入力モダリティ。`image` を含むときだけ画像入力を宣言している */
  modalities?: string[] | undefined;
  /** 参照枚数の許容範囲。1 枚が範囲に入るときだけ 1 枚の編集を宣言している */
  references?: { min: number; max: number } | undefined;
  /** endpoint 一覧の URL（絶対 / 相対）。省略時は慣例パスを編集実行時に引く */
  endpoints?: string[] | undefined;
}

/**
 * 生成パラメータの名前。この 6 つ以外は宣言ごと落とす（UI の語彙と送信本文のキーを勝手に増やさない）。
 * 宣言の値は `enum` / `range` / `boolean` の 3 種類だけで表す。
 */
export const IMAGE_PARAMETER_NAMES = [
  "aspect_ratio",
  "resolution",
  "quality",
  "output_format",
  "background",
  "seed",
] as const;

export type ImageParameterName = (typeof IMAGE_PARAMETER_NAMES)[number];

/** 宣言 1 件。`boolean` は「そのパラメータを受け付ける」の意味で、値そのものは boolean で送らない */
export type ImageParameterDescriptor =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

/** モデルが宣言する生成パラメータ。読めなかった項目は載せない（不在 = 不明） */
export type ImageParameterDeclarations = Partial<Record<ImageParameterName, ImageParameterDescriptor>>;

/** seed に受け付ける上限。宣言がこれを超えていても、送る値はこの範囲へ収める */
export const IMAGE_PARAMETER_SEED_MAX = 2 ** 31 - 1;

/** カタログ 1 件。UI の選択肢と model の検証はこの一覧を正とする */
export interface ImageCatalogEntry {
  provider: string;
  id: string;
  name: string;
  /**
   * live 一覧が宣言する生成パラメータ（`supported_parameters`）。宣言が無い / 形が違うときは載せない
   * （＝不明）。画面はこれを見て選択肢を描き、送信本文と生成前検証はこの宣言だけを見る。
   */
  parameters?: ImageParameterDeclarations | undefined;
  /**
   * live 一覧が宣言する出力形式（`supported_parameters.output_format.values`）。宣言が無い / 形が違うときは
   * 載せない（＝形式は不明）。SDK 同梱カタログと、この項目より前に書かれたキャッシュがこれにあたる。
   */
  outputFormats?: string[] | undefined;
  /** live 一覧が宣言する画像入力の能力。宣言が無い / 形が違うときは「不明」として載せない */
  input?: ImageInputDeclaration | undefined;
}

/** 参照画像入力の可否。宣言の不在（不明）と、宣言された非対応を区別する */
export type ImageInputSupport = "supported" | "unsupported" | "unknown";

/**
 * 宣言だけから見た 1 枚の参照画像入力の可否。画像入力の可否はモダリティで、参照枚数は range で確かめ、
 * どちらかが読めなければ「不明」にする（不明は編集を止めるが新規生成は止めない）。
 */
export function imageInputSupportOf(input: ImageInputDeclaration | undefined): ImageInputSupport {
  if (!input) return "unknown";
  if (input.modalities && !input.modalities.includes("image")) return "unsupported";
  const references = input.references;
  if (references && (references.max < 1 || references.min > 1)) return "unsupported";
  if (!input.modalities || !references) return "unknown";
  return "supported";
}

/** 保存できる画像形式の拡張子。`imageExtensionFor` の戻り値と一致させる */
export type SaveableImageFormat = "png" | "jpeg" | "webp";

/**
 * 形式の表記を保存できる形式へ寄せる。宣言（live の `output_format`）は短い名前で、応答の media_type は
 * mimeType で来るため、両方を受けて保存側と判定を揃える。`image/jpg` は provider 側の揺れとして jpeg にする。
 */
export function saveableImageFormat(value: string): SaveableImageFormat | undefined {
  const normalized = value.toLowerCase().split(";")[0]?.trim();
  if (normalized === "png" || normalized === "image/png") return "png";
  if (normalized === "jpeg" || normalized === "jpg" || normalized === "image/jpeg" || normalized === "image/jpg") {
    return "jpeg";
  }
  if (normalized === "webp" || normalized === "image/webp") return "webp";
  return undefined;
}

/**
 * 保存できない形式だけを宣言していると「分かっている」か。宣言が無い / 空（＝不明）のときは false = 止めない。
 * 一覧の絞り込みと生成前ガードの両方がこの 1 つを使い、保存側の `imageExtensionFor` と同じ表を見る。
 */
export function isUnsaveableOutputOnly(outputFormats: readonly string[] | undefined): boolean {
  if (!outputFormats || outputFormats.length === 0) return false;
  return !outputFormats.some((format) => saveableImageFormat(format) !== undefined);
}

/**
 * enum の `values` を読む。`output_format` だけは保存できる形式との積にし、積が空なら「宣言なし」に倒す
 * （保存できない形式しか選べない宣言を通すと、`isUnsaveableOutputOnly` の判定と食い違う）。
 */
function enumValuesOf(name: ImageParameterName, values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const strings = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (name !== "output_format") return strings.length > 0 ? strings : undefined;
  const formats = strings
    .map((value) => saveableImageFormat(value))
    .filter((format): format is SaveableImageFormat => format !== undefined);
  const unique = [...new Set(formats)];
  return unique.length > 0 ? unique : undefined;
}

/** `{ type: "range", min, max }` を整数の閉区間として読む。seed は受け付ける範囲で切る */
function rangeOf(name: ImageParameterName, value: object): { min: number; max: number } | undefined {
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return undefined;
  if (name !== "seed") return { min, max };
  const bounded = { min: Math.max(min, 0), max: Math.min(max, IMAGE_PARAMETER_SEED_MAX) };
  return bounded.min <= bounded.max ? bounded : undefined;
}

/** 宣言 1 件を読む。形が違う / 値が空の descriptor は undefined（＝不明） */
function descriptorOf(name: ImageParameterName, value: unknown): ImageParameterDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type } = value as { type?: unknown };
  if (type === "boolean") return { type: "boolean" };
  if (type === "enum") {
    const values = enumValuesOf(name, (value as { values?: unknown }).values);
    return values ? { type: "enum", values } : undefined;
  }
  if (type === "range") {
    const range = rangeOf(name, value);
    return range ? { type: "range", ...range } : undefined;
  }
  return undefined;
}

/**
 * 宣言の JSON を正規化する。live の `supported_parameters` とキャッシュの `parameters` の両方をこれで読み、
 * 未知のキー・形違い・空の values を落とし、1 つも読めなければ undefined（＝不明）にする。
 */
export function imageParameterDeclarationsOf(value: unknown): ImageParameterDeclarations | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const declarations: ImageParameterDeclarations = {};
  for (const name of IMAGE_PARAMETER_NAMES) {
    const descriptor = descriptorOf(name, (value as Record<string, unknown>)[name]);
    if (descriptor) declarations[name] = descriptor;
  }
  return Object.keys(declarations).length > 0 ? declarations : undefined;
}

/** 明示された値の検証結果。宣言に無い / 値が宣言の外なら理由を返し、送信本文を組ませない */
export type ImageParameterValidation = { ok: true; values: ImageParameterValues } | { ok: false; message: string };

/** 1 つの値が宣言に収まるか。`boolean` は受け付けるの意味なので、値そのものは縛らない */
function imageParameterValueAllowed(
  name: ImageParameterName,
  descriptor: ImageParameterDescriptor,
  value: string | number,
): boolean {
  if (descriptor.type === "boolean") return true;
  if (descriptor.type === "enum") return typeof value === "string" && descriptor.values.includes(value);
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (name === "seed" && (value < 0 || value > IMAGE_PARAMETER_SEED_MAX)) return false;
  return value >= descriptor.min && value <= descriptor.max;
}

/**
 * 既定値（保存値）のうち、モデルの宣言に収まるキーだけを残す。宣言が読めないモデルでは 1 つも残さない。
 * 利用者が明示した値ではないので、落としたキーで生成を止めず provider の既定へ委ねる。
 */
export function declaredImageParameters(
  declarations: ImageParameterDeclarations | undefined,
  values: ImageParameterValues | undefined,
): ImageParameterValues {
  const kept: ImageParameterValues = {};
  if (!declarations) return kept;
  for (const name of IMAGE_PARAMETER_NAMES) {
    const value = values?.[name];
    const descriptor = declarations[name];
    if (value === undefined || !descriptor) continue;
    if (!imageParameterValueAllowed(name, descriptor, value)) continue;
    // name ごとに値の型が違う（seed だけ数値）ため、検証済みの 1 キーをそのまま写す
    Object.assign(kept, { [name]: value });
  }
  return kept;
}

/**
 * 明示された値をモデルの宣言と突き合わせる。宣言の無いモデル・宣言に無いキー・宣言の外の値は通さない
 * （不明は送らない）。通った値はそのまま送信本文の材料になる。
 */
export function normalizeImageParameters(
  declarations: ImageParameterDeclarations | undefined,
  values: ImageParameterValues | undefined,
): ImageParameterValidation {
  if (!values) return { ok: true, values: {} };
  for (const name of IMAGE_PARAMETER_NAMES) {
    const value = values[name];
    if (value === undefined) continue;
    const descriptor = declarations?.[name];
    if (!descriptor) return { ok: false, message: `${name} はこの画像モデルでは指定できません` };
    if (!imageParameterValueAllowed(name, descriptor, value)) {
      return { ok: false, message: `${name} に指定できない値です: ${String(value)}` };
    }
  }
  return { ok: true, values };
}

/**
 * 送信本文へ足す値。省略された値は載せない（未指定のときの本文を従来と同一に保ち、provider の既定に任せる）。
 */
export function imageParameterBody(
  values: ImageParameterValues | undefined,
): Partial<Record<ImageParameterName, string | number>> {
  const body: Partial<Record<ImageParameterName, string | number>> = {};
  if (!values) return body;
  for (const name of IMAGE_PARAMETER_NAMES) {
    const value = values[name];
    if (value !== undefined) body[name] = value;
  }
  return body;
}

/** 画像生成の provider。既定は openrouter。Codex は設定で明示的に選んだときだけ使う */
export const IMAGE_PROVIDER_ID = "openrouter";

/**
 * 画像の生成元。provider 間の自動フォールバック・自動再送はしない（片方の失敗を他方で隠さない）。
 * Codex は画像モデルを選ばせず、ルーティングモデルも画像モデルとして見せない。
 */
export const IMAGE_GENERATION_PROVIDERS = [IMAGE_PROVIDER_ID, "codex"] as const;
export type ImageProviderId = (typeof IMAGE_GENERATION_PROVIDERS)[number];
export const DEFAULT_IMAGE_PROVIDER: ImageProviderId = IMAGE_PROVIDER_ID;

export function isImageProviderId(value: string): value is ImageProviderId {
  return (IMAGE_GENERATION_PROVIDERS as readonly string[]).includes(value);
}

/** 画像の認証状態。GET は保存値の読取だけで判定し、トークン解決も外部通信もしない */
export type ImageAuthState = "configured" | "missing" | "expired";
export type ImageAuthKind = "api_key" | "oauth";

export interface ImageAuthStatus {
  state: ImageAuthState;
  /** provider が求める認証の種類。未設定でも「何を入れれば使えるか」を出すために返す */
  kind: ImageAuthKind | null;
}

/**
 * 画像ツールを公開しない理由。`no_key` は OpenRouter キー未登録、`no_auth` は Codex のサインインが無い
 * （APIキーを求めない provider でキー登録を促さないため、理由を分ける）。
 */
export type ImageToolUnavailableReason = "no_key" | "no_auth" | "app_disabled";

/** 画像ツールの実効と、止まっている理由。公開中は `reason` が null */
export interface ImageToolAvailability {
  enabled: boolean;
  reason: ImageToolUnavailableReason | null;
}

/** Codex の実行時認証。値はログ・応答・結果本文へ出さない */
export interface CodexAuth {
  /** リクエストの Authorization に使うアクセストークン */
  access: string;
  /** `chatgpt-account-id` ヘッダの値 */
  accountId: string;
}

/** Codex は画像モデルを返さないため、モデル行に出す固定の表示名（ルーティングモデルを偽らない） */
export const CODEX_IMAGE_MODEL_LABEL = "Codex（画像モデル不明）";

export const CODEX_AUTH_UNAVAILABLE_MESSAGE =
  "Codex の認証を確認できませんでした。設定 → モデル で openai-codex にサインインしてください（画像は生成しておらず、クレジットも消費していません）";

export interface OpenRouterImageGenerationSettings {
  provider: typeof IMAGE_PROVIDER_ID;
  model: string;
  apiKey: string;
  /**
   * 保存済みの生成パラメータの既定（キー単位）。宣言との突き合わせは使う側（ツール）が
   * `declaredImageParameters` で行う。Codex は既定を持たない（同じ map を共有しない）。
   */
  parameters?: ImageParameterValues | undefined;
}

export interface CodexImageGenerationSettings {
  provider: "codex";
  /** 実行時に openai-codex の認証を解決する。無ければ undefined（呼ぶ前に固定文言で止める） */
  resolveAuth: () => Promise<CodexAuth | undefined>;
}

/**
 * 実行のたびに読み直す現在の設定。provider ごとに要求する認証が違うが、その分岐はここで吸収する
 * （DB の列をそのままツールへ渡さない）。
 */
export type ImageGenerationSettings = OpenRouterImageGenerationSettings | CodexImageGenerationSettings;

/**
 * PiBff へ注入する有効状態と読取口。`enabled` はセッション作成時のツール一覧に使い、実行時の
 * 課金前チェックは `disabled`（設定のトグルだけ）を見る。
 */
export interface ContentGenerationConfig {
  /** ツールを公開してよいか。キーの行があり、かつ設定が ON のときだけ true（セッション作成時の一覧用） */
  enabled: boolean;
  /** キーの行があるか。止まっている理由をキー未設定と設定 OFF で書き分けるために持つ */
  configured: boolean;
  /**
   * 設定のトグルが OFF か（行があり enabled = false）。キー未設定では false のままにして、
   * 実行時は `readSettings()` のキー無効エラーへ落とす（「無効化」と誤案内しない）
   */
  disabled: boolean;
  /**
   * 画像ツールの実効と理由。音声 / BGM の `enabled` と違い、選択 provider の認証を呼ぶたびに読む
   * （Codex のサインインは設定画面を開き直しても `setContentGeneration` を呼ばないため）
   */
  imageAvailability: () => ImageToolAvailability;
  /** 実行のたびに現在の設定を読む。生成元が Codex のときも undefined にしない（キーは要らない） */
  read: () => ImageGenerationSettings | undefined;
  /**
   * 実行のたびにカタログの形式宣言を引く。未知名・宣言なし（SDK 同梱カタログなど）は undefined。
   * 保存できる形式を 1 つも宣言していないモデルを provider へ送る前に止めるために使う。
   */
  readOutputFormats: (model: string) => readonly string[] | undefined;
  /**
   * 実行のたびにカタログのパラメータ宣言を引く。未知名・宣言なしは undefined（＝不明）。
   * 明示された引数を provider へ送る前に宣言と突き合わせるために使う。
   */
  readParameters: (model: string) => ImageParameterDeclarations | undefined;
  /**
   * 参照画像による編集が可能かを課金前に確かめる。可能なら undefined、止めるときは理由の文言を返す
   * （モデル宣言と endpoint 宣言の両方を見る）。新規生成はここを通らない。
   */
  checkImageInput: (model: string, signal?: AbortSignal | undefined) => Promise<string | undefined>;
  /** 実行のたびに現在の音声設定を読む。行が無ければ undefined（未設定・削除後） */
  readSpeech: () => SpeechGenerationSettings | undefined;
  readBgm: () => BgmGenerationSettings | undefined;
  /** 実行のたびにカタログの話者の宣言を引く。未知名・宣言なしは undefined（＝止めない） */
  readVoices: (model: string) => readonly string[] | undefined;
}

/** 生成要求の共通部分。provider ごとに認証の形だけが違う */
export interface ImageRequestBase {
  prompt: string;
  /**
   * 明示された生成パラメータ。省略した値は送信本文へ載せず、provider の既定に任せる。
   * 宣言との突き合わせは `normalizeImageParameters` で済ませてから渡す。
   */
  parameters?: ImageParameterValues | undefined;
  /** ユーザー中断。timeout の自前タイマーとは別に扱う */
  signal?: AbortSignal | undefined;
  /**
   * 参照画像（検証済みの data URL）。空 / 省略なら従来どおりの新規生成で、送信 JSON に
   * `input_references` を付けない。値はツール引数・結果・ログへ出さない。
   */
  inputReferences?: readonly string[] | undefined;
}

/** 画像生成器（OpenRouter の `/images`）が受ける要求。provider はカタログの id で、テストは stub を差し込む */
export type ImageGenerationRequest = ImageRequestBase & { provider: string; model: string; apiKey: string };

/**
 * アプリが生成器へ渡す要求。Codex は画像モデルを選ばず、認証もキー文字列ではなく実行時に解決したものを渡す
 * （provider で判別できる共用体にする）。
 */
export type ImageGenerationInput =
  | (ImageRequestBase & { provider: typeof IMAGE_PROVIDER_ID; model: string; apiKey: string })
  | (ImageRequestBase & { provider: "codex"; auth: CodexAuth });

export interface ImagesGeneratorOptions {
  /** テストで stub カタログを注入する。既定は SDK 同梱の画像モデル（openrouter のみ） */
  models?: () => readonly ImageModel<ImageApi>[];
  /** provider リクエストの期限。SDK 側の期限は渡さず、このタイマーだけに一本化する */
  timeoutMs?: number;
  /** provider メッセージをログ・応答へ出す前の境界 */
  maskText?: (text: string) => string;
  /** テストで差し替える fetch（provider へそのまま渡す） */
  fetchImpl?: typeof fetch;
}

export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;

/**
 * 応答本文の上限。base64 の JSON は画像の約 4/3 倍になるため、保存上限に余裕を足した値にし、
 * 大きすぎる応答は画像として読む前に打ち切る（保存側の上限と二重に止める）。
 */
export const IMAGE_RESPONSE_MAX_BYTES = 24 * 1024 * 1024;

export const IMAGE_RESPONSE_TOO_LARGE_MESSAGE = "画像生成の応答が大きすぎます";

export const IMAGE_API_KEY_INVALID_MESSAGE = "画像APIキーが無効です。設定を確認してください";
export const IMAGE_INSUFFICIENT_CREDIT_MESSAGE = "画像生成の残高が不足しています";
export const IMAGE_RATE_LIMITED_MESSAGE = "画像生成が混雑しています（レート制限またはプロバイダー障害）";
export const IMAGE_TIMEOUT_MESSAGE = "画像生成がタイムアウトしました";
export const IMAGE_ABORTED_MESSAGE = "画像生成を中断しました";
export const IMAGE_UNKNOWN_FAILURE_MESSAGE = "画像生成に失敗しました";

const IMAGE_FAILURE_MESSAGES: ProviderFailureMessages = {
  invalidKey: IMAGE_API_KEY_INVALID_MESSAGE,
  insufficientCredit: IMAGE_INSUFFICIENT_CREDIT_MESSAGE,
  rateLimited: IMAGE_RATE_LIMITED_MESSAGE,
  timeout: IMAGE_TIMEOUT_MESSAGE,
  aborted: IMAGE_ABORTED_MESSAGE,
  unknown: IMAGE_UNKNOWN_FAILURE_MESSAGE,
};

/**
 * 本文を上限まで読む。超えたら本文を捨てて undefined を返す（大きな応答をメモリへ載せない）。
 * content-length は当てにならない応答もあるため、宣言と実バイトの両方で見る。
 */
async function readCappedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** media_type が読めないときの画像形式。OpenRouter は識別できるときだけ返す */
const DEFAULT_IMAGE_MIME_TYPE = "image/png";

/** 画像本体を取り出す。media_type は data の各件 → 応答全体 → png の順に落とす */
function imageOf(body: unknown): GeneratedImage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const fallback = (body as { media_type?: unknown }).media_type;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { b64_json: encoded, media_type: mimeType } = entry as { b64_json?: unknown; media_type?: unknown };
    if (typeof encoded !== "string" || encoded === "") continue;
    const resolved =
      typeof mimeType === "string" && mimeType !== ""
        ? mimeType
        : typeof fallback === "string" && fallback !== ""
          ? fallback
          : DEFAULT_IMAGE_MIME_TYPE;
    return { mimeType: resolved, data: encoded };
  }
  return undefined;
}

/**
 * 失敗の分類。画像 0 件は失敗として扱い、理由の分からない応答本文をそのまま会話へ載せない
 * （分類の規則は provider-failure.ts の 1 つを使う）。
 */
function classifyImageFailure(context: ProviderFailureContext): ImageGenerationResult {
  return classifyProviderFailure(context, IMAGE_FAILURE_MESSAGES);
}

/** 画像専用 API の URL。baseUrl の末尾スラッシュは 1 本へ畳む */
function imagesEndpoint(model: ImageModel<ImageApi>): string {
  return `${model.baseUrl.replace(/\/+$/, "")}/images`;
}

/**
 * SDK 同梱の画像モデル。0.99 で画像モデルは通常の Models 面へ統合され、provider は
 * `model.provider` が持つ。同梱カタログは生成物で実行中に変わらないため 1 回だけ組む。
 */
let sdkImageModels: readonly ImageModel<ImageApi>[] | undefined;

function builtinImageModels(): readonly ImageModel<ImageApi>[] {
  sdkImageModels ??= builtinModels().getModelsOfType("image");
  return sdkImageModels;
}

export interface ImagesGenerator {
  /** SDK 同梱のカタログ（provider 順・モデル順は SDK の定義順） */
  catalog(): ImageCatalogEntry[];
  generate(input: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

/** カタログの組み立ては 1 箇所。generator を作らずに一覧だけを引ける */
export function catalogOf(models: readonly ImageModel<ImageApi>[]): ImageCatalogEntry[] {
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name || `${model.provider}/${model.id}`,
  }));
}

/**
 * SDK 同梱カタログからルーター用メタモデルを除くための接頭辞。`openrouter/auto*` は画像専用 API に
 * 存在せず (/images が 404)、SDK のまま選択肢へ出すと生成時に必ず失敗する。
 */
const ROUTER_META_MODEL_PREFIX = `${IMAGE_PROVIDER_ID}/`;

/**
 * SDK 同梱のカタログ。live 取得に失敗したときのフォールバックで、プロバイダー自身のメタモデルだけを落とす。
 * 一覧の正は live 側 (docs/image-generation.md)。
 */
export function imageModelCatalog(): ImageCatalogEntry[] {
  return catalogOf(builtinImageModels()).filter((entry) => !entry.id.startsWith(ROUTER_META_MODEL_PREFIX));
}

export function createImagesGenerator(options: ImagesGeneratorOptions = {}): ImagesGenerator {
  const modelsOf = options.models ?? (() => builtinImageModels());
  const timeoutMs = options.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS;
  const maskText = options.maskText ?? ((text: string) => text);
  const baseFetch = options.fetchImpl ?? fetch;

  return {
    catalog: () => catalogOf(modelsOf()),

    generate: async (input) => {
      const models = modelsOf().filter((model) => model.provider === input.provider);
      // 一覧の正は live で、SDK 同梱は遅れる。カタログに無い id も送れるように、URL / ヘッダは同じ
      // provider のモデル (openrouter は全モデルで同一) をひな形に借り、送信する id だけを差し替える
      const template = models.find((model) => model.id === input.model) ?? models[0];
      if (!template) {
        return {
          ok: false,
          code: "unknown",
          message: `${IMAGE_UNKNOWN_FAILURE_MESSAGE}: 画像モデルが見つかりません (${input.provider}/${input.model})`,
        };
      }
      const model: ImageModel<ImageApi> = { ...template, id: input.model };

      // 期限はここでのみ掛ける。SDK と違い応答と status を自分で読むため、abort の理由は timedOut で判別する
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onUserAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", onUserAbort, { once: true });
      if (input.signal?.aborted) onUserAbort();
      const aborted = (): boolean => input.signal?.aborted === true;

      let status: number | undefined;
      const inputReferences = input.inputReferences ?? [];
      const requestBody: Record<string, unknown> = {
        model: model.id,
        prompt: input.prompt,
        n: 1,
        ...imageParameterBody(input.parameters),
      };
      if (inputReferences.length > 0) {
        // OpenAI 直結 API の /images/edits や multipart は使わない（OpenRouter の /images の契約に合わせる）
        requestBody.input_references = inputReferences.map((url) => ({ type: "image_url", image_url: { url } }));
      }
      // 参照画像がある失敗では provider の自由文を結果へ載せない。本文は要求 JSON を反射でき、
      // エスケープの表記を列挙して除去する方式は未知の表記で漏れるため、分類と固定文言だけを返す
      const withholdProviderText = inputReferences.length > 0;
      try {
        const response = await baseFetch(imagesEndpoint(model), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
            ...model.headers,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        if (!response.ok) status = response.status;
        const text = await readCappedBody(response, IMAGE_RESPONSE_MAX_BYTES);
        // 上限超過は provider の原文を載せず、固定文言だけを返す（本文を持っていない）
        if (text === undefined) return { ok: false, code: "unknown", message: IMAGE_RESPONSE_TOO_LARGE_MESSAGE };
        const body = parseJsonBody(text);
        const image = imageOf(body);
        if (image) return { ok: true, image };
        return classifyImageFailure({
          status,
          timedOut,
          aborted: aborted(),
          providerMessage: withholdProviderText ? undefined : providerMessageOf(body, text, !response.ok),
          maskText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return classifyImageFailure({
          status,
          timedOut,
          aborted: aborted(),
          providerMessage: withholdProviderText ? undefined : message,
          maskText,
        });
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onUserAbort);
      }
    },
  };
}
