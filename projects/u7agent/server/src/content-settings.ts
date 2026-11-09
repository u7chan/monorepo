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
import type { ContentTrialSource } from "./content-trials";
import { REDACTED } from "./redact";
import type { ContentSettingsRow, ImageSettingsRow } from "./app-db";
import type { AppSecretCipher } from "./secret-crypto";
import type { ImageCatalog } from "./image-catalog";
import {
  IMAGE_PROVIDER_ID,
  isImageProviderId,
  type CodexAuth,
  type ContentGenerationConfig,
  type ImageAuthStatus,
  type ImageGenerationSettings,
  type ImageProviderId,
  type ImageToolAvailability,
} from "./images";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog } from "./speech-catalog";
import { type SpeechGenerationSettings } from "./speech";
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
/** 画像の生成元の切り替え。キーも生成も伴わないため、未設定の行でも受け付ける */
export const CONTENT_IMAGE_PROVIDER_UNSUPPORTED_MESSAGE = "画像の生成元は openrouter か codex だけです";
export const CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い画像モデルは指定できません";
export const CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い音声モデルは指定できません";
export const CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE = "この音声モデルが対応していない声は指定できません";
/** 音声の値に APIキーを混ぜた保存要求。値を伏せたまま拒否し、黙って消して保存しない */
export const CONTENT_SPEECH_KEY_INCLUDED_MESSAGE = "APIキーと同じ値を音声の設定には指定できません";
/**
 * 保存済みの音声設定が新しいキーを含むため、キーを置き換えられない。黙って音声値を消さず、
 * 先に音声の設定を変えてもらう (キーが分かる操作では必ず照合する)。
 */
export const CONTENT_SPEECH_KEY_CONFLICT_MESSAGE =
  "保存済みの音声の設定に新しいAPIキーと同じ値が含まれるため、キーを保存できません。先に音声の設定を変更してください";
/** 保存済みのキーを復号できないため、キーとの照合が要る操作を進められない */
export const CONTENT_KEY_UNAVAILABLE_MESSAGE =
  "保存済みのAPIキーを復号できないため、音声の設定を変更できません。APIキーを再入力してください";

export interface ContentSettingsDb {
  /** 行が無ければ undefined = 未設定 */
  readContentSettings(): ContentSettingsRow | undefined;
  saveContentSettings(settings: ContentSettingsRow): void;
  deleteContentSettings(): boolean;
  /** キーの世代。行が無ければ 0（まだ一度もキーを保存していない） */
  readContentKeyEpoch(): number;
  /** キーの保存・上書き・削除で 1 つ進め、進めた後の値を返す */
  advanceContentKeyEpoch(): number;
  /** 画像の生成元。行が無ければ undefined = 既定（openrouter） */
  readImageSettings(): ImageSettingsRow | undefined;
  saveImageSettings(settings: ImageSettingsRow): void;
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
  /**
   * Codex の認証。`status` は GET の表示用の純粋読取（トークン解決も外部通信もしない）、`resolve` は
   * 生成の実行時だけ呼ぶ。未設定の環境（runtime なし）は両方とも未認証を返す。
   */
  codexAuth: { status: () => ImageAuthStatus; resolve: () => Promise<CodexAuth | undefined> };
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
}

export type ContentMutationOutcome =
  | { status: 200; response: ContentMutationResponse }
  | { status: 400; error: string }
  | { status: 503; error: string };

export class ContentSettingsService {
  #db: ContentSettingsDb;
  #runtimeAvailable: boolean;
  #retainSecret: (value: string) => void;
  #catalog: ImageCatalog;
  #speechCatalog: SpeechCatalog;
  #setContentGeneration: (config: ContentGenerationConfig) => void;
  #maskError: (text: string) => string;
  #appCipher: AppSecretCipher | null;
  #codexAuth: { status: () => ImageAuthStatus; resolve: () => Promise<CodexAuth | undefined> };
  /** 画像の生成元と Codex 用の枠。書込はこのサービスだけなので、DB を毎回読み直さずここに持つ */
  #imageProvider: ImageProviderId = IMAGE_PROVIDER_ID;
  #codexParams: string | null = null;
  /** content_settings の現在値。ツール公開の判定を DB の読取失敗に巻き込まないための写し */
  #row: ContentSettingsRow | undefined;
  #lock = new MutationLock();
  /**
   * 復号済みの APIキー。画像 / 音声 / BGM / 試行へ渡すためにメモリだけに持ち、
   * GET では復号しない。null は「復号できていない」で、保存値の有無とは別。
   */
  #apiKey: string | null = null;
  /** 保存済みキーの復号結果。起動時と保存 / 置換のときだけ更新する */
  #keyState: AppSecretState = appSecretUnevaluated();
  /**
   * キーの世代。試行の証拠を現在のキーの実績に限るために応答へ載せる。保存 / 削除で進むと
   * 以前の実績は「旧キー」になる（docs/api-settings.md）。
   */
  #keyEpoch = 0;

