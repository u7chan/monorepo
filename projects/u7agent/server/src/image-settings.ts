/**
 * 設定 → モデル（画像生成タブ）のサービス。アプリ DB の `image_settings`（id = 1 の 1 行）を
 * 希望状態の正とし、行の有無を PiBff のツール公開 state へロックの内側で写す。
 * SDK への認証反映が無いため degraded は持たず、変更系の応答は常に `applied` になる。
 * 契約は docs/image-generation.md を正とする。
 */
import { messageFor } from "./http";
import { MutationLock } from "./model-settings";
import type { ImageSettingsRow } from "./app-db";
import type { ImageGenerationConfig, ImageCatalogEntry } from "./images";
import { type ImageMutationResponse, type ImageSettingsResponse } from "./schema";

/** v1 で受け付ける画像 provider。カタログから引くが、受け入れはこの 1 つに固定する */
export const IMAGE_PROVIDER_ID = "openrouter";

/** キー登録で作る行の既定モデル（直後に画面から変更できる） */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

export const IMAGE_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、画像APIキーを登録できません";
export const IMAGE_KEY_NOT_STORED_MESSAGE = "画像APIキーをアプリデータ（SQLite）へ保存できませんでした";
export const IMAGE_SETTINGS_NOT_STORED_MESSAGE = "画像生成の設定をアプリデータ（SQLite）へ保存できませんでした";
export const IMAGE_SETTINGS_UNCONFIGURED_MESSAGE = "画像APIキーが未設定です。先にキーを登録してください";
export const IMAGE_PROVIDER_UNSUPPORTED_MESSAGE = "画像生成のプロバイダーは openrouter だけです";
export const IMAGE_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い画像モデルは指定できません";

export interface ImageSettingsDb {
  /** 行が無ければ undefined = 未設定 */
  readImageSettings(): ImageSettingsRow | undefined;
  saveImageSettings(settings: ImageSettingsRow): void;
  deleteImageSettings(): boolean;
}

export interface ImageSettingsOptions {
  db: ImageSettingsDb;
  /** false（pi ランタイム初期化失敗）のときキー登録は 503。retainSecret が no-op になるため */
  runtimeAvailable: boolean;
  /** SDK / DB へ触る前に保護対象へ足す（マスカーの swap は同期） */
  retainSecret: (value: string) => void;
  /** 公開する選択肢。builtinImagesProviders() のカタログを渡す */
  catalog: () => ImageCatalogEntry[];
  /** PiBff の注入面。**同じロックの内側**で呼び、次に作るセッションへ即時反映する */
  setImageGeneration: (config: ImageGenerationConfig) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
}

export type ImageMutationOutcome = { status: 200; response: ImageMutationResponse } | { status: 503; error: string };

export class ImageSettingsService {
  #db: ImageSettingsDb;
  #runtimeAvailable: boolean;
  #retainSecret: (value: string) => void;
  #catalog: () => ImageCatalogEntry[];
  #setImageGeneration: (config: ImageGenerationConfig) => void;
  #maskError: (text: string) => string;
  #lock = new MutationLock();

  constructor(options: ImageSettingsOptions) {
    this.#db = options.db;
    this.#runtimeAvailable = options.runtimeAvailable;
    this.#retainSecret = options.retainSecret;
    this.#catalog = options.catalog;
    this.#setImageGeneration = options.setImageGeneration;
    this.#maskError = options.maskError;
  }

  /** GET。純粋読取で、キー値は返さない（DB の失敗は 503 のまま伝える） */
  settings(): ImageSettingsResponse {
    const row = this.#db.readImageSettings();
    return {
      configured: row !== undefined,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      models: this.#catalog(),
      runtimeAvailable: this.#runtimeAvailable,
    };
  }

