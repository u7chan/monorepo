// Cloudflare 資格情報の保存サービス。トークンが応答・例外へ出ないこと、省略更新で維持されること、
// アカウント切替の拒否、master key 不在時の 503 を fake DB と実 AEAD で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudflareSettingsRow } from "../src/app-db";
import {
  CLOUDFLARE_ACCOUNT_SWITCH_ERROR,
  CLOUDFLARE_DECRYPT_ERROR,
  CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR,
  CLOUDFLARE_DELETE_ERROR,
  CLOUDFLARE_READ_ERROR,
  CLOUDFLARE_SAVE_ERROR,
  CLOUDFLARE_TOKEN_FORMAT_ERROR,
  CLOUDFLARE_TOKEN_REQUIRED_ERROR,
  CloudflareSettingsService,
  type CloudflareSettingsDb,
} from "../src/cloudflare-settings";
import { statusCodeOf } from "../src/http";
import { createSecretCipher, parseMasterKeys } from "../src/secret-crypto";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const TOKEN = `cf-${"a".repeat(37)}`;
const KEY_1 = `1:${Buffer.alloc(32, 1).toString("base64")}`;
const KEY_2 = `1:${Buffer.alloc(32, 2).toString("base64")}`;

class FakeDb implements CloudflareSettingsDb {
  row: CloudflareSettingsRow | undefined;
  otherAccount = false;
  failRead = false;
  failSave = false;
  failDelete = false;
  reads = 0;
  saves = 0;
  deletes = 0;

  readCloudflareSettings(): CloudflareSettingsRow | undefined {
    this.reads += 1;
    if (this.failRead) throw new Error("db read boom");
    return this.row;
  }

  saveCloudflareSettings(settings: CloudflareSettingsRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.saves += 1;
    this.row = settings;
  }

  deleteCloudflareSettings(): boolean {
    if (this.failDelete) throw new Error("db delete boom");
    this.deletes += 1;
    const existed = this.row !== undefined;
    this.row = undefined;
    return existed;
  }

  hasSharedContentsForOtherAccount(): boolean {
    return this.otherAccount;
  }
}

function service(db: FakeDb, key = KEY_1, retained: string[] = []) {
  return {
    service: new CloudflareSettingsService({
      db,
      cipher: key ? createSecretCipher(parseMasterKeys(key)) : null,
      retainSecret: (value) => retained.push(value),
    }),
    retained,
  };
}

const rejectsWith = async (promise: Promise<unknown>, status: number, message: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(statusCodeOf(error), status);
    assert.equal((error as Error).message, message);
    return true;
  });
};

test("保存はトークンを返さず、実 DB には平文と異なる暗号文を置き、credential で復号できる", async () => {
  const db = new FakeDb();
  const { service: settings, retained } = service(db);
  const saved = await settings.save({ accountId: ACCOUNT.toUpperCase(), apiToken: ` ${TOKEN} ` });
  assert.equal(saved.state, "applied");
  assert.equal(saved.configured, true);
  assert.equal(saved.accountId, ACCOUNT);
  assert.equal(saved.available, true);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false, "応答にトークンを載せない");
  assert.ok(db.row);
  assert.equal(Buffer.from(db.row.ciphertext).toString("utf8").includes(TOKEN), false, "暗号文に平文を残さない");
  assert.deepEqual(settings.credential(), { accountId: ACCOUNT, apiToken: TOKEN });
  assert.deepEqual(retained, [TOKEN, TOKEN], "保存時と復号時にマスク対象へ渡す");
});

test("トークンを省略した更新は暗号文を維持し、アカウント ID だけを変える", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  await settings.save({ accountId: ACCOUNT, apiToken: TOKEN });
  const ciphertext = db.row?.ciphertext;
  const updated = await settings.save({ accountId: OTHER_ACCOUNT });
  assert.equal(updated.accountId, OTHER_ACCOUNT);
  assert.deepEqual(db.row?.ciphertext, ciphertext);
  assert.equal(settings.credential()?.apiToken, TOKEN);
});

