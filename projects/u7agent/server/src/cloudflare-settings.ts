/**
 * Cloudflare の資格情報（アカウント ID と暗号化した API トークン）を BFF 専用で保存する。
 * 契約は docs/static-sharing.md を正とする。
 */
import type { CloudflareSettingsRow } from "./app-db";
import { httpError } from "./http";
import { MutationLock } from "./model-settings";
import { SecretKeyError, type SecretCipher } from "./secret-crypto";
import { retainIfLongEnough } from "./secrets";
import type { CloudflareMutationResponse, CloudflareSettingsResponse, UpdateCloudflareSettingsBody } from "./schema";

/** トークンの暗号化に使う AAD の名前。変更すると保存済みの値を復号できなくなる */
const TOKEN_SECRET_NAME = "cloudflare-api-token";
const TOKEN_SECRET_KIND = "secret" as const;

/** アカウント ID の形式。Cloudflare のアカウント ID は 32 桁の 16 進数 */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** API トークンは空白を含まない印字可能 ASCII。長さだけを緩く縛る (形式の変更で保存できなくしない) */
const TOKEN_PATTERN = /^[\x21-\x7e]{20,512}$/;

export const CLOUDFLARE_ACCOUNT_ID_ERROR = "Cloudflare のアカウント ID は 32 桁の 16 進数で入力してください";
export const CLOUDFLARE_TOKEN_REQUIRED_ERROR = "Cloudflare の API トークンを入力してください";
export const CLOUDFLARE_TOKEN_FORMAT_ERROR =
  "Cloudflare の API トークンの形式が不正です（空白・改行を含まない印字可能な文字で入力してください）";
export const CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR =
  "Cloudflare の資格情報を暗号化できません。サーバーの master key 設定を確認してください";
export const CLOUDFLARE_READ_ERROR = "Cloudflare の資格情報を読み取れません";
export const CLOUDFLARE_SAVE_ERROR = "Cloudflare の資格情報を保存できませんでした";
export const CLOUDFLARE_DELETE_ERROR = "Cloudflare の資格情報を削除できませんでした";
export const CLOUDFLARE_DECRYPT_ERROR =
  "Cloudflare の API トークンを復号できません。master key の設定を確認し、トークンを再登録してください";
export const CLOUDFLARE_ACCOUNT_SWITCH_ERROR =
  "別の Cloudflare アカウントで公開した共有コンテンツが残っています。先に旧アカウントで停止・削除してから登録してください";
/** 未登録の案内。公開の受付と接続確認が同じ文を使う（二重に持たない） */
export const SHARED_CONTENT_NO_CREDENTIALS = "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください";

/** サービスが要求する DB の読み書き。テストはこの形の stub を渡す */
export interface CloudflareSettingsDb {
  readCloudflareSettings(): CloudflareSettingsRow | undefined;
  saveCloudflareSettings(settings: CloudflareSettingsRow): void;
  deleteCloudflareSettings(): boolean;
  /** 未公開の行 (providerAccount が NULL) は対象外 */
  hasSharedContentsForOtherAccount(accountId: string): boolean;
}

export interface CloudflareSettingsOptions {
  db: CloudflareSettingsDb;
  /** master key が無いときは null。登録と復号は 503 で拒否する */
  cipher: SecretCipher | null;
  /** 保存・復号したトークンをログ / 例外のマスク対象へ足す */
  retainSecret: (value: string) => void;
  /** テスト用。省略時は Date.now */
  now?: () => number;
}

/**
 * `credential` は BFF の公開処理と接続確認だけが使う。API 応答へ載せる経路を作らない
 * （接続確認もトークンを応答・ログ・例外へ出さない）。
 */
export interface CloudflareCredential {
  accountId: string;
  apiToken: string;
}

export class CloudflareSettingsService {
  #db: CloudflareSettingsDb;
  #cipher: SecretCipher | null;
  #retainSecret: (value: string) => void;
  #now: () => number;
  #lock = new MutationLock();

  constructor({ db, cipher, retainSecret, now }: CloudflareSettingsOptions) {
    this.#db = db;
    this.#cipher = cipher;
    this.#retainSecret = retainSecret;
    this.#now = now ?? Date.now;
  }

