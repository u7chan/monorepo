/**
 * 設定 → Web 検索のサービス。アプリ DB の 1 行を正として有効 / 無効と既定 provider を持ち、
 * provider ごとの APIキーは別テーブルへ 1 行 1 provider で持つ。写しは実行中のセッションが読む PiBff へ
 * ロックの内側で渡す。契約は docs/web-search.md を正とする。
 */
import {
  APP_SECRET_NOT_STORED_MESSAGE,
  appSecretAvailable,
  appSecretFailed,
  appSecretMasterKeyMissing,
  appSecretUnevaluated,
  type AppSecretState,
} from "./app-secrets";
import { messageFor } from "./http";
import { MutationLock } from "./model-settings";
import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  WEB_SEARCH_PROVIDER_IDS,
  webSearchProvider,
  webSearchProviderCatalog,
  webSearchProviderIdOf,
  type WebSearchProviderId,
} from "./web-search-providers";
import { WEB_SEARCH_DISABLED_MESSAGE, type WebSearchRuntimeConfig } from "./web-search-tool";
import type { StoredAppSecret, WebSearchSettingsRow } from "./app-db";
import type { AppSecretCipher } from "./secret-crypto";
import type { WebSearchMutationResponse, WebSearchSettingsResponse } from "./schema";

export const WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE = "Web 検索の設定をアプリデータ（SQLite）へ保存できませんでした";
export const WEB_SEARCH_KEY_NOT_STORED_MESSAGE = "Web 検索の APIキーをアプリデータ（SQLite）へ保存できませんでした";
export const WEB_SEARCH_PROVIDER_UNSUPPORTED_MESSAGE = "未知の検索プロバイダーは指定できません";
export const WEB_SEARCH_KEYLESS_UNSUPPORTED_MESSAGE = "キー不要の検索プロバイダーには APIキーを登録できません";
export const WEB_SEARCH_RUNTIME_UNAVAILABLE_MESSAGE =
  "ランタイムが利用できないため、Web 検索の APIキーを変更できません";

export interface WebSearchSettingsDb {
  /** 行が無ければ undefined = 既定（有効 / exa） */
  readWebSearchSettings(): WebSearchSettingsRow | undefined;
  saveWebSearchSettings(settings: WebSearchSettingsRow): void;
  /** 行が無ければ undefined = キー未設定。値は暗号文で、復号はサービスが行う */
  readWebSearchProviderKey(provider: string): StoredAppSecret | undefined;
  saveWebSearchProviderKey(provider: string, secret: StoredAppSecret): void;
  deleteWebSearchProviderKey(provider: string): boolean;
}

export interface WebSearchSettingsOptions {
  db: WebSearchSettingsDb;
  /** 実行中のセッションが同じ関数を読むため、差し替えはロックの内側で行う */
  setWebSearch: (config: WebSearchRuntimeConfig) => void;
  /** DB へ渡す前に保護対象へ足す（マスカーの swap は同期） */
  retainSecret: (value: string) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
  /** アプリ DB のキー用の AEAD。master key が無い / 不正なときは null で、保存と復号を拒否する */
  cipher?: AppSecretCipher | null;
  /**
   * SDK ランタイムを初期化できたか。false のときは復号せず、保存済みキーを「未評価」にする。
   * 復号した値を使う経路が無いため、メモリにも残さない。
   */
  runtimeAvailable?: boolean;
}

/** 書込の確定後すぐ応答と写しを作れるよう、値を知っている側から組み立てる */
interface WebSearchState {
  enabled: boolean;
  provider: WebSearchProviderId;
  keys: Map<WebSearchProviderId, string>;
}

export type WebSearchMutationOutcome =
  | { status: 200; response: WebSearchMutationResponse }
  | { status: 503; error: string };

export class WebSearchSettingsService {
  #db: WebSearchSettingsDb;
  #setWebSearch: (config: WebSearchRuntimeConfig) => void;
  #retainSecret: (value: string) => void;
  #maskError: (text: string) => string;
  #lock = new MutationLock();
  #state: WebSearchState = { enabled: true, provider: DEFAULT_WEB_SEARCH_PROVIDER, keys: new Map() };
  #cipher: AppSecretCipher | null;
  #runtimeAvailable: boolean;
  /** 保存済みキーの復号結果。起動時と保存 / 置換のときだけ更新し、GET では復号しない */
  #secretStates = new Map<WebSearchProviderId, AppSecretState>();

  constructor(options: WebSearchSettingsOptions) {
    this.#db = options.db;
    this.#setWebSearch = options.setWebSearch;
    this.#retainSecret = options.retainSecret;
    this.#maskError = options.maskError;
    this.#cipher = options.cipher ?? null;
    this.#runtimeAvailable = options.runtimeAvailable ?? true;
  }

