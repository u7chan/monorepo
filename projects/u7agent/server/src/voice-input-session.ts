/**
 * 音声入力の Realtime セッションの中継。ブラウザの offer SDP を受け、保存済みのキーで短命キーを発行し、
 * OpenAI の Calls へ SDP を渡して answer をそのまま返す。`ek_`・SDP・キーは応答 / ログ / 診断に出さない。
 * 契約は docs/api-settings.md を正とする。
 */
import { readBodyText } from "./bounded-body";
import {
  classifyProviderFailure,
  parseJsonBody,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderFailureMessages,
} from "./provider-failure";
import {
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
  VOICE_INPUT_SECRETS_URL,
  clientSecretRequestBody,
  clientSecretValueOf,
  type VoiceInputKeyUse,
} from "./voice-input";

/** Calls の送信先。answer SDP を返す 1 往復だけで、音声は中継しない */
export const VOICE_INPUT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** offer / answer の実受信バイト上限。bodyGuard の 64 KiB とは独立に、この経路だけの値 */
export const VOICE_INPUT_SDP_MAX_BYTES = 64 * 1024;
/** 本文の読取から応答までの全体予算。段ごとの上限はこの残り時間で切る */
export const VOICE_INPUT_SESSION_TOTAL_MS = 30_000;
/** 短命キーの発行 1 往復の上限 */
export const VOICE_INPUT_SESSION_CLIENT_SECRET_MS = 10_000;
/** Calls 1 往復の上限 */
export const VOICE_INPUT_SESSION_CALLS_MS = 20_000;
/** 同時に中継できる接続数。超過は上流を呼ばずに断る */
export const VOICE_INPUT_SESSION_MAX_CONCURRENT = 2;
/** 短命キー発行の応答 JSON の上限。SDP ではないので小さく切る */
const CLIENT_SECRET_MAX_BYTES = 64 * 1024;

export const VOICE_INPUT_SESSION_CONTENT_TYPE_MESSAGE =
  "音声接続の SDP は Content-Type: application/sdp で送信してください";
export const VOICE_INPUT_SESSION_INVALID_OFFER_MESSAGE = "音声接続の SDP が不正です";
export const VOICE_INPUT_SESSION_TOO_LARGE_MESSAGE = "音声接続の SDP が大きすぎます";
export const VOICE_INPUT_SESSION_EXPIRED_MESSAGE = "音声接続の開始がタイムアウトしました";
export const VOICE_INPUT_SESSION_KEY_CHANGED_MESSAGE =
  "音声入力のAPIキーが変更されたため、録音を開始できません。録音を開始し直してください";
export const VOICE_INPUT_SESSION_BUSY_MESSAGE = "音声入力の接続が混み合っています。時間をおいて再試行してください";
export const VOICE_INPUT_SESSION_INVALID_SECRET_MESSAGE = "OpenAI から文字起こし用の短命キーを取得できませんでした";
export const VOICE_INPUT_SESSION_INVALID_ANSWER_MESSAGE = "OpenAI の音声接続の応答が想定と異なります";

/**
 * 上流の失敗文言。分類（provider-failure.ts）は共通で、疎通確認とは利用者が見る操作が違うため
 * ここで差し替える。上流の本文は分類に渡さず、応答・ログにも出さない。
 */
const VOICE_INPUT_SESSION_FAILURE_MESSAGES: ProviderFailureMessages = {
  invalidKey: "OpenAI のAPIキーが拒否されました。キーの値と権限を確認してください",
  insufficientCredit: "OpenAI の残高が不足しています。Platform の利用状況を確認してください",
  rateLimited: "OpenAI が混雑しています。時間をおいて再試行してください",
  timeout: "OpenAI への接続がタイムアウトしました",
  aborted: "OpenAI への接続を中断しました",
  unknown: "OpenAI への音声接続に失敗しました",
};

/** 接続予算と各段の上限。既定は定数で、テストだけが縮める */
export interface VoiceInputSessionTiming {
  /** 本文の読取を含む全体予算 */
  totalMs?: number;
  /** 短命キーの発行 1 往復の上限（全体予算を超えない） */
  clientSecretMs?: number;
  /** Calls 1 往復の上限（全体予算を超えない） */
  callsMs?: number;
}

/** 中継がキーの利用可否を読む口。設定サービスがそのまま満たす */
export interface VoiceInputKeySource {
  keyForUse(): VoiceInputKeyUse;
}

export interface VoiceInputSessionInput {
  /** offer SDP。末尾の CRLF を含め、受け取った文字列をそのまま上流へ渡す */
  offer: string;
  /** 全体予算の期限（Date.now() の値）。本文の読取を含めて 1 本で数える */
  deadlineAt: number;
  /** ブラウザの切断・取消。上流の abort へ伝播する */
  signal?: AbortSignal;
}

