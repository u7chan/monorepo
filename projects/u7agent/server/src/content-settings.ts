/**
 * 設定 → コンテンツ生成のサービス。アプリ DB の `content_settings`（id = 1 の 1 行）を
 * 希望状態の正とし、行の有無と `enabled` を PiBff のツール公開 state へロックの内側で写す。
 * SDK への認証反映が無いため degraded は持たず、変更系の応答は常に `applied` になる。
 * 契約は docs/image-generation.md / docs/speech-generation.md を正とする。
 */
import {
  APP_SECRET_NOT_STORED_MESSAGE,
  appSecretAvailable,
  appSecretFailed,
  appSecretMasterKeyMissing,
  appSecretNotStored,
  appSecretUnevaluated,
  type AppSecretState,
} from "./app-secrets";
import { messageFor } from "./http";
import { bgmSettings, BGM_MODEL } from "./bgm";
import { CONTENT_DISABLED_MESSAGE } from "./content-disabled";
import { MutationLock } from "./model-settings";
import type { ProviderFailureCode } from "./provider-failure";
import { REDACTED } from "./redact";
import type { ContentSettingsRow } from "./app-db";
import type { AppSecretCipher } from "./secret-crypto";
import type { ImageCatalog } from "./image-catalog";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig, type ImageGenerationSettings } from "./images";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog } from "./speech-catalog";
import {
  pcmToWav,
  SPEECH_TEXT_MAX_LENGTH,
  type SpeechGenerationInput,
  type SpeechGenerationResult,
  type SpeechGenerationSettings,
} from "./speech";
import {
  type ContentMutationResponse,
  type ContentSettingsResponse,
  type ImageCatalogRefreshResponse,
  type SpeechCatalogRefreshResponse,
} from "./schema";

/** キー登録で作る行の既定モデル（直後に画面から変更できる） */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

/** 復号した APIキーを AAD に結び付ける所有者。変更すると保存済みのキーを復号できなくなる */
const CONTENT_SECRET_OWNER = "apiKey";

export const CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、コンテンツ生成のAPIキーを登録できません";
export const CONTENT_KEY_NOT_STORED_MESSAGE = "コンテンツ生成のAPIキーをアプリデータ（SQLite）へ保存できませんでした";
export const CONTENT_SETTINGS_NOT_STORED_MESSAGE = "コンテンツ生成の設定をアプリデータ（SQLite）へ保存できませんでした";
export const CONTENT_SETTINGS_UNCONFIGURED_MESSAGE = "コンテンツ生成のAPIキーが未設定です。先にキーを登録してください";
export const CONTENT_PROVIDER_UNSUPPORTED_MESSAGE = "コンテンツ生成のプロバイダーは openrouter だけです";
export const CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い画像モデルは指定できません";
export const CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い音声モデルは指定できません";
export const CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE = "この音声モデルが対応していない声は指定できません";
/** 音声の値に APIキーを混ぜた保存要求。値を伏せたまま拒否し、黙って消して保存しない */
export const CONTENT_SPEECH_KEY_INCLUDED_MESSAGE = "APIキーと同じ値を音声の設定には指定できません";
/** 保存済みのキーを復号できないため、キーとの照合が要る操作を進められない */
export const CONTENT_KEY_UNAVAILABLE_MESSAGE =
  "保存済みのAPIキーを復号できないため、音声の設定を変更できません。APIキーを再入力してください";

export const CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、音声のお試し再生を実行できません";
export const CONTENT_SPEECH_PREVIEW_READ_FAILED_MESSAGE =
  "コンテンツ生成の設定を読み取れないため、音声のお試し再生を実行できません";
/** 課金前に止める本文 / 演技指示の文言。ツール向け（分割して呼ぶ）の文言は流用しない */
export const CONTENT_SPEECH_PREVIEW_TEXT_EMPTY_MESSAGE =
  "読み上げる文章を入力してください（クレジットは消費していません）";
export const CONTENT_SPEECH_PREVIEW_TEXT_TOO_LONG_MESSAGE = `読み上げる文章が長すぎます（${SPEECH_TEXT_MAX_LENGTH.toLocaleString("en-US")} 文字まで。クレジットは消費していません）`;
export const CONTENT_SPEECH_PREVIEW_INSTRUCTIONS_TOO_LONG_MESSAGE = `演技指示が長すぎます（${SPEECH_TEXT_MAX_LENGTH.toLocaleString("en-US")} 文字まで。クレジットは消費していません）`;
export const CONTENT_SPEECH_PREVIEW_SPEED_MESSAGE =
  "速度は正の数で指定してください（空欄は provider の既定。クレジットは消費していません）";