  /** GET。DB の失敗はそのまま 503 として伝える（設定画面が気付ける経路を残す）。キー値は返さない */
  settings(): WebSearchSettingsResponse {
    const row = this.#db.readWebSearchSettings();
    return this.#response(row?.enabled ?? true, webSearchProviderIdOf(row?.provider), (provider) => ({
      // 暗号文の有無だけを読み、復号はしない
      stored: this.#db.readWebSearchProviderKey(provider) !== undefined,
      state: this.#secretStates.get(provider) ?? appSecretUnevaluated(),
    }));
  }

  /** 有効 / 無効。既存行の provider を保持したまま upsert する */
  async putEnabled(enabled: boolean): Promise<WebSearchMutationOutcome> {
    return this.#lock.run(async () => {
      const stored = this.#readStored();
      if (!stored.ok) return { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE };
      const provider = webSearchProviderIdOf(stored.row?.provider);
      if (!this.#save({ enabled, provider })) return { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE };
      this.#state = { ...this.#state, enabled, provider };
      this.#apply();
      return { status: 200, response: this.#applied() };
    });
  }

  /** 既定 provider。既存行の enabled を保持したまま upsert する */
  async putProvider(provider: string): Promise<WebSearchMutationOutcome> {
    return this.#lock.run(async () => {
      const id = this.#knownProvider(provider);
      const stored = this.#readStored();
      if (!stored.ok) return { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE };
      const enabled = stored.row?.enabled ?? true;
      if (!this.#save({ enabled, provider: id })) {
        return { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#state = { ...this.#state, enabled, provider: id };
      this.#apply();
      return { status: 200, response: this.#applied() };
    });
  }

  /** provider のキーの登録・上書き。キー値は応答に載せない */
  async putKey(provider: string, apiKey: string): Promise<WebSearchMutationOutcome> {
    return this.#lock.run(async () => {
      const id = this.#keyedProvider(provider);
      if (!this.#runtimeAvailable) return { status: 503, error: WEB_SEARCH_RUNTIME_UNAVAILABLE_MESSAGE };
      // マスカーへの登録は DB より前。ここが失敗しても保護対象だけは残す
      this.#retainSecret(apiKey);
      let secret: StoredAppSecret;
      try {
        secret = this.#requireCipher().encrypt("web_search_provider_keys", id, apiKey);
      } catch {
        // master key 未設定 / 不正では平文で保存しない
        console.warn("[u7agent] web search key encryption failed");
        return { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE };
      }
      try {
        this.#db.saveWebSearchProviderKey(id, secret);
      } catch {
        // DB の理由は AppDb の境界がマスクして記録する。ここは操作の分類だけに絞る
        console.warn("[u7agent] web search key save failed");
        return { status: 503, error: WEB_SEARCH_KEY_NOT_STORED_MESSAGE };
      }
      this.#secretStates.set(id, appSecretAvailable());
      this.#state = { ...this.#state, keys: new Map(this.#state.keys).set(id, apiKey) };
      this.#apply();
      return { status: 200, response: this.#applied() };
    });
  }

  /** キーの削除（行ごと消して未設定へ戻す）。未設定でも 200 を返す（削除は冪等） */
  async deleteKey(provider: string): Promise<WebSearchMutationOutcome> {
    return this.#lock.run(async () => {
      const id = this.#keyedProvider(provider);
      try {
        this.#db.deleteWebSearchProviderKey(id);
      } catch {
        console.warn("[u7agent] web search key delete failed");
        return { status: 503, error: WEB_SEARCH_KEY_NOT_STORED_MESSAGE };
      }
      const keys = new Map(this.#state.keys);
      keys.delete(id);
      // 復号は不要 (暗号文を読まない)。復号結果のキャッシュも「未保存」へ戻す
      this.#secretStates.delete(id);
      this.#state = { ...this.#state, keys };
      this.#apply();
      return { status: 200, response: this.#applied() };
    });
  }

  /** DB を読めないだけで検索を黙って止めない（行が無い = 既定と同じ扱いにする） */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      let row: WebSearchSettingsRow | undefined;
      const keys = new Map<WebSearchProviderId, string>();
      try {
        row = this.#db.readWebSearchSettings();
        for (const info of webSearchProviderCatalog()) {
          if (info.keyless) continue;
          const secret = this.#db.readWebSearchProviderKey(info.id);
          if (!secret) continue;
          const apiKey = this.#evaluateKey(info.id, secret);
          if (apiKey !== null) keys.set(info.id, apiKey);
        }
      } catch (error) {
        // 途中まで復号できたキーも保護対象へは残す（写しは既定へ倒すだけで、値は捨てない）
        console.error(`[u7agent] web search settings unavailable: ${this.#maskError(messageFor(error))}`);
      }
      this.#state = { enabled: row?.enabled ?? true, provider: webSearchProviderIdOf(row?.provider), keys };
      this.#apply();
    });
  }

  /**
   * 保存済みの暗号文を復号し、結果をメモリへ残す。runtime が無いときは復号しない（使う経路が無いため）。
   * 復号した値は写しへ渡す前に保護対象へ入れる。
   */
  #evaluateKey(id: WebSearchProviderId, secret: StoredAppSecret): string | null {
    if (!this.#runtimeAvailable) {
      this.#secretStates.set(id, appSecretUnevaluated());
      return null;
    }
    if (!this.#cipher) {
      this.#secretStates.set(id, appSecretMasterKeyMissing());
      return null;
    }
    try {
      const apiKey = this.#cipher.decrypt("web_search_provider_keys", id, secret);
      this.#retainSecret(apiKey);
      this.#secretStates.set(id, appSecretAvailable());
      return apiKey;
    } catch {
      // 誤鍵・未知の鍵版・改ざんは区別せず、平文へも落とさない
      this.#secretStates.set(id, appSecretFailed());
      return null;
    }
  }

  #requireCipher(): AppSecretCipher {
    if (!this.#cipher) throw new Error(APP_SECRET_NOT_STORED_MESSAGE);
    return this.#cipher;
  }

  #apply(): void {
    this.#setWebSearch({
      readEnabled: () => this.#state.enabled,
      readProvider: () => this.#state.provider,
      readApiKey: (provider) => this.#state.keys.get(provider),
    });
  }

  /** 読取の失敗は「保存できなかった」と同じ分類にし、503 の理由へ写す */
  #readStored(): { ok: true; row: WebSearchSettingsRow | undefined } | { ok: false } {
    try {
      return { ok: true, row: this.#db.readWebSearchSettings() };
    } catch (error) {
      console.warn(`[u7agent] web search settings read failed: ${this.#maskError(messageFor(error))}`);
      return { ok: false };
    }
  }

  #save(row: WebSearchSettingsRow): boolean {
    try {
      this.#db.saveWebSearchSettings(row);
      return true;
    } catch (error) {
      // DB の理由は AppDb の境界がマスクして記録するため、ここでは操作の分類だけを返す
      console.warn(`[u7agent] web search settings save failed: ${this.#maskError(messageFor(error))}`);
      return false;
    }
  }

  /** API 入力の検証。未知の値は既定へ畳まず 400 にする（保存値を黙って書き換えない） */
  #knownProvider(raw: string): WebSearchProviderId {
    const id = WEB_SEARCH_PROVIDER_IDS.find((candidate) => candidate === raw);
    if (id === undefined) throw badRequest(WEB_SEARCH_PROVIDER_UNSUPPORTED_MESSAGE);
    return id;
  }

  #keyedProvider(raw: string): WebSearchProviderId {
    const id = this.#knownProvider(raw);
    if (webSearchProvider(id).keyless) throw badRequest(WEB_SEARCH_KEYLESS_UNSUPPORTED_MESSAGE);
    return id;
  }

  /** 応答の組み立て。GET は DB の値、変更系は確定済みの写しから作る（書込後の読取に依存させない） */
  #response(
    enabled: boolean,
    provider: WebSearchProviderId,
    keyOf: (provider: WebSearchProviderId) => { stored: boolean; state: AppSecretState },
  ): WebSearchSettingsResponse {
    return {
      enabled,
      provider,
      providers: webSearchProviderCatalog().map((info) =>
      // キー不要の provider は「キーが無くても使える」を明示する (未設定と同じ見た目にしない)
      {
        if (info.keyless) {
          return {
            ...info,
            configured: true,
            keyStored: false,
            keyAvailable: true,
            keyEvaluated: true,
            keyErrorMessage: null,
          };
        }
        const { stored, state } = keyOf(info.id);
        return {
          ...info,
          configured: stored,
          keyStored: stored,
          keyAvailable: stored && state.keyAvailable,
          keyEvaluated: stored ? state.keyEvaluated : true,
          keyErrorMessage: stored ? state.keyErrorMessage : null,
        };
      }),
      disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
    };
  }

  #applied(): WebSearchMutationResponse {
    return {
      ...this.#response(this.#state.enabled, this.#state.provider, (provider) => ({
        stored: this.#storedKey(provider),
        // 変更系の応答は復号をやり直さない。未評価なら未評価のまま返す
        state: this.#secretStates.get(provider) ?? appSecretUnevaluated(),
      })),
      state: "applied",
    };
  }

  /** 暗号文の有無。読めないときは写しのキーで代用し、応答を組めなくしない */
  #storedKey(provider: WebSearchProviderId): boolean {
    try {
      return this.#db.readWebSearchProviderKey(provider) !== undefined;
    } catch {
      return this.#state.keys.has(provider) || this.#secretStates.has(provider);
    }
  }
}

function badRequest(message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
