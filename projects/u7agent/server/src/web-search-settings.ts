/**
 * 設定 → モデル（Web 検索タブ）のサービス。第三者ホストを止めるのにデプロイを要さないよう、
 * アプリ DB の 1 行を正として実行時トグルを PiBff へ写す。契約は docs/web-search.md を正とする。
 */
import { messageFor } from "./http";
import { MutationLock } from "./model-settings";
import { WEB_SEARCH_DISABLED_MESSAGE, type WebSearchRuntimeConfig } from "./web-search-tool";
import type { WebSearchSettingsRow } from "./app-db";
import type { WebSearchMutationResponse, WebSearchSettingsResponse } from "./schema";

export const WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE = "Web 検索の設定をアプリデータ（SQLite）へ保存できませんでした";

export interface WebSearchSettingsDb {
  /** 行が無ければ undefined = 既定（有効） */
  readWebSearchSettings(): WebSearchSettingsRow | undefined;
  saveWebSearchSettings(settings: WebSearchSettingsRow): void;
}

export interface WebSearchSettingsOptions {
  db: WebSearchSettingsDb;
  /** 実行中のセッションが同じ関数を読むため、差し替えはロックの内側で行う */
  setWebSearchEnabled: (config: WebSearchRuntimeConfig) => void;
  /** health / ログへ出す前の文言境界（可変マスカー） */
  maskError: (text: string) => string;
}

export type WebSearchMutationOutcome =
  | { status: 200; response: WebSearchMutationResponse }
  | { status: 503; error: string };

export class WebSearchSettingsService {
  #db: WebSearchSettingsDb;
  #setWebSearchEnabled: (config: WebSearchRuntimeConfig) => void;
  #maskError: (text: string) => string;
  #lock = new MutationLock();

  constructor(options: WebSearchSettingsOptions) {
    this.#db = options.db;
    this.#setWebSearchEnabled = options.setWebSearchEnabled;
    this.#maskError = options.maskError;
  }

  /** DB の失敗は GET の 503 として伝える（設定画面が気付ける経路を残す） */
  settings(): WebSearchSettingsResponse {
    return { enabled: this.#db.readWebSearchSettings()?.enabled ?? true, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE };
  }

  async put(input: { enabled: boolean }): Promise<WebSearchMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.saveWebSearchSettings({ enabled: input.enabled });
      } catch {
        // DB の理由は AppDb の境界がマスクして記録するため、ここでは操作の分類だけを返す
        console.warn("[u7agent] web search settings save failed");
        return { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE };
      }
      this.#apply(input.enabled);
      return { status: 200, response: this.#applied(input.enabled) };
    });
  }

  /** DB を読めないだけで検索を黙って止めない（行が無い = 既定と同じ扱いにする） */
  async applyStored(): Promise<void> {
    await this.#lock.run(async () => {
      let enabled = true;
      try {
        enabled = this.#db.readWebSearchSettings()?.enabled ?? true;
      } catch (error) {
        console.error(`[u7agent] web search settings unavailable: ${this.#maskError(messageFor(error))}`);
        enabled = true;
      }
      this.#apply(enabled);
    });
  }

  #apply(enabled: boolean): void {
    this.#setWebSearchEnabled({ readEnabled: () => enabled });
  }

  /**
   * 保存が確定した後の応答。読取の成否に依存させない
   * （保存後の読取失敗を「保存できなかった」と誤伝しない）
   */
  #applied(enabled: boolean): WebSearchMutationResponse {
    return { enabled, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE, state: "applied" };
  }
}
