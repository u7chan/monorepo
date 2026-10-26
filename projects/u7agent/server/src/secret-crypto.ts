/**
 * シークレット行の保存時暗号化 (AES-256-GCM)。master key はアプリ DB と別経路 (ホストの環境変数 /
 * 鍵ファイル) から受け取り、DB には鍵そのものを保存しない。保存形式・鍵の書式・失敗時の契約は
 * docs/secrets.md を正とする。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/** master key を直接渡す環境変数。値の書式は parseMasterKeys() を参照 */
export const SECRET_MASTER_KEY_ENV = "U7AGENT_SECRET_MASTER_KEY";
/** master key を書いたファイルのパス。env が優先で、こちらは同じ書式のテキストを読む */
export const SECRET_MASTER_KEY_FILE_ENV = "U7AGENT_SECRET_MASTER_KEY_FILE";

/** AEAD の鍵長 (AES-256) */
export const SECRET_KEY_BYTES = 32;
/** GCM の nonce 長。毎回の保存で作り直す (再利用しない) */
export const SECRET_NONCE_BYTES = 12;
/** GCM の認証タグ長。ciphertext の末尾に付けて 1 つの BLOB として保存する */
export const SECRET_TAG_BYTES = 16;

/**
 * AAD に含めるラベル。cwd / スコープは含めない (スコープ変更やコピーで復号を要さないため)。
 * 名前と種別は変更できないため固定しても破綻しない。
 */
const AAD_LABEL = "u7agent-secret";
/**
 * アプリ DB の APIキー / Webhook URL 用のラベル。環境変数シークレットとは別のラベルにして、
 * 片方の暗号文をもう片方の用途で復号できないようにする。
 */
const APP_AAD_LABEL = "u7agent-app-secret";

export type SecretKeyFailure = "missing" | "malformed" | "unknown_version" | "decrypt_failed";

/**
 * 鍵の入手不能 / 復号不能。呼び出し側は平文保存や「秘密なし起動」へ黙って落とさず、秘密の利用を拒否する。
 * 文言には鍵の断片を含めない。
 */
export class SecretKeyError extends Error {
  constructor(
    message: string,
    readonly reason: SecretKeyFailure,
  ) {
    super(message);
    this.name = "SecretKeyError";
  }
}

export interface MasterKeyRing {
  /** 新しい保存に使う版 (宣言された最大の版) */
  currentVersion: number;
  get(version: number): Buffer | undefined;
}

/**
 * master key の書式: `<版>:<base64 の 32 バイト鍵>` をカンマまたは空白区切りで並べる (例 `1:AAAA...`)。
 * 複数の版を書くと、読み出しは版ごとに選び、新しい保存は最大の版を使う (rotation 前提の形だけ用意する)。
 * 壊れた宣言は起動時の設定ミスなので、黙って落とさず SecretKeyError にする。
 */
export function parseMasterKeys(raw: string): MasterKeyRing {
  const keys = new Map<number, Buffer>();
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new SecretKeyError(`${SECRET_MASTER_KEY_ENV} が空です`, "malformed");
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    const versionText = separator < 0 ? "" : entry.slice(0, separator);
    const keyText = separator < 0 ? "" : entry.slice(separator + 1);
    const version = Number(versionText);
    if (!/^[0-9]+$/.test(versionText) || !Number.isInteger(version) || version < 1) {
      throw new SecretKeyError(
        `${SECRET_MASTER_KEY_ENV} の書式が不正です (<版>:<base64 の鍵> を並べてください)`,
        "malformed",
      );
    }
    if (keys.has(version))
      throw new SecretKeyError(`${SECRET_MASTER_KEY_ENV} の版 ${version} が重複しています`, "malformed");
    const key = Buffer.from(keyText, "base64");
    if (key.length !== SECRET_KEY_BYTES) {
      throw new SecretKeyError(
        `${SECRET_MASTER_KEY_ENV} の版 ${version} の鍵は ${SECRET_KEY_BYTES} バイト必要です`,
        "malformed",
      );
    }
    keys.set(version, key);
  }
  return {
    currentVersion: Math.max(...keys.keys()),
    get: (version) => keys.get(version),
  };
}

/**
 * 環境変数 (またはその指すファイル) から master key を解決する。未設定は null で、このとき
 * シークレットの登録・復号は拒否する (変数は平文なので影響しない)。
 */
export function resolveMasterKeys(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): MasterKeyRing | null {
  const inline = env[SECRET_MASTER_KEY_ENV]?.trim();
  if (inline) return parseMasterKeys(inline);
  const path = env[SECRET_MASTER_KEY_FILE_ENV]?.trim();
  if (!path) return null;
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SecretKeyError(`${SECRET_MASTER_KEY_FILE_ENV} のファイルを読めません: ${message}`, "malformed");
  }
  return parseMasterKeys(text);
}