  /** キーの登録・上書き。行が無ければ既定 provider / model で作る */
  async putKey(apiKey: string): Promise<ImageMutationOutcome> {
    return this.#lock.run(async () => {
      if (!this.#runtimeAvailable) {
        return { status: 503, error: IMAGE_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE };
      }
      let existing: ImageSettingsRow | undefined;
      try {
        existing = this.#db.readImageSettings();
      } catch (error) {
        // 行の有無を確定できないまま既定へ寄せない（provider / model を黙って巻き戻さない）
        console.warn(`[u7agent] image settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: IMAGE_KEY_NOT_STORED_MESSAGE };
      }
      // マスカーへの登録は DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      try {
        this.#db.saveImageSettings({
          provider: existing?.provider ?? IMAGE_PROVIDER_ID,
          model: existing?.model ?? DEFAULT_IMAGE_MODEL,
          apiKey,
        });
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] image key save failed");
        return { status: 503, error: IMAGE_KEY_NOT_STORED_MESSAGE };
      }
      this.#apply(true);
      return {
        status: 200,
        response: this.#applied(true, existing?.provider ?? IMAGE_PROVIDER_ID, existing?.model ?? DEFAULT_IMAGE_MODEL),
      };
    });
  }

  /** provider / model の変更。キーは保持し、行が無ければ 400（キー登録が先） */
  async putSelection(input: { provider: string; model: string }): Promise<ImageMutationOutcome> {
    return this.#lock.run(async () => {
      let existing: ImageSettingsRow | undefined;
      try {
        existing = this.#db.readImageSettings();
      } catch (error) {
        console.warn(`[u7agent] image settings read failed: ${this.#maskError(messageFor(error))}`);
        return { status: 503, error: IMAGE_SETTINGS_NOT_STORED_MESSAGE };
      }
      if (!existing) throw badRequest(IMAGE_SETTINGS_UNCONFIGURED_MESSAGE);
      if (input.provider !== IMAGE_PROVIDER_ID) throw badRequest(IMAGE_PROVIDER_UNSUPPORTED_MESSAGE);
      const inCatalog = this.#catalog().some((entry) => entry.provider === input.provider && entry.id === input.model);
      // 入力を反射する文言はマスカーを通す（model にキーを誤って渡されたとき、400 応答から再露出させない）
      if (!inCatalog) throw badRequest(`${IMAGE_MODEL_NOT_IN_CATALOG_MESSAGE}: ${this.#maskError(input.model)}`);
      try {
        this.#db.saveImageSettings({ ...existing, provider: input.provider, model: input.model });
      } catch {
        console.warn("[u7agent] image settings save failed");
        return { status: 503, error: IMAGE_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(true);
      return { status: 200, response: this.#applied(true, input.provider, input.model) };
    });
  }

  /**
   * キーの削除（行ごと消す）。未設定でも 200 を返す（削除は冪等で、画面は行の有無だけを見る）。
   * 有効なキーは 8..2048 文字なので、これが未設定へ戻る唯一の導線になる。
   */
  async deleteKey(): Promise<ImageMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.deleteImageSettings();
      } catch {
        console.warn("[u7agent] image key delete failed");
        return { status: 503, error: IMAGE_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(false);
      return { status: 200, response: this.#applied(false, null, null) };
    });
  }

  /**
   * 起動時の適用。DB を読めないときは無効で立ち、警告だけを残す（設定 API は DB の 503 で気付ける）。
   * `read` は常に差し替えるため、既存セッションの execute は削除後も現在の行を見に行く。
   */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      let row: ImageSettingsRow | undefined;
      try {
        row = this.#db.readImageSettings();
      } catch (error) {
        console.error(`[u7agent] image settings unavailable: ${this.#maskError(messageFor(error))}`);
        row = undefined;
      }
      // SDK へ渡す前に保護対象へ入れる（削除・上書き後もプロセス生存中は外さない）
      if (row) this.#retainSecret(row.apiKey);
      this.#apply(row !== undefined);
    });
  }

  #apply(enabled: boolean): void {
    this.#setImageGeneration({ enabled, read: () => this.#db.readImageSettings() });
  }

  /**
   * DB 書込が確定した後の応答。値を知っている側から組み、read の成否に依存させない
   * （書込成功後の読取失敗を not_stored と誤伝しない）。
   */
  #applied(configured: boolean, provider: string | null, model: string | null): ImageMutationResponse {
    let models: ImageCatalogEntry[];
    try {
      models = this.#catalog();
    } catch {
      // カタログは静的なので通常は起こらない。組めないときは空で返し、次の GET に追随させる
      models = [];
    }
    return { configured, provider, model, models, runtimeAvailable: this.#runtimeAvailable, state: "applied" };
  }
}

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
