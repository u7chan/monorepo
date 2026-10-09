/**
 * 音声生成の薄い関数。provider の選択と失敗の分類をこの 1 箇所へ閉じる（docs/speech-generation.md）。
 *
 * pi-ai に TTS の実装が無い（`ModelTypeMap` は chat / image / classifier のみ）ため、画像と同じく
 * 要求を自前で組む。送信先は OpenRouter の音声専用 API（`POST {baseUrl}/audio/speech`）で、
 * 応答は JSON ではなく生バイト。`response_format` はモデルごとに mp3 / pcm のどちらかしか通らず、
 * API はどちらかを宣言しないため、mp3 を優先して送り、形式違いを示す 400 から使い分けを学習する。
 */
import {
  classifyProviderFailure,
  parseJsonBody,
  providerMessageOf,
  type ProviderFailureCode,
  type ProviderFailureMessages,
} from "./provider-failure";

/** 失敗の公開分類。分類の規則と provider メッセージの扱いは provider-failure.ts を正とする */
export type SpeechFailureCode = ProviderFailureCode;

/** 要求できる応答形式。OpenRouter の enum と同じ 2 つで、wav は受け付けない */
export type SpeechAudioFormat = "mp3" | "pcm";

/**
 * 保存できる形の生成結果。pcm は生バイトのまま返し、RIFF ヘッダを付ける仕事はツール層へ残す
 * （`speech-tools.ts`）。
 */
export type GeneratedSpeech =
  | {
      audio: ArrayBuffer;
      format: "mp3";
      /** 応答ヘッダの Content-Type（パラメータ付きは落とす） */
      contentType: string;
    }
  | {
      audio: ArrayBuffer;
      format: "pcm";
      contentType: string;
      /** WAV 化に必要なため、Content-Type が宣言しない / 不正な応答は失敗にする（推測しない） */
      sampleRate: number;
      channels: number;
    };

export type SpeechGenerationResult =
  | { ok: true; speech: GeneratedSpeech }
  | { ok: false; code: SpeechFailureCode; message: string };

/** 音声生成の provider。v1 は openrouter 固定で、他は設定 API が 400 にする */
export const SPEECH_PROVIDER_ID = "openrouter";

/** 音声専用 API の URL。取得先をこの 1 箇所に固定する */
export const SPEECH_API_URL = "https://openrouter.ai/api/v1/audio/speech";

export const SPEECH_GENERATION_TIMEOUT_MS = 180_000;

export const SPEECH_API_KEY_INVALID_MESSAGE = "音声APIキーが無効です。設定を確認してください";
export const SPEECH_INSUFFICIENT_CREDIT_MESSAGE = "音声生成の残高が不足しています";
export const SPEECH_RATE_LIMITED_MESSAGE = "音声生成が混雑しています（レート制限またはプロバイダー障害）";
export const SPEECH_TIMEOUT_MESSAGE = "音声生成がタイムアウトしました";
export const SPEECH_ABORTED_MESSAGE = "音声生成を中断しました";
export const SPEECH_UNKNOWN_FAILURE_MESSAGE = "音声生成に失敗しました";

/**
 * 2xx でも音声として使えない応答。画像の「画像 0 件は失敗」と同じ思想で、空ファイルを保存して
 * 成功と報告しない（provider メッセージが無い分だけ理由を固定文言で補う）。
 */
export const SPEECH_EMPTY_RESPONSE_MESSAGE = "音声生成に失敗しました（応答が空でした）";
export const SPEECH_CONTENT_TYPE_MESSAGE = "音声生成に失敗しました（対応していない応答が返りました）";
export const SPEECH_PCM_PARAMETERS_MESSAGE = "音声生成に失敗しました（音声形式のパラメータを読み取れませんでした）";

const SPEECH_FAILURE_MESSAGES: ProviderFailureMessages = {
  invalidKey: SPEECH_API_KEY_INVALID_MESSAGE,
  insufficientCredit: SPEECH_INSUFFICIENT_CREDIT_MESSAGE,
  rateLimited: SPEECH_RATE_LIMITED_MESSAGE,
  timeout: SPEECH_TIMEOUT_MESSAGE,
  aborted: SPEECH_ABORTED_MESSAGE,
  unknown: SPEECH_UNKNOWN_FAILURE_MESSAGE,
};

/** 実行のたびに読み直す現在の設定。DB の列名 `speechModel` / `speechVoice` は ContentSettingsService が写す */
export interface SpeechGenerationSettings {
  provider: string;
  model: string;
  /** 送る話者。空文字は「指定なし」（宣言が無いモデル）で、本文からキーごと落とす */
  voice: string;
  apiKey: string;
}

export interface SpeechGenerationInput {
  provider: string;
  model: string;
  text: string;
  /** 省略時は本文から voice を送らない。provider の既定声に委ねる */
  voice?: string | undefined;
  apiKey: string;
  /** ユーザー中断。timeout の自前タイマーとは別に扱う */
  signal?: AbortSignal | undefined;
}

export interface SpeechGeneratorOptions {
  /** provider リクエストの期限。SDK は通さないため、このタイマーだけに一本化する */
  timeoutMs?: number;
  /** provider メッセージをログ・応答へ出す前の境界 */
  maskText?: (text: string) => string;
  /** テストで差し替える fetch */
  fetchImpl?: typeof fetch;
}

export interface SpeechGenerator {
  generate(input: SpeechGenerationInput): Promise<SpeechGenerationResult>;
}

/** Content-Type から確定する応答形式と、pcm のときに要るパラメータ */
interface SpeechResponseType {
  format: SpeechAudioFormat;
  /** パラメータを落とした media type */
  contentType: string;
  /** pcm の Content-Type が宣言する値。無い / 不正なときは undefined */
  sampleRate?: number | undefined;
  channels?: number | undefined;
}

