/**
 * 設定 → モデル（コンテンツ生成タブ）のサービス。アプリ DB の `content_settings`（id = 1 の 1 行）を
 * 希望状態の正とし、行の有無を PiBff のツール公開 state へロックの内側で写す。
 * SDK への認証反映が無いため degraded は持たず、変更系の応答は常に `applied` になる。
 * 契約は docs/image-generation.md / docs/speech-generation.md を正とする。
 */
import { messageFor } from "./http";
import { MutationLock } from "./model-settings";
import type { ContentSettingsRow } from "./app-db";
import type { ImageCatalog } from "./image-catalog";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig, type ImageGenerationSettings } from "./images";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog } from "./speech-catalog";
import type { SpeechGenerationSettings } from "./speech";
import {
  type ContentMutationResponse,
  type ContentSettingsResponse,
  type ImageCatalogRefreshResponse,
  type SpeechCatalogRefreshResponse,
} from "./schema";

/** キー登録で作る行の既定モデル（直後に画面から変更できる） */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

export const CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、コンテンツ生成のAPIキーを登録できません";
export const CONTENT_KEY_NOT_STORED_MESSAGE = "コンテンツ生成のAPIキーをアプリデータ（SQLite）へ保存できませんでした";
export const CONTENT_SETTINGS_NOT_STORED_MESSAGE = "コンテンツ生成の設定をアプリデータ（SQLite）へ保存できませんでした";
export const CONTENT_SETTINGS_UNCONFIGURED_MESSAGE = "コンテンツ生成のAPIキーが未設定です。先にキーを登録してください";
export const CONTENT_PROVIDER_UNSUPPORTED_MESSAGE = "コンテンツ生成のプロバイダーは openrouter だけです";
export const CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い画像モデルは指定できません";
export const CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い音声モデルは指定できません";
export const CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE = "この音声モデルが対応していない声は指定できません";

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
  /** 公開する選択肢と、live 取得の状態。カタログの取得自体はサービスではなくこの実装が行う */
  catalog: ImageCatalog;
  /** 音声の選択肢と話者の宣言。画像とは別の一覧を引く */
  speechCatalog: SpeechCatalog;
  /** PiBff の注入面。**同じロックの内側**で呼び、次に作るセッションへ即時反映する */
  setContentGeneration: (config: ContentGenerationConfig) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
}

export type ContentMutationOutcome =
  | { status: 200; response: ContentMutationResponse }
  | { status: 503; error: string };

export class ContentSettingsService {
  #db: ContentSettingsDb;
  #runtimeAvailable: boolean;
  #retainSecret: (value: string) => void;
  #catalog: ImageCatalog;
  #speechCatalog: SpeechCatalog;
  #setContentGeneration: (config: ContentGenerationConfig) => void;
  #maskError: (text: string) => string;
  #lock = new MutationLock();

  constructor(options: ContentSettingsOptions) {
    this.#db = options.db;
    this.#runtimeAvailable = options.runtimeAvailable;
    this.#retainSecret = options.retainSecret;
    this.#catalog = options.catalog;
    this.#speechCatalog = options.speechCatalog;
    this.#setContentGeneration = options.setContentGeneration;
    this.#maskError = options.maskError;
  }

