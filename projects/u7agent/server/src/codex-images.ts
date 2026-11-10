/**
 * Codex（ChatGPT の画像生成ツール）で 1 枚生成するアダプタ。認証は `openai-codex` の OAuth を
 * そのまま使い、アプリ DB には触らない（docs/image-generation.md）。
 *
 * 応答は SSE で、画像は `image_generation_call` の item の `result`（base64）にだけ入る。画像モデルは
 * 応答に含まれないため、ルーティング用の chat モデルを画像モデルとして返さない（未知として扱う）。
 * 期限・上限は OpenRouter と条件が違う（5 分 / 32 MiB）ので、この module に閉じて持つ。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  classifyProviderFailure,
  parseJsonBody,
  type ProviderFailureCode,
  type ProviderFailureMessages,
} from "./provider-failure";
import type { CodexAuth, GeneratedImage, ImageAuthStatus, ImageGenerationResult } from "./images";

export const CODEX_PROVIDER_ID = "openai-codex";

/**
 * `auth.json` の保存値から認証状態を作る。**読取だけで、トークンの更新も外部通信もしない**
 * （GET の設定表示とツール一覧の判定がここを通る）。値は決して外へ出さず、種別と期限だけを見る。
 */
export function codexAuthStatusOf(authPath: string, now = Date.now()): ImageAuthStatus {
  const credential = storedCodexCredential(authPath);
  if (!credential) return { state: "missing", kind: null };
  if (credential.type !== "oauth") return { state: "configured", kind: "api_key" };
  // 期限切れでも保存値は残る（Pi は解決時に更新する）。ここでは「切れている」とだけ伝える
  const expired = typeof credential.expires === "number" && credential.expires <= now;
  return { state: expired ? "expired" : "configured", kind: "oauth" };
}

/** 保存値の読取。壊れた auth.json を「未設定」と断定せず、サインイン案内へ倒す */
function storedCodexCredential(authPath: string) {
  try {
    return readStoredCredential(CODEX_PROVIDER_ID, authPath);
  } catch {
    return undefined;
  }
}

/** アクセストークンの JWT claim から account id を取り出す。SDK と同じ claim を見る */
export function codexAccountIdOf(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
      | Record<string, { chatgpt_account_id?: unknown } | undefined>
      | undefined;
    const accountId = decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId !== "" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export type CodexFailureCode = ProviderFailureCode;

/** ModelRuntime が解決したアクセストークンから実行時認証を作る。accountId が読めないトークンは使わない */
export function codexAuthOf(access: string | undefined): CodexAuth | undefined {
  if (!access) return undefined;
  const accountId = codexAccountIdOf(access);
  return accountId === undefined ? undefined : { access, accountId };
}

/** 画像の上限は参考実装と同じ 32 MiB。base64 で約 4/3 になるため、応答の上限はそれより大きく取る */
export const CODEX_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const CODEX_RESPONSE_MAX_BYTES = 48 * 1024 * 1024;
/** スパイクで観測した所要は約 23 秒。OpenRouter の 180 秒とは条件が違うため別に持つ */
export const CODEX_GENERATION_TIMEOUT_MS = 300_000;

export const CODEX_AUTH_INVALID_MESSAGE =
  "Codex のサインイン（openai-codex）が失効しています。pi を起動して /login から openai-codex にサインインし直してください";
export const CODEX_USAGE_LIMIT_MESSAGE =
  "ChatGPT の画像生成枠が不足しているか、混雑しています。時間をおいて試してください";
/** タイムアウト・中断の後は枠が消費されている可能性がある（自動再送はしない） */
export const CODEX_TIMEOUT_MESSAGE = "Codex の画像生成がタイムアウトしました（利用枠が消費されている可能性があります）";
export const CODEX_ABORTED_MESSAGE = "画像生成を中断しました（利用枠が消費されている可能性があります）";
export const CODEX_UNKNOWN_FAILURE_MESSAGE = "Codex の画像生成に失敗しました";
export const CODEX_NO_IMAGE_MESSAGE = "Codex から画像が返りませんでした";
export const CODEX_RESPONSE_TOO_LARGE_MESSAGE = "Codex の応答が大きすぎます";
export const CODEX_IMAGE_TOO_LARGE_MESSAGE = "Codex の画像が大きすぎます（32 MiB まで）";
export const CODEX_ROUTING_MODEL_MISSING_MESSAGE = "Codex のルーティングモデルが見つかりません";

const CODEX_FAILURE_MESSAGES: ProviderFailureMessages = {
  invalidKey: CODEX_AUTH_INVALID_MESSAGE,
  insufficientCredit: CODEX_USAGE_LIMIT_MESSAGE,
  rateLimited: CODEX_USAGE_LIMIT_MESSAGE,
  timeout: CODEX_TIMEOUT_MESSAGE,
  aborted: CODEX_ABORTED_MESSAGE,
  unknown: CODEX_UNKNOWN_FAILURE_MESSAGE,
};

/** 画像生成ツールを使わせるだけの指示。会話の履歴も人格も送らない */
const CODEX_INSTRUCTIONS =
  "Generate exactly one image that matches the user's request with the image_generation tool. Do not answer in text.";

/** 応答に `output_format` が無いときの形式。Codex の画像は png で返る */
const DEFAULT_CODEX_FORMAT = "image/png";

/** `output_format` の表記を mimeType へ寄せる。未知・省略は png として扱う */
function mimeTypeOfFormat(format: unknown): string {
  if (typeof format !== "string") return DEFAULT_CODEX_FORMAT;
  const normalized = format.toLowerCase().trim();
  if (normalized === "jpeg" || normalized === "jpg" || normalized === "image/jpeg") return "image/jpeg";
  if (normalized === "webp" || normalized === "image/webp") return "image/webp";
  return DEFAULT_CODEX_FORMAT;
}

/** `image_generation_call` の item から画像を取り出す。`result` が base64 の本体 */
function imageOfItem(item: unknown): GeneratedImage | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { type, result, output_format: format } = item as { type?: unknown; result?: unknown; output_format?: unknown };
  if (type !== "image_generation_call") return undefined;
  if (typeof result !== "string" || result === "") return undefined;
  return { mimeType: mimeTypeOfFormat(format), data: result };
}

