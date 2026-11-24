/**
 * 設定 → 音声入力のサービス。OpenAI Platform のキーをアプリ DB の `voice_input_settings`（id = 1）へ
 * AEAD で保存し、復号結果はメモリだけに持つ。録音と文字起こしは別の Issue で、ここはキーの保存・
 * 疎通確認・状態の公開だけを担う。契約は docs/api-settings.md / docs/secrets.md を正とする。
 */
import {
  APP_SECRET_NOT_STORED_MESSAGE,
  appSecretAvailable,
  appSecretNotStored,
  appSecretUnevaluated,
  evaluateAppSecret,
  requireAppSecretCipher,
  type AppSecretState,
} from "./app-secrets";
import { MutationLock } from "./serial-lock";
import {
  classifyProviderFailure,
  parseJsonBody,
  type ProviderFailure,
  type ProviderFailureMessages,
} from "./provider-failure";
import type { VoiceInputSettingsRow } from "./app-db";
import type { AppSecretCipher } from "./secret-crypto";
import type { VoiceInputMutationResponse, VoiceInputSettingsResponse, VoiceInputTestResponse } from "./schema";

/** 録音の文字起こしに使う固定モデル。画面は読取専用で出し、client からは送らない */
export const VOICE_INPUT_MODEL = "gpt-live-transcribe";

/** 復号したキーを AAD に結び付ける用途と所有者。変更すると保存済みのキーを復号できなくなる */
const VOICE_INPUT_SECRET_SCOPE = "voice_input_settings" as const;
const VOICE_INPUT_SECRET_OWNER = "apiKey";

/** 短命キーの発行。音声は送らないため課金されない（docs/api-settings.md） */
export const VOICE_INPUT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
/** 疎通確認の期限。発行は 1 往復なので短く切る */
export const VOICE_INPUT_TEST_TIMEOUT_MS = 10_000;
/** 発行する短命キーの期限。ブラウザは SDP の交換だけに使い、録音の長さとは独立 */
const VOICE_INPUT_CLIENT_SECRET_SECONDS = 60;

/**
 * 短命キーの発行本文。セッション種別とモデルを固定し、client から受け取った値を混ぜない
 * （疎通確認と Realtime 中継で同じ本文を送る）。
 */
export function clientSecretRequestBody(): string {
  return JSON.stringify({
    expires_after: { anchor: "created_at", seconds: VOICE_INPUT_CLIENT_SECRET_SECONDS },
    session: {
      type: "transcription",
      audio: { input: { transcription: { model: VOICE_INPUT_MODEL }, turn_detection: null } },
    },
  });
}

export const VOICE_INPUT_KEY_NOT_STORED_MESSAGE = "音声入力のAPIキーをアプリデータ（SQLite）へ保存できませんでした";
export const VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE = "音声入力の設定をアプリデータ（SQLite）から読み取れませんでした";
export const VOICE_INPUT_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、音声入力のAPIキーを登録できません";
export const VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、音声入力の疎通確認はできません";
export const VOICE_INPUT_NOT_CONFIGURED_MESSAGE = "音声入力のAPIキーが未設定です。先にキーを登録してください";
export const VOICE_INPUT_KEY_UNAVAILABLE_MESSAGE =
  "保存済みの音声入力のAPIキーを使えません。master key を確認するか、キーを再入力してください";
export const VOICE_INPUT_TEST_INVALID_RESPONSE_MESSAGE = "OpenAI の疎通確認の応答が想定と異なります";

/**
 * 上流の失敗文言。分類（provider-failure.ts）は共通で、ここでは音声入力の利用者向けに差し替える。
 * 上流の本文は分類に渡さず、応答・ログにも出さない。
 */
const VOICE_INPUT_FAILURE_MESSAGES: ProviderFailureMessages = {
  invalidKey: "OpenAI のAPIキーが拒否されました。キーの値と権限を確認してください",
  insufficientCredit: "OpenAI の残高が不足しています。Platform の利用状況を確認してください",
  rateLimited: "OpenAI が混雑しています。時間をおいて再試行してください",
  timeout: "OpenAI の疎通確認がタイムアウトしました",
  aborted: "OpenAI の疎通確認を中断しました",
  unknown: "OpenAI の疎通確認に失敗しました",
};

/** サービスが要求する DB の読み書き。テストはこの形の stub を渡す */
export interface VoiceInputSettingsDb {
  /** 行が無ければ undefined = キー未設定 */
  readVoiceInputSettings(): VoiceInputSettingsRow | undefined;
  saveVoiceInputSettings(secret: VoiceInputSettingsRow): void;
  deleteVoiceInputSettings(): boolean;
}

