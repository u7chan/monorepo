/**
 * 画像生成の薄い関数。provider の選択と失敗の分類をこの 1 箇所へ閉じ、
 * 将来 OpenAI を足すときは providers の差し替えで済ませる（docs/image-generation.md）。
 * SDK は失敗を throw せず `stopReason: "error"` へ畳むため、非 2xx の status を包んだ fetch で記録する。
 */
import type {
  AssistantImages,
  ImageContent,
  ImagesContext,
  ImagesModel,
  ImagesOptions,
  ImagesProvider,
} from "@earendil-works/pi-ai";
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

interface FailureContext {
  status: number | undefined;
  timedOut: boolean;
  aborted: boolean;
  maskText: (text: string) => string;
}

function providerMessageOf(result: AssistantImages): string | undefined {
  if (result.errorMessage) return result.errorMessage;
  const texts: string[] = [];
  for (const part of result.output) {
    if (part.type === "text" && part.text !== "") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * `generateImages()` の戻り値から成功・失敗を決める。画像 0 件は失敗として扱い、text だけを結果に載せない
 * （モデルへ「生成できた」と誤解させない）。
 * 分類は記録した status → タイムアウト → ユーザー中断 → 原因不明の順に見る。
 */
function classifyImageResult(result: AssistantImages, context: FailureContext): ImageGenerationResult {
  const images = result.output.filter((part): part is ImageContent => part.type === "image");
  const first = images[0];
  if (first) return { ok: true, image: { mimeType: first.mimeType, data: first.data } };

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
  const detail = providerMessageOf(result);
  return {
    ok: false,
    code: "unknown",
    message: detail
      ? `${IMAGE_UNKNOWN_FAILURE_MESSAGE}: ${context.maskText(detail).slice(0, PROVIDER_MESSAGE_MAX_LENGTH)}`
      : `${IMAGE_UNKNOWN_FAILURE_MESSAGE}（原因不明）`,
  };
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

/** builtinImagesProviders() のカタログ。設定 API と UI の選択肢はこの一覧を正とする */
export function imageModelCatalog(): ImageCatalogEntry[] {
  return catalogOf(builtinImagesProviders());
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

      // SDK の timeoutMs は status 未記録のまま先に返り得るため渡さない。期限はここでのみ掛ける
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onUserAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", onUserAbort, { once: true });
      if (input.signal?.aborted) onUserAbort();

      let status: number | undefined;
      const recordStatus = (value: number): void => {
        // リトライで複数回失敗したときは最初の非 2xx を分類の根拠にする
        if (status === undefined) status = value;
      };
      const fetchImpl: typeof fetch = async (request, init) => {
        const response = await baseFetch(request, init);
        if (!response.ok) recordStatus(response.status);
        return response;
      };

      try {
        const context: ImagesContext = { input: [{ type: "text", text: input.prompt }] };
        const request: ImagesOptions = {
          apiKey: input.apiKey,
          signal: controller.signal,
          fetch: fetchImpl,
        };
        const result = await provider.generateImages(model, context, request);
        return classifyImageResult(result, {
          status,
          timedOut,
          aborted: input.signal?.aborted === true,
          maskText,
        });
      } catch (error) {
        // provider は throw しない契約だが、stub / 版差でも分類の外へ漏らさない
        const message = error instanceof Error ? error.message : String(error);
        return classifyImageResult(
          {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "error",
            errorMessage: message,
            timestamp: Date.now(),
          },
          { status, timedOut, aborted: input.signal?.aborted === true, maskText },
        );
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onUserAbort);
      }
    },
  };
}