export interface ContentSettingsDb {
  /** 行が無ければ undefined = 未設定 */
  readContentSettings(): ContentSettingsRow | undefined;
  saveContentSettings(settings: ContentSettingsRow): void;
  deleteContentSettings(): boolean;
}

export interface ContentSettingsOptions {
  db: ContentSettingsDb;
  /** false（pi ランタイム初期化失敗）のときキー登録は 503。retainSecret が no-op になるため */
  runtimeAvailable: boolean;
  /** SDK / DB へ触る前に保護対象へ足す（マスカーの swap は同期） */
  retainSecret: (value: string) => void;
  /** アプリ DB のキー用の AEAD。master key が無い / 不正なときは null で、保存と復号を拒否する */
  appCipher?: AppSecretCipher | null;
  /** 公開する選択肢と、live 取得の状態。カタログの取得自体はサービスではなくこの実装が行う */
  catalog: ImageCatalog;
  /** 音声の選択肢と話者の宣言。画像とは別の一覧を引く */
  speechCatalog: SpeechCatalog;
  /** PiBff の注入面。**同じロックの内側**で呼び、次に作るセッションへ即時反映する */
  setContentGeneration: (config: ContentGenerationConfig) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
  /** お試し再生の生成器（PiBff が持つ）。未注入（ランタイムなしで起動）は runtime 不可と同じ 503 */
  generateSpeech?: ((input: SpeechGenerationInput) => Promise<SpeechGenerationResult>) | undefined;
}

export type ContentMutationOutcome =
  | { status: 200; response: ContentMutationResponse }
  | { status: 503; error: string };

/**
 * お試し再生の結果。200 は音声バイト（`contentType` は mp3 が `audio/mpeg`、pcm は wav 化して `audio/wav`）、
 * それ以外は JSON の失敗で、`code` は provider の失敗を分類できたときだけ載る。
 */
export type SpeechPreviewOutcome =
  | { status: 200; audio: ArrayBuffer; contentType: string }
  | { status: 400 | 502 | 503; error: string; code?: ProviderFailureCode };

export class ContentSettingsService {
  #db: ContentSettingsDb;
  #runtimeAvailable: boolean;
  #retainSecret: (value: string) => void;
  #catalog: ImageCatalog;
  #speechCatalog: SpeechCatalog;
  #setContentGeneration: (config: ContentGenerationConfig) => void;
  #maskError: (text: string) => string;
  #generateSpeech: ((input: SpeechGenerationInput) => Promise<SpeechGenerationResult>) | undefined;
  #appCipher: AppSecretCipher | null;
  #lock = new MutationLock();
  /**
   * 復号済みの APIキー。画像 / 音声 / BGM / お試し再生へ渡すためにメモリだけに持ち、
   * GET では復号しない。null は「復号できていない」で、保存値の有無とは別。
   */
  #apiKey: string | null = null;
  /** 保存済みキーの復号結果。起動時と保存 / 置換のときだけ更新する */
  #keyState: AppSecretState = appSecretUnevaluated();

  constructor(options: ContentSettingsOptions) {
    this.#db = options.db;
    this.#runtimeAvailable = options.runtimeAvailable;
    this.#retainSecret = options.retainSecret;
    this.#catalog = options.catalog;
    this.#speechCatalog = options.speechCatalog;
    this.#setContentGeneration = options.setContentGeneration;
    this.#maskError = options.maskError;
    this.#generateSpeech = options.generateSpeech;
    this.#appCipher = options.appCipher ?? null;
  }

