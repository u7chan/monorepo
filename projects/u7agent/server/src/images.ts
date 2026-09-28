/**
 * 画像生成の薄い関数。provider の選択と失敗の分類をこの 1 箇所へ閉じ、
 * 将来 OpenAI を足すときは providers の差し替えで済ませる（docs/image-generation.md）。
 *
 * 送信先は OpenRouter の画像専用 API（`POST {baseUrl}/images`）。SDK(pi-ai 0.87.1) の
 * openrouter-images は chat/completions へ投げるが、画像生成専用モデルはそちらでは
 * 404 になり `/images` でしか受け付けない。カタログだけ SDK を使い、要求は自前で組む。
 */
import type { ImagesModel, ImagesProvider } from "@earendil-works/pi-ai";
import { builtinImagesProviders } from "@earendil-works/pi-ai/providers/all";

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
  /** テストで stub provider を注入する。既定は builtinImagesProviders()（0.87.1 は openrouter のみ） */
  providers?: () => readonly ImagesProvider[];
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
function imagesEndpoint(model: ImagesModel<string>): string {
  return `${model.baseUrl.replace(/\/+$/, "")}/images`;
}

export interface ImagesGenerator {
  /** builtinImagesProviders() のカタログ（provider 順・モデル順は SDK の定義順） */
  catalog(): ImageCatalogEntry[];
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

/** カタログの組み立ては 1 箇所。generator を作らずに一覧だけを引ける */
export function catalogOf(providers: readonly ImagesProvider[]): ImageCatalogEntry[] {
  return providers.flatMap((provider) =>
    provider.getModels().map((model) => ({
      provider: provider.id,
      id: model.id,
      name: model.name || `${provider.id}/${model.id}`,
    })),
  );
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
  return catalogOf(builtinImagesProviders()).filter((entry) => !entry.id.startsWith(ROUTER_META_MODEL_PREFIX));
}

export function createImagesGenerator(options: ImagesGeneratorOptions = {}): ImagesGenerator {
  const providers = options.providers ?? (() => builtinImagesProviders());
  const timeoutMs = options.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS;
  const maskText = options.maskText ?? ((text: string) => text);
  const baseFetch = options.fetchImpl ?? fetch;

  return {
    catalog: () => catalogOf(providers()),

    generate: async (input) => {
      const provider = providers().find((candidate) => candidate.id === input.provider);
      const model: ImagesModel<string> | undefined = provider
        ?.getModels()
        .find((candidate) => candidate.id === input.model);
      if (!provider || !model) {
        return {
          ok: false,
          code: "unknown",
          message: `${IMAGE_UNKNOWN_FAILURE_MESSAGE}: 画像モデルが見つかりません (${input.provider}/${input.model})`,
        };
      }

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