  /** GET / PUT / DELETE の応答。トークンは常に返さない */
  status(): CloudflareSettingsResponse {
    const row = this.#read();
    return {
      configured: row !== undefined,
      accountId: row?.accountId ?? null,
      available: this.#cipher !== null,
      unavailableReason: this.#cipher === null ? CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR : null,
    };
  }

  /**
   * 登録・更新。トークンを省略した更新は保存済みの暗号文を維持する。
   * アカウント ID を変える要求は、別アカウントの共有物が残っている間は拒否する。
   */
  async save(input: UpdateCloudflareSettingsBody): Promise<CloudflareMutationResponse> {
    return this.#lock.run(async () => {
      const accountId = input.accountId.trim().toLowerCase();
      if (!ACCOUNT_ID_PATTERN.test(accountId)) throw httpError(400, CLOUDFLARE_ACCOUNT_ID_ERROR);
      const apiToken = input.apiToken?.trim() ?? "";
      if (apiToken && !TOKEN_PATTERN.test(apiToken)) throw httpError(400, CLOUDFLARE_TOKEN_FORMAT_ERROR);
      // トークンを省略する更新でも、master key が無ければ既存の暗号文を扱えないため 503 にする
      const cipher = this.#requireCipher();

      const existing = this.#read();
      if (!existing && !apiToken) throw httpError(400, CLOUDFLARE_TOKEN_REQUIRED_ERROR);
      if (this.#db.hasSharedContentsForOtherAccount(accountId)) throw httpError(409, CLOUDFLARE_ACCOUNT_SWITCH_ERROR);

      let row: CloudflareSettingsRow;
      if (apiToken) {
        const encrypted = cipher.encrypt(TOKEN_SECRET_KIND, TOKEN_SECRET_NAME, apiToken);
        retainIfLongEnough(this.#retainSecret, apiToken);
        row = {
          accountId,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          keyVersion: encrypted.keyVersion,
          updatedAt: this.#now(),
        };
      } else {
        // ここへ来るのは保存済みの行があり、トークンを変えない更新だけ
        row = { ...existing!, accountId, updatedAt: this.#now() };
      }
      try {
        this.#db.saveCloudflareSettings(row);
      } catch {
        // DB の例外文言は応答へ出さない。保存できていないことだけを 503 で示す
        throw httpError(503, CLOUDFLARE_SAVE_ERROR);
      }
      return {
        configured: true,
        accountId: row.accountId,
        available: this.#cipher !== null,
        unavailableReason: this.#cipher === null ? CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR : null,
        state: "applied" as const,
      };
    });
  }

  /** 削除。行が無くても成功する (冪等)。削除後の読み取りに依存させない (壊れた行からも復旧できる) */
  async remove(): Promise<CloudflareMutationResponse> {
    return this.#lock.run(async () => {
      try {
        this.#db.deleteCloudflareSettings();
      } catch {
        throw httpError(503, CLOUDFLARE_DELETE_ERROR);
      }
      return {
        configured: false,
        accountId: null,
        available: this.#cipher !== null,
        unavailableReason: this.#cipher === null ? CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR : null,
        state: "applied" as const,
      };
    });
  }

  /**
   * 公開処理へ渡す平文。行が無ければ null。復号した値もマスク対象へ足す。
   * 値はログ・例外・応答へ載せない。
   */
  credential(): CloudflareCredential | null {
    const row = this.#read();
    if (!row) return null;
    const cipher = this.#requireCipher();
    try {
      const apiToken = cipher.decrypt(TOKEN_SECRET_KIND, TOKEN_SECRET_NAME, row);
      retainIfLongEnough(this.#retainSecret, apiToken);
      return { accountId: row.accountId, apiToken };
    } catch (error) {
      if (error instanceof SecretKeyError) throw httpError(503, CLOUDFLARE_DECRYPT_ERROR);
      throw error;
    }
  }

  #read(): CloudflareSettingsRow | undefined {
    try {
      return this.#db.readCloudflareSettings();
    } catch {
      // 壊れた行を「未登録」と読み違えて上書きしない。削除で復旧できる。
      // 例外の詳細 (値の断片を含み得る) は応答・ログへ出さない
      console.warn("[u7agent] cloudflare settings read failed");
      throw httpError(503, CLOUDFLARE_READ_ERROR);
    }
  }

  #requireCipher(): SecretCipher {
    if (!this.#cipher) throw httpError(503, CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR);
    return this.#cipher;
  }
}
