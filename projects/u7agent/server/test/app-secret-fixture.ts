/**
 * アプリ DB のキー / Webhook URL の暗号化テスト用の固定鍵と保存形。
 * 実際の APIキー・master key は使わず、往復と分類だけを検証する。
 */
import type { StoredAppSecret } from "../src/app-db";
import {
  createAppSecretCipher,
  parseMasterKeys,
  type AppSecretCipher,
  type AppSecretScope,
  type EncryptedSecret,
} from "../src/secret-crypto";

/** テスト専用の固定鍵 (32 バイト) を 1 版だけ持つ鍵輪。本物の master key ではない */
export const TEST_MASTER_KEY = `1:${Buffer.alloc(32, 7).toString("base64")}`;

export function testAppCipher(masterKey: string = TEST_MASTER_KEY): AppSecretCipher {
  return createAppSecretCipher(parseMasterKeys(masterKey));
}

/** 検証用のダミー値。長さだけ実キーに近づけ、実在の値とは関係しない */
export const TEST_API_KEY = "sk-test-dummy-key-0123456789abcdef";
export const TEST_WEBHOOK_URL = "https://discord.com/api/webhooks/1234567890/test-token";

/** 暗号化を通さずに保存形を作る (DB 層の往復だけを見るテスト用)。鍵版は fill に揃える */
export function storedSecret(fill = 1): StoredAppSecret {
  return {
    ciphertext: new Uint8Array([fill, 2, 3, 4]),
    nonce: new Uint8Array(12).fill(fill),
    keyVersion: fill,
  };
}

/** 実体の AEAD で暗号化した保存形。サービス層の復号まで通すテスト用 */
export function encryptedSecret(
  scope: AppSecretScope,
  owner: string,
  plaintext: string = TEST_API_KEY,
): EncryptedSecret {
  return testAppCipher().encrypt(scope, owner, plaintext);
}