/**
 * 中継の結果。成功だけが SDP で、失敗は JSON にする（上流失敗だけ `code` を持つ）。
 * 入口の拒否（415 / 413 / 400 / 408）は本文を読む前に決まるため、route が返す。
 */
export type VoiceInputSessionOutcome =
  | { status: 200; sdp: string }
  | { status: 409; error: string }
  | { status: 429; error: string }
  | { status: 502; error: string; code: ProviderFailureCode }
  | { status: 503; error: string };

/** 段の期限と、タイムアウト / ブラウザ中断のどちらで切れたかを持つ */
interface Stage {
  signal: AbortSignal;
  clear(): void;
  timedOut(): boolean;
  aborted(): boolean;
}

/** 上流 1 段分の失敗。`ProviderFailure` と同じ形で、呼び出し側が 502 へ写す */
type StageFailure = ProviderFailure;

export class VoiceInputSessionService {
  #settings: VoiceInputKeySource;
  #fetchImpl: typeof fetch | undefined;
  #totalMs: number;
  #clientSecretMs: number;
  #callsMs: number;
  /** 発行中の接続数。成功・失敗・取消のすべてで finally が戻す */
  #inFlight = 0;

  constructor(options: { settings: VoiceInputKeySource; fetchImpl?: typeof fetch; timing?: VoiceInputSessionTiming }) {
    this.#settings = options.settings;
    this.#fetchImpl = options.fetchImpl;
    this.#totalMs = options.timing?.totalMs ?? VOICE_INPUT_SESSION_TOTAL_MS;
    this.#clientSecretMs = options.timing?.clientSecretMs ?? VOICE_INPUT_SESSION_CLIENT_SECRET_MS;
    this.#callsMs = options.timing?.callsMs ?? VOICE_INPUT_SESSION_CALLS_MS;
  }

  /** 本文の読取から数える全体予算。route が本文を読む前に期限を決める */
  get totalBudgetMs(): number {
    return this.#totalMs;
  }

  /**
   * offer 1 本を中継する。キー利用判定 → 発行枠 → 短命キー発行 → キー再読 → Calls → キー再読の順で、
   * 上流を呼ぶ前に落とせるものは落とす。
   */
  async createSession(input: VoiceInputSessionInput): Promise<VoiceInputSessionOutcome> {
    const use = this.#settings.keyForUse();
    if (use.status !== 200) return { status: use.status, error: use.error };
    if (this.#inFlight >= VOICE_INPUT_SESSION_MAX_CONCURRENT) {
      return { status: 429, error: VOICE_INPUT_SESSION_BUSY_MESSAGE };
    }
    this.#inFlight += 1;
    try {
      return await this.#relay(use.apiKey, input);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #relay(apiKey: string, input: VoiceInputSessionInput): Promise<VoiceInputSessionOutcome> {
    const secret = await this.#issueClientSecret(apiKey, input);
    if (!secret.ok) return upstreamFailure(secret);
    // 発行中にキーが変わっていたら、そのキーで取った短命キーを使わない
    const changedAfterIssue = this.#keyChangeAfter(apiKey);
    if (changedAfterIssue) return changedAfterIssue;
    const answer = await this.#calls(secret.value, input);
    if (!answer.ok) return upstreamFailure(answer);
    // 待ち中の変更は「古いキーで確立した接続」なので、answer を成功として返さない
    const changedDuringCalls = this.#keyChangeAfter(apiKey);
    if (changedDuringCalls) return changedDuringCalls;
    return { status: 200, sdp: answer.sdp };
  }

  /** 発行直後の設定の読み直し。削除は未設定、置換はキー変更として案内を分ける */
  #keyChangeAfter(apiKey: string): VoiceInputSessionOutcome | null {
    const current = this.#settings.keyForUse();
    if (current.status === 200) {
      return current.apiKey === apiKey ? null : { status: 409, error: VOICE_INPUT_SESSION_KEY_CHANGED_MESSAGE };
    }
    if (current.status === 503) return { status: 503, error: current.error };
    return { status: 409, error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE };
  }