test("初回登録にトークンが無い / 形式が不正なら 400 にし、何も保存しない", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  await rejectsWith(settings.save({ accountId: ACCOUNT }), 400, CLOUDFLARE_TOKEN_REQUIRED_ERROR);
  await rejectsWith(settings.save({ accountId: ACCOUNT, apiToken: "short" }), 400, CLOUDFLARE_TOKEN_FORMAT_ERROR);
  await rejectsWith(
    settings.save({ accountId: ACCOUNT, apiToken: `${TOKEN} with space` }),
    400,
    CLOUDFLARE_TOKEN_FORMAT_ERROR,
  );
  await rejectsWith(
    settings.save({ accountId: "not-an-account", apiToken: TOKEN }),
    400,
    "Cloudflare のアカウント ID は 32 桁の 16 進数で入力してください",
  );
  assert.equal(db.saves, 0);
});

test("別アカウントの共有物が残っている間は、資格情報の登録・切替を 409 で拒否する", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  await settings.save({ accountId: ACCOUNT, apiToken: TOKEN });
  db.otherAccount = true;
  const before = db.row?.ciphertext;
  await rejectsWith(settings.save({ accountId: OTHER_ACCOUNT, apiToken: TOKEN }), 409, CLOUDFLARE_ACCOUNT_SWITCH_ERROR);
  await rejectsWith(settings.save({ accountId: ACCOUNT }), 409, CLOUDFLARE_ACCOUNT_SWITCH_ERROR);
  assert.deepEqual(db.row?.ciphertext, before);
});

test("master key が無いときは GET で理由を返し、保存と復号は 503 にする", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db, "");
  assert.deepEqual(settings.status(), {
    configured: false,
    accountId: null,
    available: false,
    unavailableReason: CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR,
  });
  await rejectsWith(
    settings.save({ accountId: ACCOUNT, apiToken: TOKEN }),
    503,
    CLOUDFLARE_ENCRYPTION_UNAVAILABLE_ERROR,
  );

  // 別の鍵で保存された行は復号できない (値をエラーへ載せない)
  const saved = new FakeDb();
  const { service: writer } = service(saved);
  await writer.save({ accountId: ACCOUNT, apiToken: TOKEN });
  const { service: reader } = service(saved, KEY_2);
  await assert.rejects(
    async () => reader.credential(),
    (error: unknown) => {
      assert.equal(statusCodeOf(error), 503);
      assert.equal((error as Error).message, CLOUDFLARE_DECRYPT_ERROR);
      assert.equal((error as Error).message.includes(TOKEN), false);
      return true;
    },
  );
});

test("壊れた行は未登録と読み違えず 503 にし、削除だけは通す", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  db.failRead = true;
  await assert.rejects(
    async () => settings.status(),
    (error: unknown) => statusCodeOf(error) === 503 && (error as Error).message === CLOUDFLARE_READ_ERROR,
  );
  const removed = await settings.remove();
  assert.equal(removed.configured, false);
  assert.equal(db.deletes, 1);
  // 削除で行が消えた後の読み取りは成功する
  db.failRead = false;
  assert.equal(settings.status().configured, false);
});

test("削除は冪等で、保存済みのアカウント ID を応答から消す", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  await settings.save({ accountId: ACCOUNT, apiToken: TOKEN });
  const removed = await settings.remove();
  assert.equal(removed.configured, false);
  assert.equal(removed.accountId, null);
  assert.equal(settings.credential(), null);
  assert.equal((await settings.remove()).configured, false);
  assert.equal(db.deletes, 2);
});

test("DB の書き込み・削除失敗は 503 にし、例外文言を応答へ出さない", async () => {
  const db = new FakeDb();
  const { service: settings } = service(db);
  db.failSave = true;
  await rejectsWith(settings.save({ accountId: ACCOUNT, apiToken: TOKEN }), 503, CLOUDFLARE_SAVE_ERROR);
  db.failSave = false;
  await settings.save({ accountId: ACCOUNT, apiToken: TOKEN });
  db.failDelete = true;
  await rejectsWith(settings.remove(), 503, CLOUDFLARE_DELETE_ERROR);
});