export interface VoiceInputSettingsOptions {
  db: VoiceInputSettingsDb;
  /**
   * マスカーを持てる起動（pi あり）か。false のときキーの登録・置換・疎通確認は 503。
   * 削除は暗号化にもマスカーにも依存しないため常に受け付ける。
   */
  runtimeAvailable: boolean;
  /** DB / ログへ渡す前に保護対象へ足す（マスカーの swap は同期） */
  retainSecret: (value: string) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
  /** アプリ DB のキー用の AEAD。master key が無い / 不正なときは null で、保存と復号を拒否する */
  appCipher?: AppSecretCipher | null;
  /** 疎通確認の送信に使う fetch。テストで差し替える */
  fetchImpl?: typeof fetch;
  /** 疎通確認の期限。省略時は VOICE_INPUT_TEST_TIMEOUT_MS（テストで縮める） */
  timeoutMs?: number;
}

export type VoiceInputMutationOutcome =
  | { status: 200; response: VoiceInputMutationResponse }
  | { status: 503; error: string };

export type VoiceInputTestOutcome =
  | { status: 200; response: VoiceInputTestResponse }
  | { status: 409; error: string }
  | { status: 503; error: string };

/**
 * キーを使えるかの判定。設定の疎通確認と、Realtime 中継の両方が上流を呼ぶ前にここを通す
 * （未登録 409 / ランタイム・DB・復号の利用不可 503）。
 */
export type VoiceInputKeyUse =
  | { status: 200; apiKey: string }
  | { status: 409; error: string }
  | { status: 503; error: string };

export class VoiceInputSettingsService {
  #db: VoiceInputSettingsDb;
  #runtimeAvailable: boolean;
  #retainSecret: (value: string) => void;
  #maskError: (text: string) => string;
  #appCipher: AppSecretCipher | null;
  #fetchImpl: typeof fetch | undefined;
  #timeoutMs: number;
  #lock = new MutationLock();
  /** 復号済みのキー。外部通信の前に使うためだけにメモリへ持ち、GET では復号しない */
  #apiKey: string | null = null;
  /** 保存済みキーの復号結果。起動時と保存 / 置換のときだけ更新する */
  #keyState: AppSecretState = appSecretUnevaluated();

  constructor(options: VoiceInputSettingsOptions) {
    this.#db = options.db;
    this.#runtimeAvailable = options.runtimeAvailable;
    this.#retainSecret = options.retainSecret;
    this.#maskError = options.maskError;
    this.#appCipher = options.appCipher ?? null;
    this.#fetchImpl = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs ?? VOICE_INPUT_TEST_TIMEOUT_MS;
  }

  /** GET。暗号文の有無だけを読み、復号はしない（状態は起動時に評価した値を返す） */
  settings(): VoiceInputSettingsResponse {
    return this.#response(this.#db.readVoiceInputSettings() !== undefined);
  }