  async #issueClientSecret(
    apiKey: string,
    input: VoiceInputSessionInput,
  ): Promise<{ ok: true; value: string } | StageFailure> {
    const stage = this.#startStage(this.#clientSecretMs, input);
    if (!stage) return timeoutFailure();
    try {
      let response: Response;
      try {
        response = await this.#fetch(VOICE_INPUT_SECRETS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: clientSecretRequestBody(),
          redirect: "error",
          signal: stage.signal,
        });
      } catch {
        return this.#stageFailure(stage);
      }
      if (!response.ok) {
        // 上流の本文は成功時以外読まない（分類に本文を混ぜない）。cancel は待たずに応答を返す
        void response.body?.cancel().catch(() => {});
        return this.#statusFailure(response.status);
      }
      let text: string | undefined;
      try {
        text = await readBodyText(response.body?.getReader(), CLIENT_SECRET_MAX_BYTES, { cancelOnLimit: "background" });
      } catch {
        return this.#stageFailure(stage);
      }
      const value = text === undefined ? null : clientSecretValueOf(parseJsonBody(text), apiKey);
      if (value === null) return { ok: false, code: "unknown", message: VOICE_INPUT_SESSION_INVALID_SECRET_MESSAGE };
      return { ok: true, value };
    } finally {
      stage.clear();
    }
  }

  /** offer を Calls へ渡し、answer をそのまま返す。answer が SDP でなければ成功にしない */
  async #calls(clientSecret: string, input: VoiceInputSessionInput): Promise<{ ok: true; sdp: string } | StageFailure> {
    const stage = this.#startStage(this.#callsMs, input);
    if (!stage) return timeoutFailure();
    try {
      let response: Response;
      try {
        response = await this.#fetch(VOICE_INPUT_CALLS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
          body: input.offer,
          redirect: "error",
          signal: stage.signal,
        });
      } catch {
        return this.#stageFailure(stage);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return this.#statusFailure(response.status);
      }
      let text: string | undefined;
      try {
        text = await readBodyText(response.body?.getReader(), VOICE_INPUT_SDP_MAX_BYTES, {
          cancelOnLimit: "background",
        });
      } catch {
        return this.#stageFailure(stage);
      }
      if (text === undefined || !isSdp(text)) {
        return { ok: false, code: "unknown", message: VOICE_INPUT_SESSION_INVALID_ANSWER_MESSAGE };
      }
      return { ok: true, sdp: text };
    } finally {
      stage.clear();
    }
  }

  #fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.#fetchImpl ?? fetch)(url, init);
  }

  #statusFailure(status: number): StageFailure {
    return classifyProviderFailure(
      { status, timedOut: false, aborted: false, providerMessage: undefined, maskText: (text) => text },
      VOICE_INPUT_SESSION_FAILURE_MESSAGES,
    );
  }

  /** 例外の本文は使わず、自前のタイマー / ブラウザ中断だけで分類する */
  #stageFailure(stage: Stage): StageFailure {
    return classifyProviderFailure(
      {
        status: undefined,
        timedOut: stage.timedOut(),
        aborted: stage.aborted(),
        providerMessage: undefined,
        maskText: (text) => text,
      },
      VOICE_INPUT_SESSION_FAILURE_MESSAGES,
    );
  }

  /**
   * 段の期限を 1 本作る。段の上限と全体予算の残りの小さい方で切り、ブラウザの中断はそのまま伝播する。
   * 期限が既に切れていれば null を返し、上流を呼ばない。
   */
  #startStage(limitMs: number, input: VoiceInputSessionInput): Stage | null {
    const remaining = input.deadlineAt - Date.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.min(limitMs, remaining),
    );
    const forwardAbort = () => {
      aborted = true;
      controller.abort();
    };
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", forwardAbort);
      },
      timedOut: () => timedOut,
      aborted: () => aborted,
    };
  }
}

/**
 * 本文を offer として読む。空と SDP の先頭行（`v=`）だけを見て、改変はしない
 * （上流へ渡す本文と返す answer は末尾の CRLF まで受け取ったまま）。
 */
export function parseOffer(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  const text = new TextDecoder().decode(bytes);
  return isSdp(text) ? text : null;
}

/**
 * 期限付きの待ち。本文の読取のように上流の signal を持てない待ちへ、全体予算の期限だけを被せる。
 * 期限切れの例外に statusCode を持たせないのは、入口の 413 と取り違えないため。
 */
export async function withinDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    work.catch(() => {});
    throw new Error(VOICE_INPUT_SESSION_EXPIRED_MESSAGE);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(VOICE_INPUT_SESSION_EXPIRED_MESSAGE)), remaining);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** 2xx でも本文が SDP でなければ成功にしない。空も `v=` で始まらないので同じ判定で落ちる */
function isSdp(text: string): boolean {
  return text.trimStart().startsWith("v=");
}

/** 上流失敗を 502 の応答へ写す。上流の status は応答に出さず、分類だけを返す */
function upstreamFailure(failure: StageFailure): VoiceInputSessionOutcome {
  return { status: 502, error: failure.message, code: failure.code };
}

function timeoutFailure(): StageFailure {
  return { ok: false, code: "timeout", message: VOICE_INPUT_SESSION_FAILURE_MESSAGES.timeout };
}
