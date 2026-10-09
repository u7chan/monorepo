/**
 * 音声生成の薄い関数。provider の選択と失敗の分類をこの 1 箇所へ閉じる（docs/speech-generation.md）。
 *
 * pi-ai に TTS の実装が無い（`ModelTypeMap` は chat / image / classifier のみ）ため、画像と同じく
 * 要求を自前で組む。送信先は OpenRouter の音声専用 API（`POST {baseUrl}/audio/speech`）で、
 * 応答は JSON ではなく生バイト。`response_format` の既定は pcm なので mp3 を常に明示する。
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

export interface GeneratedSpeech {
  /** mp3 の生バイト */
  audio: ArrayBuffer;
  /** 応答ヘッダの Content-Type（パラメータ付きは落とす） */
  contentType: string;
}

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
export const SPEECH_CONTENT_TYPE_MESSAGE = "音声生成に失敗しました（音声以外の応答が返りました）";

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

/** Content-Type が `audio/*` か。パラメータ（`; codecs=...` など）は無視する */
export function isAudioContentType(value: string): boolean {
  return (value.split(";")[0]?.trim().toLowerCase() ?? "").startsWith("audio/");
}

export function createSpeechGenerator(options: SpeechGeneratorOptions = {}): SpeechGenerator {
  const timeoutMs = options.timeoutMs ?? SPEECH_GENERATION_TIMEOUT_MS;
  const maskText = options.maskText ?? ((text: string) => text);
  const baseFetch = options.fetchImpl ?? fetch;

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
            response_format: "mp3",
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
          if (!isAudioContentType(contentType)) {
            return { ok: false, code: "unknown", message: SPEECH_CONTENT_TYPE_MESSAGE };
          }
          return { ok: true, speech: { audio, contentType: contentType.split(";")[0]?.trim() ?? "" } };
        }
        const text = new TextDecoder().decode(audio);
        return classifyProviderFailure(
          {
            status,
            timedOut,
            aborted: aborted(),
            providerMessage: providerMessageOf(parseJsonBody(text), text, true),
            maskText,
          },
          SPEECH_FAILURE_MESSAGES,
        );
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