  /**
   * 応答と実行時の両方で使う値へ落とす。同じ行の APIキーと一致・包含する値と、マスカーが値を変える値は
   * 未設定として扱う。`pi: null`（ランタイムなしで起動したとき）はマスカーが identity になり、保存値だけでは
   * 安全と判定できないため、同梱の照合を実行時のマスカーの状態に依存させない。マスク済みの文字列もそのまま
   * 使わない。保存値そのものは消さない。
   */
  #usableSpeechValue(value: string | null, apiKey: string | null): string | null {
    if (value === null || value === "") return null;
    if (apiKey && value.includes(apiKey)) return null;
    return this.#maskError(value) === value ? value : null;
  }

  /** 行があるときの音声の実効値。音声列が NULL の既存行も既定モデル / 先頭ボイスへ寄せる（画面に「（未設定）」を出さない） */
  #speechSelection(
    speechModel: string | null,
    speechVoice: string | null,
    apiKey: string | null,
  ): { model: string; voice: string } {
    const model = this.#usableSpeechValue(speechModel, apiKey) ?? DEFAULT_SPEECH_MODEL;
    return {
      model,
      voice: this.#usableSpeechValue(speechVoice, apiKey) ?? this.#speechCatalog.voicesOf(model)?.[0] ?? "",
    };
  }

  /**
   * 400 の文言へ入力を反射するときの値。同じ行の APIキーと一致・包含する値は、実行時のマスカーが
   * identity（`pi: null` の起動）でも伏せ字にして返す。どの値が不正かという形は残し、値そのものは返さない。
   */
  #reflectedValue(value: string, apiKey: string | null): string {
    const masked = this.#maskError(value);
    return apiKey && masked.includes(apiKey) ? masked.split(apiKey).join(REDACTED) : masked;
  }

  /** 行に暗号文があるか。復号できるかは #keyState が表す */
  #keyStored(row: ContentSettingsRow | undefined): boolean {
    return row !== undefined && row.ciphertext !== null && row.nonce !== null && row.keyVersion !== null;
  }

  /**
   * 保存行の暗号文から APIキーを復号し、結果をメモリへ残す。runtime が無いときは復号しない
   * (復号した値を使う経路が無い)。平文へは落とさない。
   */
  #evaluateKey(row: ContentSettingsRow | undefined): void {
    const secret =
      row && row.ciphertext !== null && row.nonce !== null && row.keyVersion !== null
        ? { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion }
        : null;
    if (!secret) {
      this.#apiKey = null;
      this.#keyState = appSecretNotStored();
      return;
    }
    if (!this.#runtimeAvailable) {
      this.#apiKey = null;
      this.#keyState = appSecretUnevaluated();
      return;
    }
    if (!this.#appCipher) {
      this.#apiKey = null;
      this.#keyState = appSecretMasterKeyMissing();
      return;
    }
    try {
      const apiKey = this.#appCipher.decrypt("content_settings", CONTENT_SECRET_OWNER, secret);
      // ツール・応答・ログへ渡す前に保護対象へ入れる
      this.#retainSecret(apiKey);
      this.#apiKey = apiKey;
      this.#keyState = appSecretAvailable();
    } catch {
      this.#apiKey = null;
      this.#keyState = appSecretFailed();
    }
  }

  /** 音声ツールの語彙（`model` / `voice`）へ写す。応答と同じ解決を使い、表示と実行時を食い違わせない */
  #currentSpeechSettings(): SpeechGenerationSettings | undefined {
    const row = this.#db.readContentSettings();
    const apiKey = this.#apiKey;
    if (!row || apiKey === null) return undefined;
    const speech = this.#speechSelection(row.speechModel, row.speechVoice, apiKey);
    return { provider: row.provider, model: speech.model, voice: speech.voice, apiKey };
  }

  /** GET。純粋読取で、キー値は返さない（DB の失敗は 503 のまま伝える） */
  settings(): ContentSettingsResponse {
    const row = this.#db.readContentSettings();
    const catalog = this.#catalog.snapshot();
    const speechCatalog = this.#speechCatalog.snapshot();
    const speech = row ? this.#speechSelection(row.speechModel, row.speechVoice, this.#apiKey) : null;
    return {
      ...this.#keyStatus(row),
      configured: row !== undefined,
      provider: row?.provider ?? null,
      // 行が無い = 未設定。トグルの既定は ON（Web 検索の「行が無い = 有効」と同じ読み替え）
      enabled: row?.enabled ?? true,
      disabledMessage: CONTENT_DISABLED_MESSAGE,
      runtimeAvailable: this.#runtimeAvailable,
      image: {
        model: row?.imageModel ?? null,
        models: catalog.entries,
        catalogSource: catalog.source,
        fetchedAt: catalog.fetchedAt,
      },
      speech: {
        model: speech?.model ?? null,
        voice: speech?.voice ?? "",
        models: speechCatalog.entries,
        catalogSource: speechCatalog.source,
        fetchedAt: speechCatalog.fetchedAt,
      },
      bgm: bgmSettings(row !== undefined),
    };
  }

  /**
   * live カタログの再取得。取得できなくても 200 で現在の一覧を返し、UI 注記用の固定文言を
   * `catalogError` に載せる（一覧を失わせない）。設定は変わらないため configured / provider / model は返さない。
   */
  async refreshCatalog(): Promise<ImageCatalogRefreshResponse> {
    return this.#lock.run(async () => {
      const catalogError = await this.#catalog.refresh();
      const catalog = this.#catalog.snapshot();
      return {
        models: catalog.entries,
        catalogSource: catalog.source,
        fetchedAt: catalog.fetchedAt,
        catalogError,
      };
    });
  }

  /**
   * live 音声カタログの再取得。画像と同じく、取得できなくても 200 で現在の一覧を返し、失敗は
   * `catalogError` にだけ載せる（設定は変わらないため configured / provider / model は返さない）。
   */
  async refreshSpeechCatalog(): Promise<SpeechCatalogRefreshResponse> {
    return this.#lock.run(async () => {
      const catalogError = await this.#speechCatalog.refresh();
      const catalog = this.#speechCatalog.snapshot();
      return {
        models: catalog.entries,
        catalogSource: catalog.source,
        fetchedAt: catalog.fetchedAt,
        catalogError,
      };
    });
  }

  /**
   * キーの登録・上書き。行が無ければ既定 provider / model で作る。有効 / 無効は引き継ぐ
   * （OFF にしたままキーだけ差し替えられる）
   */
  async putKey(apiKey: string): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtimeAvailable) {
        return { status: 503, error: CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE };
      }
      let existing: ContentSettingsRow | undefined;
      try {
        existing = this.#db.readContentSettings();
      } catch (error) {
        // 行の有無を確定できないまま既定へ寄せない（provider / model を黙って巻き戻さない）
        console.warn(`[u7agent] content settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: CONTENT_KEY_NOT_STORED_MESSAGE };
      }
      // マスカーへの登録は DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      let encrypted: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number };
      try {
        encrypted = this.#requireCipher().encrypt("content_settings", CONTENT_SECRET_OWNER, apiKey);
      } catch {
        // master key 未設定 / 不正では平文で保存しない。何も変えずに not_stored を返す
        console.warn("[u7agent] content key encryption failed");
        return { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE };
      }
      const next: ContentSettingsRow = {
        provider: existing?.provider ?? IMAGE_PROVIDER_ID,
        imageModel: existing?.imageModel ?? DEFAULT_IMAGE_MODEL,
        speechModel: existing?.speechModel ?? null,
        speechVoice: existing?.speechVoice ?? null,
        enabled: existing?.enabled ?? true,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyVersion: encrypted.keyVersion,
      };
      try {
        this.#db.saveContentSettings(next);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] content key save failed");
        return { status: 503, error: CONTENT_KEY_NOT_STORED_MESSAGE };
      }
      // 保存が確定した値は復号し直さず、手元の状態をそのまま使える状態へ揃える
      this.#apiKey = apiKey;
      this.#keyState = appSecretAvailable();
      this.#apply(next);
      return { status: 200, response: this.#applied(next) };
    });
  }

  /**
   * 有効 / 無効。行ごと消すとキーと選択まで失うため、一時的に止めたいだけのときはこちらを使う。
   * 行が無ければ 400（キー登録が先。止める対象が無い）。
   */
  async putEnabled(enabled: boolean): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      let existing: ContentSettingsRow | undefined;
      try {
        existing = this.#db.readContentSettings();
      } catch (error) {
        console.warn(`[u7agent] content settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      if (!existing) throw badRequest(CONTENT_SETTINGS_UNCONFIGURED_MESSAGE);
      const next: ContentSettingsRow = { ...existing, enabled };
      try {
        this.#db.saveContentSettings(next);
      } catch {
        console.warn("[u7agent] content settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(next);
      return { status: 200, response: this.#applied(next) };
    });
  }

  /** provider / model の変更。キーは保持し、行が無ければ 400（キー登録が先） */
  async putSelection(input: { provider: string; model: string }): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      let existing: ContentSettingsRow | undefined;
      try {
        existing = this.#db.readContentSettings();
      } catch (error) {
        console.warn(`[u7agent] content settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      if (!existing) throw badRequest(CONTENT_SETTINGS_UNCONFIGURED_MESSAGE);
      if (input.provider !== IMAGE_PROVIDER_ID) throw badRequest(CONTENT_PROVIDER_UNSUPPORTED_MESSAGE);
      const inCatalog = this.#catalog
        .snapshot()
        .entries.some((entry) => entry.provider === input.provider && entry.id === input.model);
      // 入力を反射する文言はマスカーを通す（model にキーを誤って渡されたとき、400 応答から再露出させない）。
      // キーを復号できていないときは保存値と比較できないため、入力そのものを伏せる
      if (!inCatalog) {
        const reflected =
          this.#keyStored(existing) && this.#apiKey === null
            ? REDACTED
            : this.#reflectedValue(input.model, this.#apiKey);
        throw badRequest(`${CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE}: ${reflected}`);
      }
      const next: ContentSettingsRow = { ...existing, provider: input.provider, imageModel: input.model };
      try {
        this.#db.saveContentSettings(next);
      } catch {
        console.warn("[u7agent] content settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(next);
      return { status: 200, response: this.#applied(next) };
    });
  }

  /**
   * 音声モデル / 話者の変更。キーと provider、画像モデルは保持し、行が無ければ 400（キー登録が先）。
   * カタログに `default` しか無いとき（live に一度も成功していない）は照合しない: 同じ選択の再保存まで
   * 400 にすると、使えていた選択を別の入り口からやり直せなくなる。
   */
  async putSpeechSelection(input: { model: string; voice: string }): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      let existing: ContentSettingsRow | undefined;
      try {
        existing = this.#db.readContentSettings();
      } catch (error) {
        console.warn(`[u7agent] content settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      if (!existing) throw badRequest(CONTENT_SETTINGS_UNCONFIGURED_MESSAGE);
      // キーを復号できていない状態で照合を飛ばして保存しない (キー入りの値を残さない)
      if (this.#keyStored(existing) && !this.#keyState.keyAvailable) {
        return { status: 503, error: CONTENT_KEY_UNAVAILABLE_MESSAGE };
      }
      // キーと同じ値を音声の語彙へ保存させない (黙って消さず、値を伏せて 400 にする)
      if (this.#apiKey && (input.model.includes(this.#apiKey) || input.voice.includes(this.#apiKey))) {
        throw badRequest(CONTENT_SPEECH_KEY_INCLUDED_MESSAGE);
      }
      const catalog = this.#speechCatalog.snapshot();
      if (catalog.source !== "default") {
        const entry = catalog.entries.find((candidate) => candidate.id === input.model);
        // 入力を反射する文言はマスカーを通す（model / voice にキーを誤って渡されても 400 から再露出させない）
        if (!entry) {
          throw badRequest(
            `${CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE}: ${this.#reflectedValue(input.model, this.#apiKey)}`,
          );
        }
        // 宣言が無いモデルは任意の声を許す（空文字は「指定なし」として常に許す）
        if (entry.voices && input.voice !== "" && !entry.voices.includes(input.voice)) {
          throw badRequest(
            `${CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE}: ${this.#reflectedValue(input.voice, this.#apiKey)}`,
          );
        }
      }
      const speechVoice = input.voice === "" ? null : input.voice;
      const next: ContentSettingsRow = { ...existing, speechModel: input.model, speechVoice };
      try {
        this.#db.saveContentSettings(next);
      } catch {
        console.warn("[u7agent] content settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(next);
      return { status: 200, response: this.#applied(next) };
    });
  }

  /**
   * 設定 → コンテンツ生成 の「お試し再生」。課金前の検証（カタログ・声の宣言・長さ・空本文・速度）を
   * 既存の private 実装と共有するため、route へ写さずこのサービスに置く（キーを model / voice 欄へ
   * 誤って貼られたとき、400 の文言から再露出させない）。provider の応答は最大 180 秒かかるため、
   * 設定の保存を塞がないようロックの外で実行する。
   */
  async previewSpeech(
    input: { model: string; voice: string; text: string; instructions?: string; speed?: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<SpeechPreviewOutcome> {
    if (!this.#generateSpeech) {
      return { status: 503, error: CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE };
    }
    let row: ContentSettingsRow | undefined;
    try {
      row = this.#db.readContentSettings();
    } catch (error) {
      console.warn(`[u7agent] content settings read failed: ${this.#maskError(messageFor(error))}`);
      return { status: 503, error: CONTENT_SPEECH_PREVIEW_READ_FAILED_MESSAGE };
    }
    if (!row) return { status: 400, error: CONTENT_SETTINGS_UNCONFIGURED_MESSAGE };
    // 復号できないキーで provider を叩かない (平文の代用もしない)
    if (this.#apiKey === null) return { status: 503, error: CONTENT_KEY_UNAVAILABLE_MESSAGE };
    // OFF は「課金も止める」。ツールへ返すのと同じ文言で止め、画面はこの間だけ主ボタンを無効にする
    if (!row.enabled) return { status: 400, error: CONTENT_DISABLED_MESSAGE };

    // モデルの照合は PUT /speech と同じく `default`（live に一度も成功していない）を免除し、
    // 声の宣言は generate_speech と同じくカタログの出どころに関係なく引く
    const catalog = this.#speechCatalog.snapshot();
    if (catalog.source !== "default" && !catalog.entries.some((entry) => entry.id === input.model)) {
      return {
        status: 400,
        error: `${CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE}: ${this.#reflectedValue(input.model, this.#apiKey)}`,
      };
    }
    const declared = this.#speechCatalog.voicesOf(input.model);
    if (declared && input.voice !== "" && !declared.includes(input.voice)) {
      return {
        status: 400,
        error: `${CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE}: ${this.#reflectedValue(input.voice, this.#apiKey)}`,
      };
    }
    if (input.text.trim() === "") return { status: 400, error: CONTENT_SPEECH_PREVIEW_TEXT_EMPTY_MESSAGE };
    if (input.text.length > SPEECH_TEXT_MAX_LENGTH) {
      return { status: 400, error: CONTENT_SPEECH_PREVIEW_TEXT_TOO_LONG_MESSAGE };
    }
    const instructions = input.instructions ?? "";
    if (instructions.length > SPEECH_TEXT_MAX_LENGTH) {
      return { status: 400, error: CONTENT_SPEECH_PREVIEW_INSTRUCTIONS_TOO_LONG_MESSAGE };
    }
    // 対応モデルの範囲（Seed Audio の 0.5–2.0 など）は provider の制約なのでここでは縛らない
    if (input.speed !== undefined && !(Number.isFinite(input.speed) && input.speed > 0)) {
      return { status: 400, error: CONTENT_SPEECH_PREVIEW_SPEED_MESSAGE };
    }

    const result = await this.#generateSpeech({
      provider: row.provider,
      model: input.model,
      text: input.text,
      voice: input.voice,
      instructions,
      speed: input.speed,
      apiKey: this.#apiKey,
      signal: options.signal,
    });
    if (!result.ok) return { status: 502, error: result.message, code: result.code };
    if (result.speech.format === "pcm") {
      return {
        status: 200,
        audio: pcmToWav(result.speech.audio, result.speech.sampleRate, result.speech.channels),
        contentType: "audio/wav",
      };
    }
    return { status: 200, audio: result.speech.audio, contentType: "audio/mpeg" };
  }

  /**
   * キーの削除（行ごと消す）。未設定でも 200 を返す（削除は冪等で、画面は行の有無だけを見る）。
   * 有効なキーは 8..2048 文字なので、これが未設定へ戻る唯一の導線になる。有効 / 無効も行と一緒に消える。
   */
  async deleteKey(): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.deleteContentSettings();
      } catch {
        console.warn("[u7agent] content key delete failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      // 復号は不要 (暗号文を読まない)。メモリのキーも消す
      this.#apiKey = null;
      this.#keyState = appSecretNotStored();
      this.#apply(undefined);
      return { status: 200, response: this.#applied(undefined) };
    });
  }

  /**
   * 起動時の適用。DB を読めないときは無効で立ち、警告だけを残す（設定 API は DB の 503 で気付ける）。
   * `read` は常に差し替えるため、既存セッションの execute は削除後も現在の行を見に行く。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      this.#catalog.loadStored();
      this.#speechCatalog.loadStored();
      let row: ContentSettingsRow | undefined;
      try {
        row = this.#db.readContentSettings();
      } catch (error) {
        console.error(`[u7agent] content settings unavailable: ${this.#maskError(messageFor(error))}`);
        row = undefined;
      }
      // 起動時に 1 回だけ復号し、SDK / ツールへ渡す前に保護対象へ入れる
      this.#evaluateKey(row);
      // キーの有無で一覧の表示は変わらないが、未設定では一覧を出す画面が無いので取得しない
      if (row) {
        await this.#catalog.refresh();
        await this.#speechCatalog.refresh();
      }
      this.#apply(row);
    });
  }

  /**
   * ツールの公開状態の写し。行が無ければキー未設定、行があって OFF なら「設定で無効」として写す。
   * 実行時の課金前チェックは `disabled`（トグルだけ）を読み、キー未設定はキー無効エラーへ落とす。
   */
  #apply(row: ContentSettingsRow | undefined): void {
    this.#setContentGeneration({
      // 「設定行がある」「enabled」「キーを使える」の積。行や enabled だけでツールを開かない
      enabled: row !== undefined && row.enabled && this.#keyState.keyAvailable,
      configured: row !== undefined,
      disabled: row !== undefined && !row.enabled,
      read: () => (this.#apiKey === null ? undefined : currentImageSettings(this.#db, this.#apiKey)),
      // 実行のたびに現在のカタログを引く。形式の宣言を一覧から絞り込んだあとも、保存済みの選択はここで拾える
      readOutputFormats: (model) => this.#catalog.outputFormatsOf(model),
      checkImageInput: (model, signal) => this.#catalog.checkImageInput(model, signal),
      readSpeech: () => this.#currentSpeechSettings(),
      readBgm: () => {
        const row = this.#db.readContentSettings();
        return row && this.#apiKey !== null ? { model: BGM_MODEL, apiKey: this.#apiKey } : undefined;
      },
      readVoices: (model) => this.#speechCatalog.voicesOf(model),
    });
  }

  #requireCipher(): AppSecretCipher {
    if (!this.#appCipher) throw new Error(APP_SECRET_NOT_STORED_MESSAGE);
    return this.#appCipher;
  }

  /**
   * 保存の有無と利用可否を分けて返す。`configured`（行の有無）だけでキー登録済みと読ませず、
   * 未評価と復号失敗も別の軸として返す。
   */
  #keyStatus(row: ContentSettingsRow | undefined): {
    keyStored: boolean;
    keyAvailable: boolean;
    keyEvaluated: boolean;
    keyErrorMessage: string | null;
  } {
    const keyStored = this.#keyStored(row);
    return {
      keyStored,
      keyAvailable: keyStored && this.#keyState.keyAvailable,
      keyEvaluated: keyStored ? this.#keyState.keyEvaluated : true,
      keyErrorMessage: keyStored ? this.#keyState.keyErrorMessage : null,
    };
  }

  /**
   * DB 書込が確定した後の応答。値を知っている側から組み、read の成否に依存させない
   * （書込成功後の読取失敗を not_stored と誤伝しない）。カタログはメモリ上の現在値を載せる。
   * `row` が undefined のときは削除後（未設定）の応答になる。
   */
  #applied(row: ContentSettingsRow | undefined): ContentMutationResponse {
    const catalog = this.#catalog.snapshot();
    const speechCatalog = this.#speechCatalog.snapshot();
    // 未設定の行を「音声の既定」へ寄せないため、キーの有無で分ける
    const speech = row
      ? this.#speechSelection(row.speechModel, row.speechVoice, this.#apiKey)
      : { model: null, voice: "" };
    return {
      ...this.#keyStatus(row),
      configured: row !== undefined,
      provider: row?.provider ?? null,
      enabled: row?.enabled ?? true,
      disabledMessage: CONTENT_DISABLED_MESSAGE,
      runtimeAvailable: this.#runtimeAvailable,
      image: {
        model: row?.imageModel ?? null,
        models: catalog.entries,
        catalogSource: catalog.source,
        fetchedAt: catalog.fetchedAt,
      },
      speech: {
        model: speech.model,
        voice: speech.voice,
        models: speechCatalog.entries,
        catalogSource: speechCatalog.source,
        fetchedAt: speechCatalog.fetchedAt,
      },
      state: "applied",
      bgm: bgmSettings(row !== undefined),
    };
  }
}

/** 画像ツールの語彙（`model`）へ写す。DB の列名 `imageModel` は設定面の語彙なので、対応はこの 1 箇所に閉じる */
function currentImageSettings(db: ContentSettingsDb, apiKey: string): ImageGenerationSettings | undefined {
  const row = db.readContentSettings();
  return row ? { provider: row.provider, model: row.imageModel, apiKey } : undefined;
}

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