export type SecretKind = "variable" | "secret";

/** 暗号文の保存形。nonce とタグ (ciphertext 末尾) は行の BLOB 列へ入れる */
export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

/** AAD はラベル + 種別 + 名前。復号時に同じ値を組み立てるため、名前の変更は保存値の破棄を伴う */
function additionalData(kind: SecretKind, name: string): Buffer {
  return Buffer.from(`${AAD_LABEL}:${kind}:${name}`, "utf8");
}

/**
 * アプリ DB のキー / Webhook の用途。値はテーブル (内容が同じでも用途の違う `content_settings` など) を
 * 表し、AAD の 2 要素目になる。保存済みの値を復号できなくなるため変更できない。
 */
export type AppSecretScope =
  | "provider_credentials"
  | "content_settings"
  | "web_search_provider_keys"
  | "notification_settings";

/** AAD はラベル + 用途 + 所有者。所有者は provider id や固定の列名で、行を別の用途へ差し替えると復号できない */
function appAdditionalData(scope: AppSecretScope, owner: string): Buffer {
  return Buffer.from(`${APP_AAD_LABEL}:${scope}:${owner}`, "utf8");
}

export interface SecretCipher {
  encrypt(kind: SecretKind, name: string, plaintext: string): EncryptedSecret;
  decrypt(
    kind: SecretKind,
    name: string,
    stored: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number },
  ): string;
}

/** 鍵輪から 1 回ぶんの AEAD を組み立てる。AAD だけを差し替えて、用途ごとの暗号を作る */
function seal(ring: MasterKeyRing, aad: Buffer, plaintext: string): EncryptedSecret {
  const key = ring.get(ring.currentVersion);
  if (!key) throw new SecretKeyError(`版 ${ring.currentVersion} の鍵がありません`, "unknown_version");
  const nonce = randomBytes(SECRET_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext, nonce, keyVersion: ring.currentVersion };
}

/**
 * 復号の失敗はすべて SecretKeyError へ寄せ、例外の詳細 (Node の文言) を上位へ出さない。
 * `message` は保存値の種類を言い分けるためだけに使い、値そのものは含めない。
 */
function open(
  ring: MasterKeyRing,
  aad: Buffer,
  stored: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number },
  message: string,
): string {
  const key = ring.get(stored.keyVersion);
  if (!key) {
    throw new SecretKeyError(
      `${message}の鍵バージョン ${stored.keyVersion} に対応する master key がありません`,
      "unknown_version",
    );
  }
  const ciphertext = Buffer.from(stored.ciphertext);
  const nonce = Buffer.from(stored.nonce);
  if (nonce.length !== SECRET_NONCE_BYTES || ciphertext.length < SECRET_TAG_BYTES) {
    throw new SecretKeyError(`${message}を復号できません`, "decrypt_failed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - SECRET_TAG_BYTES));
    return Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - SECRET_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // 誤鍵・改ざん・AAD 不一致は区別しない (どれも「復号できない」で利用を拒否する)
    throw new SecretKeyError(
      `${message}を復号できません (master key が違うか、保存値が壊れています)`,
      "decrypt_failed",
    );
  }
}

/**
 * 鍵輪から AEAD を組み立てる。復号の失敗はすべて SecretKeyError("decrypt_failed") へ寄せ、
 * 例外の詳細 (Node の文言) を上位へ出さない。
 */
export function createSecretCipher(ring: MasterKeyRing): SecretCipher {
  return {
    encrypt: (kind, name, plaintext) => seal(ring, additionalData(kind, name), plaintext),
    decrypt: (kind, name, stored) => open(ring, additionalData(kind, name), stored, "保存されたシークレット"),
  };
}

/**
 * アプリ DB の APIキー / Webhook URL 用の AEAD。用途 (テーブル) と所有者を AAD に含め、
 * 環境変数シークレットの暗号文を APIキーとして復号するような取り違えを検出する。
 * カスタムプロバイダーなど後から足すテーブルも、scope を増やして同じ形で保存する。
 */
export interface AppSecretCipher {
  encrypt(scope: AppSecretScope, owner: string, plaintext: string): EncryptedSecret;
  decrypt(
    scope: AppSecretScope,
    owner: string,
    stored: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number },
  ): string;
}

export function createAppSecretCipher(ring: MasterKeyRing): AppSecretCipher {
  return {
    encrypt: (scope, owner, plaintext) => seal(ring, appAdditionalData(scope, owner), plaintext),
    decrypt: (scope, owner, stored) =>
      open(ring, appAdditionalData(scope, owner), stored, "保存された APIキーまたは Webhook URL"),
  };
}