  /**
   * 応答と実行時の両方で使う値へ落とす。マスカーが値を変える（登録済みキーと一致する / 含む）ときは
   * 未設定として扱い、マスク済みの文字列もそのまま使わない。ボイス欄へキーを誤って保存しても応答から
   * 再露出させず、表示と実行時の解決も食い違わせないため。保存値そのものは消さない。
   */
  #usableSpeechValue(value: string | null): string | null {
    if (value === null || value === "") return null;
    return this.#maskError(value) === value ? value : null;
  }

  /** 行があるときの音声の実効値。音声列が NULL の既存行も既定モデル / 先頭ボイスへ寄せる（画面に「（未設定）」を出さない） */
  #speechSelection(speechModel: string | null, speechVoice: string | null): { model: string; voice: string } {
    const model = this.#usableSpeechValue(speechModel) ?? DEFAULT_SPEECH_MODEL;
    return { model, voice: this.#usableSpeechValue(speechVoice) ?? this.#speechCatalog.voicesOf(model)?.[0] ?? "" };
  }

  /** 音声ツールの語彙（`model` / `voice`）へ写す。応答と同じ解決を使い、表示と実行時を食い違わせない */
  #currentSpeechSettings(): SpeechGenerationSettings | undefined {
    const row = this.#db.readContentSettings();
    if (!row) return undefined;
    const speech = this.#speechSelection(row.speechModel, row.speechVoice);
    return { provider: row.provider, model: speech.model, voice: speech.voice, apiKey: row.apiKey };
  }

  /** GET。純粋読取で、キー値は返さない（DB の失敗は 503 のまま伝える） */
  settings(): ContentSettingsResponse {
    const row = this.#db.readContentSettings();
    const catalog = this.#catalog.snapshot();
    const speechCatalog = this.#speechCatalog.snapshot();
    const speech = row ? this.#speechSelection(row.speechModel, row.speechVoice) : null;
    return {
      configured: row !== undefined,
      provider: row?.provider ?? null,
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

  /** キーの登録・上書き。行が無ければ既定 provider / model で作る */
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
      try {
        this.#db.saveContentSettings({
          provider: existing?.provider ?? IMAGE_PROVIDER_ID,
          imageModel: existing?.imageModel ?? DEFAULT_IMAGE_MODEL,
          speechModel: existing?.speechModel ?? null,
          speechVoice: existing?.speechVoice ?? null,
          apiKey,
        });
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] content key save failed");
        return { status: 503, error: CONTENT_KEY_NOT_STORED_MESSAGE };
      }
      this.#apply(true);
      return {
        status: 200,
        response: this.#applied({
          configured: true,
          provider: existing?.provider ?? IMAGE_PROVIDER_ID,
          imageModel: existing?.imageModel ?? DEFAULT_IMAGE_MODEL,
          speechModel: existing?.speechModel ?? null,
          speechVoice: existing?.speechVoice ?? null,
        }),
      };
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
      // 入力を反射する文言はマスカーを通す（model にキーを誤って渡されたとき、400 応答から再露出させない）
      if (!inCatalog) throw badRequest(`${CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE}: ${this.#maskError(input.model)}`);
      try {
        this.#db.saveContentSettings({ ...existing, provider: input.provider, imageModel: input.model });
      } catch {
        console.warn("[u7agent] content settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(true);
      return {
        status: 200,
        response: this.#applied({
          configured: true,
          provider: input.provider,
          imageModel: input.model,
          speechModel: existing.speechModel,
          speechVoice: existing.speechVoice,
        }),
      };
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
      const catalog = this.#speechCatalog.snapshot();
      if (catalog.source !== "default") {
        const entry = catalog.entries.find((candidate) => candidate.id === input.model);
        // 入力を反射する文言はマスカーを通す（model / voice にキーを誤って渡されても 400 から再露出させない）
        if (!entry) {
          throw badRequest(`${CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE}: ${this.#maskError(input.model)}`);
        }
        // 宣言が無いモデルは任意の声を許す（空文字は「指定なし」として常に許す）
        if (entry.voices && input.voice !== "" && !entry.voices.includes(input.voice)) {
          throw badRequest(`${CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE}: ${this.#maskError(input.voice)}`);
        }
      }
      const speechVoice = input.voice === "" ? null : input.voice;
      try {
        this.#db.saveContentSettings({ ...existing, speechModel: input.model, speechVoice });
      } catch {
        console.warn("[u7agent] content settings save failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(true);
      return {
        status: 200,
        response: this.#applied({
          configured: true,
          provider: existing.provider,
          imageModel: existing.imageModel,
          speechModel: input.model,
          speechVoice,
        }),
      };
    });
  }

  /**
   * キーの削除（行ごと消す）。未設定でも 200 を返す（削除は冪等で、画面は行の有無だけを見る）。
   * 有効なキーは 8..2048 文字なので、これが未設定へ戻る唯一の導線になる。
   */
  async deleteKey(): Promise<ContentMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.deleteContentSettings();
      } catch {
        console.warn("[u7agent] content key delete failed");
        return { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(false);
      return {
        status: 200,
        response: this.#applied({
          configured: false,
          provider: null,
          imageModel: null,
          speechModel: null,
          speechVoice: null,
        }),
      };
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
      // SDK へ渡す前に保護対象へ入れる（削除・上書き後もプロセス生存中は外さない）
      if (row) this.#retainSecret(row.apiKey);
      // キーの有無で一覧の表示は変わらないが、未設定では一覧を出す画面が無いので取得しない
      if (row) {
        await this.#catalog.refresh();
        await this.#speechCatalog.refresh();
      }
      this.#apply(row !== undefined);
    });
  }

  #apply(enabled: boolean): void {
    this.#setContentGeneration({
      enabled,
      read: () => currentImageSettings(this.#db),
      // 実行のたびに現在のカタログを引く。形式の宣言を一覧から絞り込んだあとも、保存済みの選択はここで拾える
      readOutputFormats: (model) => this.#catalog.outputFormatsOf(model),
      readSpeech: () => this.#currentSpeechSettings(),
      readVoices: (model) => this.#speechCatalog.voicesOf(model),
    });
  }

  /**
   * DB 書込が確定した後の応答。値を知っている側から組み、read の成否に依存させない
   * （書込成功後の読取失敗を not_stored と誤伝しない）。カタログはメモリ上の現在値を載せる。
   */
  #applied(result: {
    configured: boolean;
    provider: string | null;
    imageModel: string | null;
    speechModel: string | null;
    speechVoice: string | null;
  }): ContentMutationResponse {
    const catalog = this.#catalog.snapshot();
    const speechCatalog = this.#speechCatalog.snapshot();
    // 未設定の行を「音声の既定」へ寄せないため、行の有無で分ける
    const speech = result.configured
      ? this.#speechSelection(result.speechModel, result.speechVoice)
      : { model: null, voice: "" };
    return {
      configured: result.configured,
      provider: result.provider,
      runtimeAvailable: this.#runtimeAvailable,
      image: {
        model: result.imageModel,
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
    };
  }
}

/** 画像ツールの語彙（`model`）へ写す。DB の列名 `imageModel` は設定面の語彙なので、対応はこの 1 箇所に閉じる */
function currentImageSettings(db: ContentSettingsDb): ImageGenerationSettings | undefined {
  const row = db.readContentSettings();
  return row ? { provider: row.provider, model: row.imageModel, apiKey: row.apiKey } : undefined;
}

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
