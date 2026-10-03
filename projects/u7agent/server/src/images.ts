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

/** 失敗の公開分類。上流の原文は出さず、マスク済みの provider メッセージだけを添える */
export type ImageFailureCode =
  | "invalid_key"
  | "insufficient_credit"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "unknown";

export interface GeneratedImage {
  mimeType: string;
  /** base64 */
  data: string;
}

export type ImageGenerationResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; code: ImageFailureCode; message: string };

/** カタログ 1 件。UI の選択肢と model の検証はこの一覧を正とする */
export interface ImageCatalogEntry {
  provider: string;
  id: string;
  name: string;
  /**
   * live 一覧が宣言する出力形式（`supported_parameters.output_format.values`）。宣言が無い / 形が違うときは
   * 載せない（＝形式は不明）。SDK 同梱カタログと、この項目より前に書かれたキャッシュがこれにあたる。
   */
  outputFormats?: string[] | undefined;
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

/** 画像生成の provider。v1 は openrouter 固定で、他は設定 API が 400 にする */
export const IMAGE_PROVIDER_ID = "openrouter";

/** アプリ DB の image_settings 行と同じ形。実行のたびに読み直す現在の設定を表す */
export interface ImageGenerationSettings {
  provider: string;
  model: string;
  apiKey: string;
}

/** PiBff へ注入する有効状態と読取口。`enabled` はセッション作成時のツール一覧にだけ使う */
export interface ImageGenerationConfig {
  enabled: boolean;
  /** 実行のたびに現在の設定を読む。行が無ければ undefined（未設定・削除後） */
  read: () => ImageGenerationSettings | undefined;
  /**
   * 実行のたびにカタログの形式宣言を引く。未知名・宣言なし（SDK 同梱カタログなど）は undefined。
   * 保存できる形式を 1 つも宣言していないモデルを provider へ送る前に止めるために使う。
   */
  readOutputFormats: (model: string) => readonly string[] | undefined;
}

export interface ImageGenerationInput {
  provider: string;
  model: string;
  prompt: string;
  apiKey: string;
  /** ユーザー中断。timeout の自前タイマーとは別に扱う */
  signal?: AbortSignal | undefined;
}

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

export const IMAGE_API_KEY_INVALID_MESSAGE = "画像APIキーが無効です。設定を確認してください";
export const IMAGE_INSUFFICIENT_CREDIT_MESSAGE = "画像生成の残高が不足しています";
export const IMAGE_RATE_LIMITED_MESSAGE = "画像生成が混雑しています（レート制限またはプロバイダー障害）";
export const IMAGE_TIMEOUT_MESSAGE = "画像生成がタイムアウトしました";
export const IMAGE_ABORTED_MESSAGE = "画像生成を中断しました";
export const IMAGE_UNKNOWN_FAILURE_MESSAGE = "画像生成に失敗しました";

/** 応答に添える provider メッセージの上限。長文のエラー本文をそのまま会話へ載せない */
const PROVIDER_MESSAGE_MAX_LENGTH = 500;

/** media_type が読めないときの画像形式。OpenRouter は識別できるときだけ返す */
const DEFAULT_IMAGE_MIME_TYPE = "image/png";

interface FailureContext {
  status: number | undefined;
  timedOut: boolean;
  aborted: boolean;
  providerMessage: string | undefined;
  maskText: (text: string) => string;
}

/** 本文を JSON として読む。JSON でない本文（プロキシの HTML など）は生テキストのまま扱う */
function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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

/** OpenRouter の `error.message` を優先して理由を取り出す。非 2xx で形が違えば生テキストへ落とす */
function providerMessageOf(body: unknown, raw: string, includeRaw: boolean): string | undefined {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error !== "") return error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  if (!includeRaw) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 失敗の分類。タイムアウト → ユーザー中断 → 記録した status → 原因不明の順に見る。
 * 画像 0 件は失敗として扱い、理由の分からない応答本文をそのまま会話へ載せない。
 */
function classifyImageFailure(context: FailureContext): ImageGenerationResult {
  if (context.timedOut) return { ok: false, code: "timeout", message: IMAGE_TIMEOUT_MESSAGE };
  if (context.aborted) return { ok: false, code: "aborted", message: IMAGE_ABORTED_MESSAGE };
  const { status } = context;
  if (status === 401 || status === 403)
    return { ok: false, code: "invalid_key", message: IMAGE_API_KEY_INVALID_MESSAGE };
  if (status === 402) {
    return { ok: false, code: "insufficient_credit", message: IMAGE_INSUFFICIENT_CREDIT_MESSAGE };
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { ok: false, code: "rate_limited", message: IMAGE_RATE_LIMITED_MESSAGE };
  }
  const detail = context.providerMessage;
  return {
    ok: false,
    code: "unknown",
    message: detail
      ? `${IMAGE_UNKNOWN_FAILURE_MESSAGE}: ${context.maskText(detail).slice(0, PROVIDER_MESSAGE_MAX_LENGTH)}`
      : `${IMAGE_UNKNOWN_FAILURE_MESSAGE}（原因不明）`,
  };
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
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
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
      try {
        const response = await baseFetch(imagesEndpoint(model), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
            ...model.headers,
          },
          body: JSON.stringify({ model: model.id, prompt: input.prompt, n: 1 }),
          signal: controller.signal,
        });
        if (!response.ok) status = response.status;
        const text = await response.text();
        const body = parseJson(text);
        const image = imageOf(body);
        if (image) return { ok: true, image };
        return classifyImageFailure({
          status,
          timedOut,
          aborted: aborted(),
          providerMessage: providerMessageOf(body, text, !response.ok),
          maskText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return classifyImageFailure({
          status,
          timedOut,
          aborted: aborted(),
          providerMessage: message,
          maskText,
        });
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onUserAbort);
      }
    },
  };
}