  /** キーの登録・上書き。マスカーへの登録は DB より前（失敗しても保護対象だけは残す） */
  async putKey(apiKey: string): Promise<VoiceInputMutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtimeAvailable) return { status: 503, error: VOICE_INPUT_RUNTIME_UNAVAILABLE_MESSAGE };
      this.#retainSecret(apiKey);
      let secret: VoiceInputSettingsRow;
      try {
        secret = requireAppSecretCipher(this.#appCipher).encrypt(
          VOICE_INPUT_SECRET_SCOPE,
          VOICE_INPUT_SECRET_OWNER,
          apiKey,
        );
      } catch {
        // master key 未設定 / 不正では平文で保存しない。何も変えずに not_stored を返す
        console.warn("[u7agent] voice input key encryption failed");
        return { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE };
      }
      try {
        this.#db.saveVoiceInputSettings(secret);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] voice input key save failed");
        return { status: 503, error: VOICE_INPUT_KEY_NOT_STORED_MESSAGE };
      }
      // 保存が確定した値は復号し直さず、手元の状態をそのまま使える状態へ揃える
      this.#apiKey = apiKey;
      this.#keyState = appSecretAvailable();
      return { status: 200, response: this.#applied(true) };
    });
  }

  /** キーの削除（行ごと消す）。未設定でも 200 を返す（削除は冪等で、復号も要らない） */
  async deleteKey(): Promise<VoiceInputMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.deleteVoiceInputSettings();
      } catch {
        console.warn("[u7agent] voice input key delete failed");
        return { status: 503, error: VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE };
      }
      // 復号は不要 (暗号文を読まない)。メモリのキーも消す
      this.#apiKey = null;
      this.#keyState = appSecretNotStored();
      return { status: 200, response: this.#applied(false) };
    });
  }

  /**
   * 起動時の適用。DB を読めないときは「未保存」と断定せず未評価で立ち、警告だけを残す。
   * 復号できたキーは、外部へ渡す前に保護対象へ入れる。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      let row: VoiceInputSettingsRow | undefined;
      try {
        row = this.#db.readVoiceInputSettings();
      } catch {
        // 行の理由は AppDb の #secretQuery が値の断片を含まない固定文言で記録する。
        // ここは操作の分類だけを残す (stub の DB が値を含む例外を投げてもログへ出さない)
        console.error("[u7agent] voice input settings unavailable");
        this.#apiKey = null;
        this.#keyState = appSecretUnevaluated();
        return;
      }
      const { value, state } = evaluateAppSecret({
        cipher: this.#appCipher,
        runtimeAvailable: this.#runtimeAvailable,
        scope: VOICE_INPUT_SECRET_SCOPE,
        owner: VOICE_INPUT_SECRET_OWNER,
        secret: row ?? null,
        retain: (value) => this.#retainSecret(value),
      });
      this.#apiKey = value;
      this.#keyState = state;
    });
  }

  /**
   * キーの利用判定。上流を呼ぶ前に通し、未登録と利用不可を分けて返す。
   * 疎通確認と Realtime 中継が同じ規則を使う（設定ごとに判定を増やさない）。
   */
  keyForUse(): VoiceInputKeyUse {
    let stored: boolean;
    try {
      stored = this.#db.readVoiceInputSettings() !== undefined;
    } catch {
      // 行の有無を確定できないまま「未登録」と案内しない
      console.warn("[u7agent] voice input settings read failed");
      return { status: 503, error: VOICE_INPUT_SETTINGS_NOT_STORED_MESSAGE };
    }
    if (!stored) return { status: 409, error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE };
    if (!this.#runtimeAvailable) return { status: 503, error: VOICE_INPUT_TEST_RUNTIME_UNAVAILABLE_MESSAGE };
    if (this.#apiKey === null) return { status: 503, error: VOICE_INPUT_KEY_UNAVAILABLE_MESSAGE };
    return { status: 200, apiKey: this.#apiKey };
  }

  /**
   * 課金なしの疎通確認。短命キーの発行だけを呼び、音声は送らない。結果は保存せず、ゲートにもしない
   * （残高・失効は時間で変わるため）。上流の本文は応答にもログにも出さない。
   */
  async test(): Promise<VoiceInputTestOutcome> {
    const use = this.keyForUse();
    if (use.status !== 200) return { status: use.status, error: use.error };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let failure: ProviderFailure;
    try {
      const response = await (this.#fetchImpl ?? fetch)(VOICE_INPUT_SECRETS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${use.apiKey}` },
        body: clientSecretRequestBody(),
        signal: controller.signal,
      });
      const body = parseJsonBody(await response.text());
      if (response.ok && clientSecretValueOf(body, use.apiKey) !== null) {
        return { status: 200, response: { ok: true, model: VOICE_INPUT_MODEL } };
      }
      failure = response.ok
        ? { ok: false, code: "unknown", message: VOICE_INPUT_TEST_INVALID_RESPONSE_MESSAGE }
        : classifyProviderFailure(
            {
              status: response.status,
              timedOut: false,
              aborted: false,
              providerMessage: undefined,
              maskText: this.#maskError,
            },
            VOICE_INPUT_FAILURE_MESSAGES,
          );
    } catch {
      failure = classifyProviderFailure(
        {
          status: undefined,
          timedOut: controller.signal.aborted,
          aborted: false,
          providerMessage: undefined,
          maskText: this.#maskError,
        },
        VOICE_INPUT_FAILURE_MESSAGES,
      );
    } finally {
      clearTimeout(timer);
    }
    return { status: 200, response: failure };
  }

  /**
   * 保存の有無と利用可否を分けて返す。`configured`（行の有無）だけでキー登録済みと読ませず、
   * 未評価と復号失敗も別の軸として返す。
   */
  #response(stored: boolean): VoiceInputSettingsResponse {
    return {
      configured: stored,
      keyStored: stored,
      keyAvailable: stored && this.#keyState.keyAvailable,
      keyEvaluated: stored ? this.#keyState.keyEvaluated : true,
      keyErrorMessage: stored ? this.#keyState.keyErrorMessage : null,
      model: VOICE_INPUT_MODEL,
      runtimeAvailable: this.#runtimeAvailable,
    };
  }

  /** 変更系の応答。値を知っている側から組み、書込後の読取に依存させない */
  #applied(stored: boolean): VoiceInputMutationResponse {
    return { ...this.#response(stored), state: "applied" };
  }
}

/**
 * 発行された短命キーの形だけを見る。`session.type` が文字起こしで、`value` が `ek_` に
 * base64url の文字だけを続けた形で、入力の APIキーがそのまま返っていないことを確かめる
 * （キーの再露出を成功と扱わない）。疎通確認と Realtime 中継で同じ検査を使い、片方だけ緩めない。
 */
export function clientSecretValueOf(body: unknown, apiKey: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { value?: unknown }).value;
  const session = (body as { session?: unknown }).session;
  if (typeof value !== "string" || !/^ek_[A-Za-z0-9_-]+$/.test(value) || value === apiKey) return null;
  if (typeof session !== "object" || session === null) return null;
  return (session as { type?: unknown }).type === "transcription" ? value : null;
}