  constructor(options: ContentSettingsOptions) {
    this.#db = options.db;
    this.#runtimeAvailable = options.runtimeAvailable;
    this.#retainSecret = options.retainSecret;
    this.#catalog = options.catalog;
    this.#speechCatalog = options.speechCatalog;
    this.#setContentGeneration = options.setContentGeneration;
    this.#maskError = options.maskError;
    this.#appCipher = options.appCipher ?? null;
    this.#codexAuth = options.codexAuth;
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

  /** 保存済みの音声の値がキーを含むか (キーが分かる操作では常に照合する) */
  #speechValuesInclude(row: ContentSettingsRow | undefined, apiKey: string): boolean {
    if (!row || apiKey === "") return false;
    return (row.speechModel?.includes(apiKey) ?? false) || (row.speechVoice?.includes(apiKey) ?? false);
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

  /**
   * 画像の認証状態。OpenRouter は復号済みのキーがあるか、Codex は auth.json の保存値を読むだけで
   * 判定する（トークンの解決・更新・外部通信を GET で起こさない）。
   */
  #imageAuthStatus(provider: ImageProviderId): ImageAuthStatus {
    if (provider === IMAGE_PROVIDER_ID) {
      return { state: this.#keyState.keyAvailable ? "configured" : "missing", kind: "api_key" };
    }
    try {
      return this.#codexAuth.status();
    } catch (error) {
      // 読取の失敗を「サインイン済み」と断定しない
      console.warn(`[u7agent] codex auth status read failed: ${this.#maskError(messageFor(error))}`);
      return { state: "missing", kind: null };
    }
  }

  /**
   * 画像ツールの公開状態。OpenRouter はキーの行とその復号が要るが、**Codex は行を要らない**
   * （キー削除で行が無くなってもサインインだけで使える）。理由は provider で分ける。
   */
  #imageAvailability(row: ContentSettingsRow | undefined): ImageToolAvailability {
    if (row !== undefined && !row.enabled) return { enabled: false, reason: "app_disabled" };
    if (this.#imageProvider === "codex") {
      const auth = this.#imageAuthStatus("codex");
      // `expired` も公開する: access token の期限切れは SDK が生成時の `getAuth()` で更新できる。
      // ここで落とすと解決の機会が無く、refresh token が生きていてもサインインし直しを強いられる
      return auth.state === "missing" ? { enabled: false, reason: "no_auth" } : { enabled: true, reason: null };
    }
    if (row === undefined || this.#apiKey === null) return { enabled: false, reason: "no_key" };
    return { enabled: true, reason: null };
  }

  /** 実行のたびに読む画像の設定。Codex はキーを使わないため、行が無くても undefined にしない */
  #currentImageSettings(): ImageGenerationSettings | undefined {
    if (this.#imageProvider === "codex") {
      return { provider: "codex", resolveAuth: () => this.#codexAuth.resolve() };
    }
    const row = this.#row;
    const apiKey = this.#apiKey;
    if (!row || apiKey === null) return undefined;
    return { provider: IMAGE_PROVIDER_ID, model: row.imageModel, apiKey };
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
      keyEpoch: this.#keyEpoch,
      // 行が無い = 未設定。トグルの既定は ON（Web 検索の「行が無い = 有効」と同じ読み替え）
      enabled: row?.enabled ?? true,
      disabledMessage: CONTENT_DISABLED_MESSAGE,
      runtimeAvailable: this.#runtimeAvailable,
      image: {
        model: row?.imageModel ?? null,
        provider: this.#imageProvider,
        auth: this.#imageAuthStatus(this.#imageProvider),
        // Codex は画像モデルを選ばない。一覧も出さない（ルーティングモデルを画像モデルとして見せない）
        models: this.#imageProvider === IMAGE_PROVIDER_ID ? catalog.entries : [],
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
      // 引き継ぐ音声値が新しいキーを含むなら、平文のまま残さず保存を拒否する
      if (this.#speechValuesInclude(existing, apiKey)) {
        return { status: 400, error: CONTENT_SPEECH_KEY_CONFLICT_MESSAGE };
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
      // 上書きだけ世代を進める（新規保存は「以前のキー」が存在しないため、進めても証拠の意味が変わらない）
      if (existing !== undefined) this.#advanceKeyEpoch();
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
   * 画像の生成元の変更。キーも生成も伴わないため、未設定の行でも受け付ける（Codex はキーを使わない）。
   * `content_settings` は触らないので、切り替えても OpenRouter のキー・モデルは残る（キー削除でも消えない）。
   */
  async putImageProvider(provider: string): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      if (!isImageProviderId(provider)) throw badRequest(CONTENT_IMAGE_PROVIDER_UNSUPPORTED_MESSAGE);
      try {
        this.#db.saveImageSettings({ provider, codexParams: this.#codexParams });
      } catch {
        console.warn("[u7agent] image settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#imageProvider = provider;
      this.#apply(this.#row);
      return { status: 200, response: this.#applied(this.#row) };
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
   * キーの削除（行ごと消す）。未設定でも 200 を返す（削除は冪等で、画面は行の有無だけを見る）。
   * 有効なキーは 8..2048 文字なので、これが未設定へ戻る唯一の導線になる。有効 / 無効も行と一緒に消える。
   */
  async deleteKey(): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      let removed: boolean;
      try {
        removed = this.#db.deleteContentSettings();
      } catch {
        console.warn("[u7agent] content key delete failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      // 行があったときだけ進める（未設定の DELETE は冪等で、世代を動かさない）
      if (removed) this.#advanceKeyEpoch();
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
      this.#loadKeyEpoch();
      this.#loadImageSettings();
      let row: ContentSettingsRow | undefined;
      let readFailed = false;
      try {
        row = this.#db.readContentSettings();
      } catch (error) {
        console.error(`[u7agent] content settings unavailable: ${this.#maskError(messageFor(error))}`);
        readFailed = true;
      }
      // 読取に失敗しただけなら「未保存」と断定せず未評価のまま残す (復旧後の GET で案内を失わない)
      if (readFailed) {
        this.#apiKey = null;
        this.#keyState = appSecretUnevaluated();
      } else {
        // 起動時に 1 回だけ復号し、SDK / ツールへ渡す前に保護対象へ入れる
        this.#evaluateKey(row);
      }
      // キーの有無で一覧の表示は変わらないが、未設定では一覧を出す画面が無いので取得しない
      if (row) {
        await this.#catalog.refresh();
        await this.#speechCatalog.refresh();
      }
      this.#apply(row);
    });
  }

  /**
   * 試行ジョブが読む現在値。キーは応答・ログへ出さないまま、生成器へ渡すためだけに返す。
   * 行が無ければ未設定で、カタログは画像の一覧（`provider/id`）を返す。
   */
  trialSource(): ContentTrialSource {
    return {
      read: () => {
        const row = this.#db.readContentSettings();
        return {
          // 試行は v1 では OpenRouter 固定。Codex の試行はサービス側で明示的に拒否する
          row: row
            ? { imageModel: row.imageModel, enabled: row.enabled, imageProvider: this.#imageProvider }
            : undefined,
          apiKey: this.#apiKey,
        };
      },
      models: () => this.#catalog.snapshot().entries.map((entry) => `${entry.provider}/${entry.id}`),
      speechModels: () => this.#speechCatalog.snapshot().entries.map((entry) => entry.id),
      // 宣言があるモデルだけ配列を返し、無いモデルは自由記述を受ける（PUT /speech と同じ規則）
      speechVoices: (model) => this.#speechCatalog.voicesOf(model),
      // 試行の画像モデルはカタログの `provider/id` で来るため、bare id に落としてから宣言を引く
      imageParameters: (model) => this.#catalog.parametersOf(model),
    };
  }

  /** 起動時に 1 回だけ画像の生成元を読む。読めないときは既定（openrouter）のままで、警告だけを残す */
  #loadImageSettings(): void {
    try {
      const settings = this.#db.readImageSettings();
      this.#imageProvider = isImageProviderId(settings?.provider ?? "")
        ? (settings?.provider as ImageProviderId)
        : IMAGE_PROVIDER_ID;
      this.#codexParams = settings?.codexParams ?? null;
    } catch (error) {
      console.warn(`[u7agent] image settings read failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /** 起動時に 1 回だけ世代を読む。読めないときは 0 のままで、次の保存 / 削除で DB の値から進む */
  #loadKeyEpoch(): void {
    try {
      this.#keyEpoch = this.#db.readContentKeyEpoch();
    } catch (error) {
      console.warn(`[u7agent] content key epoch read failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /** 世代を進める。進められなかったときはメモリも動かさない（応答と DB を食い違わせない） */
  #advanceKeyEpoch(): void {
    try {
      this.#keyEpoch = this.#db.advanceContentKeyEpoch();
    } catch (error) {
      console.warn(`[u7agent] content key epoch advance failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /**
   * ツールの公開状態の写し。行が無ければキー未設定、行があって OFF なら「設定で無効」として写す。
   * 実行時の課金前チェックは `disabled`（トグルだけ）を読み、キー未設定はキー無効エラーへ落とす。
   */
  #apply(row: ContentSettingsRow | undefined): void {
    this.#row = row;
    this.#setContentGeneration({
      // 「設定行がある」「enabled」「キーを使える」の積。行や enabled だけでツールを開かない
      enabled: row !== undefined && row.enabled && this.#keyState.keyAvailable,
      configured: row !== undefined,
      disabled: row !== undefined && !row.enabled,
      // 認証は呼ぶたびに読む（Codex のサインインは setContentGeneration を呼ばないため）
      imageAvailability: () => this.#imageAvailability(this.#row),
      read: () => this.#currentImageSettings(),
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
      keyEpoch: this.#keyEpoch,
      enabled: row?.enabled ?? true,
      disabledMessage: CONTENT_DISABLED_MESSAGE,
      runtimeAvailable: this.#runtimeAvailable,
      image: {
        model: row?.imageModel ?? null,
        provider: this.#imageProvider,
        auth: this.#imageAuthStatus(this.#imageProvider),
        models: this.#imageProvider === IMAGE_PROVIDER_ID ? catalog.entries : [],
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

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