/**
 * 応答の形式は Content-Type だけで決める。実測で mp3 は `audio/mpeg`、pcm は `audio/pcm` の
 * どちらかだったため、他の `audio/*` も含めてこの 2 つ以外は形式を推測せず失敗にする。
 */
function speechResponseTypeOf(contentType: string): SpeechResponseType | undefined {
  const [rawMediaType = "", ...rawParameters] = contentType.split(";");
  const mediaType = rawMediaType.trim().toLowerCase();
  if (mediaType !== "audio/mpeg" && mediaType !== "audio/pcm") return undefined;
  const format: SpeechAudioFormat = mediaType === "audio/mpeg" ? "mp3" : "pcm";
  if (format === "mp3") return { format, contentType: mediaType };
  // `audio/pcm;rate=24000;channels=1` のように区切りの空白は無いこともある
  const parameters = new Map<string, string>();
  for (const raw of rawParameters) {
    const separator = raw.indexOf("=");
    if (separator < 0) continue;
    parameters.set(raw.slice(0, separator).trim().toLowerCase(), raw.slice(separator + 1).trim());
  }
  return {
    format,
    contentType: mediaType,
    sampleRate: positiveInteger(parameters.get("rate")),
    channels: positiveInteger(parameters.get("channels")),
  };
}

/** `rate` / `channels` として読める正の整数だけを返す */
function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

/**
 * 形式違いを示す 400 の検知。provider の文言は引用符・空白・大小が揺れるため、その揺れだけを許す。
 * 他の 400 は再試行の対象にしない。
 */
const SPEECH_FORMAT_HINT_PATTERN = /only supports response_format\s*=\s*["']?(pcm|mp3)["']?/i;

function speechFormatFromProviderMessage(message: string | undefined): SpeechAudioFormat | undefined {
  const hint = (message === undefined ? undefined : SPEECH_FORMAT_HINT_PATTERN.exec(message)?.[1])?.toLowerCase();
  if (hint === "mp3" || hint === "pcm") return hint;
  return undefined;
}

export function createSpeechGenerator(options: SpeechGeneratorOptions = {}): SpeechGenerator {
  const timeoutMs = options.timeoutMs ?? SPEECH_GENERATION_TIMEOUT_MS;
  const maskText = options.maskText ?? ((text: string) => text);
  const baseFetch = options.fetchImpl ?? fetch;
  // モデルごとの対応形式。API が宣言しないため形式違いの 400 から学習し、応答の Content-Type で
  // 確定した実形式だけを残す。プロセス内のみで、再学習は課金されない 400 の 1 往復で済む
  const knownFormats = new Map<string, SpeechAudioFormat>();

  return {
    generate: async (input) => {
      // 期限はここでのみ掛ける。応答と status を自分で読むため、abort の理由は timedOut で判別する
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
        // メモが無ければ mp3 から試す。再試行しても期限と中断の扱いを変えないよう controller は共有する
        let format: SpeechAudioFormat = knownFormats.get(input.model) ?? "mp3";
        for (let attempt = 0; ; attempt += 1) {
          status = undefined;
          const response = await baseFetch(SPEECH_API_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${input.apiKey}`,
            },
            body: JSON.stringify({
              model: input.model,
              input: input.text,
              ...(input.voice ? { voice: input.voice } : {}),
              response_format: format,
            }),
            signal: controller.signal,
          });
          if (!response.ok) status = response.status;
          const contentType = response.headers.get("content-type") ?? "";
          // 非 2xx も本文を読む。エラー本文は JSON（{"error":{"message":…}}）が主だが、
          // プロキシの HTML などもあり得るため、分類は本文の形に依存させない
          const audio = await response.arrayBuffer();
          if (response.ok) {
            if (audio.byteLength === 0) {
              return { ok: false, code: "unknown", message: SPEECH_EMPTY_RESPONSE_MESSAGE };
            }
            const responseType = speechResponseTypeOf(contentType);
            if (!responseType) return { ok: false, code: "unknown", message: SPEECH_CONTENT_TYPE_MESSAGE };
            // 要求と違う形式が返ることがあるため、メモは応答から確定した実形式で上書きする
            knownFormats.set(input.model, responseType.format);
            if (responseType.format === "pcm") {
              const { sampleRate, channels } = responseType;
              if (sampleRate === undefined || channels === undefined) {
                return { ok: false, code: "unknown", message: SPEECH_PCM_PARAMETERS_MESSAGE };
              }
              return {
                ok: true,
                speech: { audio, format: "pcm", contentType: responseType.contentType, sampleRate, channels },
              };
            }
            return { ok: true, speech: { audio, format: "mp3", contentType: responseType.contentType } };
          }
          const text = new TextDecoder().decode(audio);
          const providerMessage = providerMessageOf(parseJsonBody(text), text, true);
          const suggested =
            attempt === 0 && response.status === 400 ? speechFormatFromProviderMessage(providerMessage) : undefined;
          if (suggested !== undefined && suggested !== format) {
            format = suggested;
            // 中断済みなら待機を伴う再試行をせず、最後の試行の材料で分類する
            if (aborted()) {
              return classifyProviderFailure(
                { status, timedOut, aborted: true, providerMessage, maskText },
                SPEECH_FAILURE_MESSAGES,
              );
            }
            continue;
          }
          return classifyProviderFailure(
            { status, timedOut, aborted: aborted(), providerMessage, maskText },
            SPEECH_FAILURE_MESSAGES,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return classifyProviderFailure(
          { status, timedOut, aborted: aborted(), providerMessage: message, maskText },
          SPEECH_FAILURE_MESSAGES,
        );
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onUserAbort);
      }
    },
  };
}
