import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_MASTER_KEY_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  APP_SECRET_UNEVALUATED_MESSAGE,
  evaluateAppSecret,
  requireAppSecretCipher,
} from "../src/app-secrets";
import { SecretKeyError, type AppSecretCipher } from "../src/secret-crypto";

const VALUE = "dummy-api-key";
const SECRET = { ciphertext: Uint8Array.of(1), nonce: Uint8Array.of(2), keyVersion: 1 };

function fixture() {
  const decrypt = mock.fn<AppSecretCipher["decrypt"]>(() => VALUE);
  const cipher: AppSecretCipher = {
    encrypt: () => {
      throw new Error("unexpected encryption");
    },
    decrypt,
  };
  const retain = mock.fn<(value: string) => void>();
  const options = {
    cipher,
    runtimeAvailable: true,
    scope: "content_settings",
    owner: "apiKey",
    secret: SECRET,
    retain,
  } as const;
  return { options, decrypt, retain };
}

test("暗号文が無ければ runtime と master key が無くても未保存になる", () => {
  const { options, decrypt, retain } = fixture();
  const expected = {
    value: null,
    state: { keyAvailable: false, keyEvaluated: true, keyErrorMessage: null },
  };
  assert.deepEqual(evaluateAppSecret({ ...options, secret: null }), expected);
  assert.deepEqual(evaluateAppSecret({ ...options, secret: null, runtimeAvailable: false, cipher: null }), expected);
  assert.equal(decrypt.mock.callCount(), 0);
  assert.equal(retain.mock.callCount(), 0);
});

test("runtime が無ければ master key の有無によらず復号せず未評価になる", () => {
  const { options, decrypt, retain } = fixture();
  for (const cipher of [options.cipher, null]) {
    const result = evaluateAppSecret({ ...options, runtimeAvailable: false, cipher });
    assert.deepEqual(result, {
      value: null,
      state: { keyAvailable: false, keyEvaluated: false, keyErrorMessage: APP_SECRET_UNEVALUATED_MESSAGE },
    });
  }
  assert.equal(decrypt.mock.callCount(), 0);
  assert.equal(retain.mock.callCount(), 0);
});

test("runtime があっても master key が無ければ専用の文言で利用不可になる", () => {
  const { options, retain } = fixture();
  assert.deepEqual(evaluateAppSecret({ ...options, cipher: null }), {
    value: null,
    state: { keyAvailable: false, keyEvaluated: true, keyErrorMessage: APP_SECRET_MASTER_KEY_MESSAGE },
  });
  assert.equal(retain.mock.callCount(), 0);
});

test("復号できないときは理由や例外の詳細を返さず、マスカーへも登録しない", () => {
  const { options, decrypt, retain } = fixture();
  for (const reason of ["unknown_version", "decrypt_failed"] as const) {
    decrypt.mock.mockImplementation(() => {
      throw new SecretKeyError("internal error detail", reason);
    });
    assert.deepEqual(evaluateAppSecret(options), {
      value: null,
      state: { keyAvailable: false, keyEvaluated: true, keyErrorMessage: APP_SECRET_DECRYPT_FAILED_MESSAGE },
    });
  }
  assert.equal(retain.mock.callCount(), 0);
});

test("用途と所有者を指定して復号し、値をマスカーへ登録してから利用可として返す", () => {
  const { options, decrypt, retain } = fixture();
  assert.deepEqual(evaluateAppSecret(options), {
    value: VALUE,
    state: { keyAvailable: true, keyEvaluated: true, keyErrorMessage: null },
  });
  assert.equal(decrypt.mock.callCount(), 1);
  assert.deepEqual(decrypt.mock.calls[0]?.arguments, ["content_settings", "apiKey", SECRET]);
  assert.equal(retain.mock.callCount(), 1);
  assert.deepEqual(retain.mock.calls[0]?.arguments, [VALUE]);
});

test("マスカーへの登録に失敗したときは復号した値を返さない", () => {
  const { options, retain } = fixture();
  retain.mock.mockImplementation(() => {
    throw new Error("masker unavailable");
  });
  assert.deepEqual(evaluateAppSecret(options), {
    value: null,
    state: { keyAvailable: false, keyEvaluated: true, keyErrorMessage: APP_SECRET_DECRYPT_FAILED_MESSAGE },
  });
});

test("保存用の cipher が無ければ暗号化して保存できない旨を固定文言で伝える", () => {
  const { options } = fixture();
  assert.throws(() => requireAppSecretCipher(null), { message: APP_SECRET_NOT_STORED_MESSAGE });
  assert.equal(requireAppSecretCipher(options.cipher), options.cipher);
});
