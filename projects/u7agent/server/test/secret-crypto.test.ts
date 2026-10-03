// シークレットの保存時暗号化 (AES-256-GCM) と master key の解決。実 API は呼ばない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSecretCipher,
  parseMasterKeys,
  resolveMasterKeys,
  SecretKeyError,
  SECRET_MASTER_KEY_ENV,
  SECRET_MASTER_KEY_FILE_ENV,
  SECRET_KEY_BYTES,
  SECRET_NONCE_BYTES,
} from "../src/secret-crypto";

/** ダミー鍵。実値は使わない (値そのものはテストの識別用) */
const keyOf = (fill: number): string => Buffer.alloc(SECRET_KEY_BYTES, fill).toString("base64");

function ringOf(spec: string) {
  return parseMasterKeys(spec);
}

test("master key は <版>:<base64 32 バイト> を並べ、新しい保存は最大の版を使う", () => {
  const ring = ringOf(`1:${keyOf(1)},7:${keyOf(7)}`);
  assert.equal(ring.currentVersion, 7);
  assert.equal(ring.get(1)?.length, SECRET_KEY_BYTES);
  assert.equal(ring.get(7)?.length, SECRET_KEY_BYTES);
  assert.equal(ring.get(2), undefined);
  // 空白 / 改行区切りも受ける (鍵ファイルをそのまま読ませる)
  assert.equal(parseMasterKeys(`\n1:${keyOf(1)}\n`).currentVersion, 1);
});

test("壊れた master key の宣言は設定ミスとして例外にする", () => {
  const cases = ["", "   ", "not-a-key", "0:" + keyOf(1), "x:" + keyOf(1), `1:${keyOf(1)},1:${keyOf(2)}`];
  for (const spec of cases) {
    assert.throws(() => parseMasterKeys(spec), SecretKeyError, spec);
  }
  // 32 バイトでない鍵 (base64 としては正しい) は拒否する
  assert.throws(() => parseMasterKeys(`1:${Buffer.alloc(16, 1).toString("base64")}`), SecretKeyError);
  assert.throws(() => parseMasterKeys(`1:${Buffer.alloc(31, 1).toString("base64")}`), SecretKeyError);
});

test("resolveMasterKeys は env → 鍵ファイルの順で読み、未設定は null を返す", () => {
  const env = { [SECRET_MASTER_KEY_ENV]: `3:${keyOf(3)}`, [SECRET_MASTER_KEY_FILE_ENV]: "/unused" };
  assert.equal(resolveMasterKeys(env, () => "")?.currentVersion, 3);
  // env が空ならファイルを読む。中身の書式は同じ
  const fromFile = resolveMasterKeys({ [SECRET_MASTER_KEY_FILE_ENV]: "/key" }, () => `5:${keyOf(5)}`);
  assert.equal(fromFile?.currentVersion, 5);
  assert.equal(
    resolveMasterKeys({}, () => ""),
    null,
  );
  // ファイルが読めない / 中身が壊れているときは黙って null にしない
  assert.throws(
    () =>
      resolveMasterKeys({ [SECRET_MASTER_KEY_FILE_ENV]: "/key" }, () => {
        throw new Error("ENOENT");
      }),
    SecretKeyError,
  );
  assert.throws(() => resolveMasterKeys({ [SECRET_MASTER_KEY_FILE_ENV]: "/key" }, () => "broken"), SecretKeyError);
});

test("暗号化した値を同じ鍵で復号でき、nonce は毎回変わる", () => {
  const cipher = createSecretCipher(ringOf(`1:${keyOf(1)}`));
  const first = cipher.encrypt("secret", "DATABASE_URL", "postgres://user:pw@db/app");
  const second = cipher.encrypt("secret", "DATABASE_URL", "postgres://user:pw@db/app");
  assert.equal(first.nonce.length, SECRET_NONCE_BYTES);
  assert.equal(first.keyVersion, 1);
  assert.notEqual(
    Buffer.from(first.nonce).toString("hex"),
    Buffer.from(second.nonce).toString("hex"),
    "nonce を再利用している",
  );
  assert.equal(cipher.decrypt("secret", "DATABASE_URL", first), "postgres://user:pw@db/app");
  // 平文は暗号文に現れない
  assert.equal(Buffer.from(first.ciphertext).includes(Buffer.from("postgres")), false);
});

test("誤鍵・改ざん・AAD 不一致・未知の版は復号を拒否する", () => {
  const cipher = createSecretCipher(ringOf(`1:${keyOf(1)}`));
  const stored = cipher.encrypt("secret", "API_KEY", "dummy-value-1234");
  // 正しい AAD 以外では復号できない (名前 / 種別は保存後に変えられない)
  assert.throws(() => cipher.decrypt("secret", "OTHER_KEY", stored), SecretKeyError);
  assert.throws(() => cipher.decrypt("variable", "API_KEY", stored), SecretKeyError);

  const tampered = { ...stored, ciphertext: Buffer.from(stored.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  assert.throws(() => cipher.decrypt("secret", "API_KEY", tampered), SecretKeyError);

  const other = createSecretCipher(ringOf(`1:${keyOf(2)}`));
  assert.throws(() => other.decrypt("secret", "API_KEY", stored), SecretKeyError);

  const unknownVersion = createSecretCipher(ringOf(`1:${keyOf(1)}`));
  assert.throws(
    () => unknownVersion.decrypt("secret", "API_KEY", { ...stored, keyVersion: 2 }),
    (error: unknown) => error instanceof SecretKeyError && error.reason === "unknown_version",
  );

  // 長さが足りない保存値 (手編集 / 破損) も復号できない
  assert.throws(
    () => cipher.decrypt("secret", "API_KEY", { ciphertext: new Uint8Array(4), nonce: stored.nonce, keyVersion: 1 }),
    (error: unknown) => error instanceof SecretKeyError && error.reason === "decrypt_failed",
  );
});