function imageOf(output: unknown): GeneratedImage | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    const image = imageOfItem(item);
    if (image) return image;
  }
  return undefined;
}

/**
 * SSE の本文から画像を 1 枚拾う。content-type は当てにせず（実測で null だった）、
 * `data:` 行を JSON として読み、`response.output_item.*` の item と最終応答の output だけを見る。
 */
function imageOfSse(text: string): GeneratedImage | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    const body = parseJsonBody(payload);
    if (typeof body !== "object" || body === null) continue;
    const item = imageOfItem((body as { item?: unknown }).item);
    if (item) return item;
    const image = imageOf((body as { response?: { output?: unknown } }).response?.output);
    if (image) return image;
  }
  return undefined;
}

/**
 * base64 を復号した大きさの概算。文字列の長さから求める（復号してから測ると上限を超えた本文を
 * メモリへ載せてしまう）。
 */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * 本文を上限まで読む。超えたら本文を捨てる（大きな応答をメモリへ載せない）。
 * content-length を宣言しない応答があるため、実バイトで数える。
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** ルーティングに使う chat モデル。画像モデルではないため、表示にも保存にも使わない */
function builtinCodexModels(): readonly Model<Api>[] {
  return builtinModels()
    .getModelsOfType("chat")
    .filter((model) => model.provider === CODEX_PROVIDER_ID);
}

export interface CodexImagesGeneratorOptions {
  /** テストで stub のカタログを注入する。既定は SDK 同梱の `openai-codex` の chat モデル */
  models?: () => readonly Model<Api>[];
  timeoutMs?: number;
  maskText?: (text: string) => string;
  fetchImpl?: typeof fetch;
}

export interface CodexImageGenerationInput {
  prompt: string;
  auth: CodexAuth;
  signal?: AbortSignal | undefined;
}

export interface CodexImagesGenerator {
  generate(input: CodexImageGenerationInput): Promise<ImageGenerationResult>;
}

/** `/codex/responses` の URL。baseUrl の末尾スラッシュは 1 本へ畳む */
function responsesEndpoint(model: Model<Api>): string {
  const base = (model.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  return base.endsWith("/codex") ? `${base}/responses` : `${base}/codex/responses`;
}

/**
 * 1 枚生成する。失敗は既存の分類（timeout → 中断 → status → 不明）へ寄せ、自動再送も
 * 別 provider / 別アカウントへの切り替えもしない。
 */
export function createCodexImagesGenerator(options: CodexImagesGeneratorOptions = {}): CodexImagesGenerator {
  const modelsOf = options.models ?? builtinCodexModels;
  const timeoutMs = options.timeoutMs ?? CODEX_GENERATION_TIMEOUT_MS;
  const maskText = options.maskText ?? ((text: string) => text);
  const baseFetch = options.fetchImpl ?? fetch;

  return {
    generate: async (input) => {
      const model = modelsOf()[0];
      if (!model) return { ok: false, code: "unknown", message: CODEX_ROUTING_MODEL_MISSING_MESSAGE };

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
        const response = await baseFetch(responsesEndpoint(model), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${input.auth.access}`,
            "chatgpt-account-id": input.auth.accountId,
            // Codex は毎回 originator を要求する（SDK と同じ値）
            originator: "pi",
            "OpenAI-Beta": "responses=experimental",
            ...model.headers,
          },
          body: JSON.stringify({
            model: model.id,
            store: false,
            stream: true,
            instructions: CODEX_INSTRUCTIONS,
            input: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
            tools: [{ type: "image_generation" }],
            tool_choice: "auto",
            parallel_tool_calls: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) status = response.status;
        const text = await readCappedBody(response, CODEX_RESPONSE_MAX_BYTES);
        if (text === undefined) return { ok: false, code: "unknown", message: CODEX_RESPONSE_TOO_LARGE_MESSAGE };
        const image = imageOfSse(text);
        if (image) {
          if (decodedBytes(image.data) > CODEX_IMAGE_MAX_BYTES) {
            return { ok: false, code: "unknown", message: CODEX_IMAGE_TOO_LARGE_MESSAGE };
          }
          return { ok: true, image };
        }
        // Codex の本文は要求や指示を反射し得るため、分類と固定文言だけを返す
        const classified = classifyProviderFailure(
          { status, timedOut, aborted: aborted(), providerMessage: undefined, maskText },
          CODEX_FAILURE_MESSAGES,
        );
        return status === undefined || status < 300
          ? { ok: false, code: "unknown", message: CODEX_NO_IMAGE_MESSAGE }
          : classified;
      } catch {
        return classifyProviderFailure(
          { status, timedOut, aborted: aborted(), providerMessage: undefined, maskText },
          CODEX_FAILURE_MESSAGES,
        );
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onUserAbort);
      }
    },
  };
}
