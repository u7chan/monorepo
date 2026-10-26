// Web 検索の設定（DB を正とした 1 行 + provider ごとのキーの CRUD と PiBff への注入）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { StoredAppSecret, WebSearchSettingsRow } from "../src/app-db";
import {
  WEB_SEARCH_KEYLESS_UNSUPPORTED_MESSAGE,
  WEB_SEARCH_KEY_NOT_STORED_MESSAGE,
  WEB_SEARCH_PROVIDER_UNSUPPORTED_MESSAGE,
  WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE,
  WebSearchSettingsService,
  type WebSearchSettingsDb,
} from "../src/web-search-settings";
import { WEB_SEARCH_DISABLED_MESSAGE, type WebSearchRuntimeConfig } from "../src/web-search-tool";
import { testAppCipher } from "./app-secret-fixture";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_MASTER_KEY_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  APP_SECRET_UNEVALUATED_MESSAGE,
} from "../src/app-secrets";

class FakeWebSearchDb implements WebSearchSettingsDb {
  row: WebSearchSettingsRow | undefined;
  keys = new Map<string, StoredAppSecret>();
  failRead = false;
  failSave = false;
  failKeyRead = false;
  failKeySave = false;
  failKeyDelete = false;
  /** 保存の直後から read を失敗させる（書込成功後の読取失敗を再現する） */
  failReadAfterSave = false;

  readWebSearchSettings(): WebSearchSettingsRow | undefined {
    if (this.failRead) throw new Error("db read boom");
    return this.row;
  }

  saveWebSearchSettings(settings: WebSearchSettingsRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.row = settings;
    if (this.failReadAfterSave) this.failRead = true;
  }

  readWebSearchProviderKey(provider: string): StoredAppSecret | undefined {
    if (this.failKeyRead) throw new Error("db key read boom");
    return this.keys.get(provider);
  }

  saveWebSearchProviderKey(provider: string, secret: StoredAppSecret): void {
    if (this.failKeySave) throw new Error("db key save boom");
    this.keys.set(provider, secret);
  }

  deleteWebSearchProviderKey(provider: string): boolean {
    if (this.failKeyDelete) throw new Error("db key delete boom");
    return this.keys.delete(provider);
  }
}

const SECRET = "tvly-secret-value-0123456789";

const CIPHER = testAppCipher();

/** 平文キーを暗号化した保存形。web_search_provider_keys の AAD は provider ごとに分かれる */
function secretOf(plaintext: string, provider = "tavily"): StoredAppSecret {
  return CIPHER.encrypt("web_search_provider_keys", provider, plaintext);
}

/** 保存行の平文キー。暗号文は毎回変わるため、値の比較は復号してから行う */
function storedKey(secret: StoredAppSecret | undefined, provider = "tavily"): string | undefined {
  return secret === undefined ? undefined : CIPHER.decrypt("web_search_provider_keys", provider, secret);
}

/** 復号できない保存行 (誤鍵・改ざん相当)。値は使わない */
function brokenSecret(): StoredAppSecret {
  return { ciphertext: new Uint8Array([1, 2, 3, 4]), nonce: new Uint8Array(12), keyVersion: 99 };
}

function openService(
  db: FakeWebSearchDb,
  maskError: (text: string) => string = (text) => text,
  options: { cipher?: ReturnType<typeof testAppCipher> | null; runtimeAvailable?: boolean } = {},
) {
  const injected: WebSearchRuntimeConfig[] = [];
  const retained: string[] = [];
  const service = new WebSearchSettingsService({
    db,
    setWebSearch: (config) => injected.push(config),
    retainSecret: (value) => retained.push(value),
    maskError,
    cipher: options.cipher === undefined ? CIPHER : options.cipher,
    runtimeAvailable: options.runtimeAvailable ?? true,
  });
  return { service, injected, retained, current: () => injected.at(-1) };
}

/** 応答の providers。keyless は「キー無しで使える」を明示し、キー付きは保存 / 復号の状態に追随する */
function providers(tavilyConfigured: boolean) {
  return [
    {
      id: "exa",
      name: "Exa",
      host: "mcp.exa.ai",
      keyless: true,
      configured: true,
      keyStored: false,
      keyAvailable: true,
      keyEvaluated: true,
      keyErrorMessage: null,
    },
    {
      id: "tavily",
      name: "Tavily",
      host: "api.tavily.com",
      keyless: false,
      configured: tavilyConfigured,
      keyStored: tavilyConfigured,
      keyAvailable: tavilyConfigured,
      keyEvaluated: true,
      keyErrorMessage: null,
    },
  ];
}

test("行が無い = 既定（有効 / Exa）で、GET は provider 一覧と固定文言も返す", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected, current } = openService(db);
  assert.deepEqual(service.settings(), {
    enabled: true,
    provider: "exa",
    providers: providers(false),
    disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
  });

  await service.applyStored();
  assert.equal(injected.length, 1, "起動時にも写す");
  assert.equal(current()?.readEnabled(), true);
  assert.equal(current()?.readProvider(), "exa");
  assert.equal(current()?.readApiKey("tavily"), undefined);
});

test("PUT で保存し、同じサービスからは次の GET と写しが変わる（既存行の provider を保持する）", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected, current } = openService(db);

  const off = await service.putEnabled(false);
  assert.equal(off.status, 200);
  assert.deepEqual(db.row, { enabled: false, provider: "exa" }, "保存は 0 / 1 ではなく boolean で受ける");
  assert.equal(current()?.readEnabled(), false, "OFF が実行時の写しへ入る");
  assert.equal(service.settings().enabled, false);

  const on = await service.putEnabled(true);
  assert.equal(on.status, 200);
  assert.deepEqual(db.row, { enabled: true, provider: "exa" });
  assert.equal(current()?.readEnabled(), true, "ON に戻すと同じ写しが true を返す");
  assert.equal(injected.length, 2, "注入は 1 回の PUT につき 1 回");
});

test("既定 provider を保存すると、応答と写しが変わる（enabled は保持する）", async () => {
  const db = new FakeWebSearchDb();
  db.row = { enabled: false, provider: "exa" };
  const { service, current } = openService(db);

  const outcome = await service.putProvider("tavily");
  assert.deepEqual(outcome, {
    status: 200,
    response: {
      enabled: false,
      provider: "tavily",
      providers: providers(false),
      disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
      state: "applied",
    },
  });
  assert.deepEqual(db.row, { enabled: false, provider: "tavily" }, "OFF のまま provider だけ差し替える");
  assert.equal(current()?.readProvider(), "tavily");
});

test("未知の provider は 400 で、何も保存しない", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected } = openService(db);
  await assert.rejects(() => service.putProvider("brave"), new RegExp(WEB_SEARCH_PROVIDER_UNSUPPORTED_MESSAGE));
  assert.equal(db.row, undefined);
  assert.equal(injected.length, 0);
});

test("キーの登録はマスカー登録が先で、応答にも写しにも値以外が出ない", async () => {
  const db = new FakeWebSearchDb();
  const { service, retained, current } = openService(db);

  const outcome = await service.putKey("tavily", SECRET);
  assert.equal(outcome.status, 200);
  assert.deepEqual(retained, [SECRET], "DB より先に保護対象へ足す");
  assert.equal(storedKey(db.keys.get("tavily")), SECRET, "DB には暗号文だけを置く");
  assert.equal(current()?.readApiKey("tavily"), SECRET);
  assert.equal(service.settings().providers[1].configured, true);
  assert.equal(service.settings().providers[1].keyAvailable, true);
  // 応答はキー値を含まない
  assert.equal(JSON.stringify(outcome).includes(SECRET), false);
  assert.equal(JSON.stringify(service.settings()).includes(SECRET), false);

  const deleted = await service.deleteKey("tavily");
  assert.equal(deleted.status, 200);
  assert.equal(db.keys.has("tavily"), false);
  assert.equal(current()?.readApiKey("tavily"), undefined);
  assert.equal(service.settings().providers[1].configured, false);
  assert.equal(service.settings().providers[1].keyAvailable, false);
  // 未設定の削除も 200（冪等）
  assert.equal((await service.deleteKey("tavily")).status, 200);
});

test("キー不要 / 未知の provider へのキー操作は 400", async () => {
  const db = new FakeWebSearchDb();
  const { service, retained } = openService(db);
  await assert.rejects(() => service.putKey("exa", SECRET), new RegExp(WEB_SEARCH_KEYLESS_UNSUPPORTED_MESSAGE));
  await assert.rejects(() => service.deleteKey("exa"), new RegExp(WEB_SEARCH_KEYLESS_UNSUPPORTED_MESSAGE));
  await assert.rejects(() => service.putKey("brave", SECRET), new RegExp(WEB_SEARCH_PROVIDER_UNSUPPORTED_MESSAGE));
  assert.equal(retained.length, 0, "キー不要と分かった時点でマスカーへも足さない");
  assert.equal(db.keys.size, 0);
});

test("保存できないときは 503 で、写しも変えない", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected, current } = openService(db);

  db.failSave = true;
  assert.deepEqual(await service.putEnabled(false), {
    status: 503,
    error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE,
  });
  assert.equal(injected.length, 0, "保存できなかった変更は適用しない");
  assert.equal(current(), undefined);

  db.failSave = false;
  db.failKeySave = true;
  assert.deepEqual(await service.putKey("tavily", SECRET), { status: 503, error: WEB_SEARCH_KEY_NOT_STORED_MESSAGE });
  db.failKeyDelete = true;
  assert.deepEqual(await service.deleteKey("tavily"), { status: 503, error: WEB_SEARCH_KEY_NOT_STORED_MESSAGE });

  // 保存できるようになれば同じ操作が通る（失敗が固定しない）
  db.failSave = false;
  db.failKeySave = false;
  assert.equal((await service.putEnabled(false)).status, 200);
  assert.equal(current()?.readEnabled(), false);
});

test("保存は確定したが読取が失敗しても、200 の applied を返す", async () => {
  const db = new FakeWebSearchDb();
  const { service, current } = openService(db);
  db.failReadAfterSave = true;

  const outcome = await service.putEnabled(false);
  // 保存できているのに not_stored を返すと、画面が実効値と食い違う（読取に依存させない）
  assert.deepEqual(outcome, {
    status: 200,
    response: {
      enabled: false,
      provider: "exa",
      providers: providers(false),
      disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
      state: "applied",
    },
  });
  assert.equal(current()?.readEnabled(), false, "写しも保存後の値になる");
  assert.deepEqual(db.row, { enabled: false, provider: "exa" });
});

test("行を読めないときの更新は 503 not_stored で、写しも変えない", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected } = openService(db);
  db.failRead = true;

  assert.deepEqual(await service.putEnabled(false), {
    status: 503,
    error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE,
  });
  assert.deepEqual(await service.putProvider("tavily"), {
    status: 503,
    error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE,
  });
  assert.equal(injected.length, 0);
  assert.equal(db.row, undefined);
  // GET は DB の失敗をそのまま伝える（画面が 503 として気付ける）
  assert.throws(() => service.settings());
});

test("起動時に DB を読めないときは既定（有効 / Exa）で立ち、警告だけを残す", async () => {
  const db = new FakeWebSearchDb();
  db.failRead = true;
  const errors: string[] = [];
  const { service, current } = openService(db, (text) => {
    errors.push(text);
    return text;
  });

  await service.applyStored();
  assert.equal(current()?.readEnabled(), true, "読めないだけで検索を黙って止めない");
  assert.equal(current()?.readProvider(), "exa");
  assert.equal(errors.length, 1, "ログには残す");
});

test("起動時に保存済みの provider とキーを写し、キーは保護対象へ入れる", async () => {
  const db = new FakeWebSearchDb();
  db.row = { enabled: false, provider: "tavily" };
  db.keys.set("tavily", secretOf(SECRET));
  const { service, retained, current } = openService(db);

  await service.applyStored();
  assert.equal(retained.length, 1);
  assert.equal(retained[0], SECRET, "起動時に読んだキーもマスカーへ入れる");
  assert.equal(current()?.readEnabled(), false);
  assert.equal(current()?.readProvider(), "tavily");
  assert.equal(current()?.readApiKey("tavily"), SECRET);
});

test("保存値の provider が未知でも既定へ畳んで立ち、検索は止めない", async () => {
  const db = new FakeWebSearchDb();
  db.row = { enabled: true, provider: "brave" };
  const { service, current } = openService(db);

  assert.equal(service.settings().provider, "exa");
  await service.applyStored();
  assert.equal(current()?.readProvider(), "exa");
});

test("キー不要の provider はキー行も master key も無い状態で利用可能と出る", async () => {
  const db = new FakeWebSearchDb();
  const { service } = openService(db, (text) => text, { cipher: null });

  const [exa, tavily] = service.settings().providers;
  assert.deepEqual(
    { configured: exa?.configured, keyStored: exa?.keyStored, keyAvailable: exa?.keyAvailable },
    { configured: true, keyStored: false, keyAvailable: true },
    "キー不要を未設定と同じ見た目にしない",
  );
  assert.equal(exa?.keyEvaluated, true);
  assert.equal(exa?.keyErrorMessage, null);
  assert.equal(tavily?.keyAvailable, false);
});

test("master key が無い起動でも、保存済みキーは未設定と混同せず削除できる", async () => {
  const db = new FakeWebSearchDb();
  db.keys.set("tavily", secretOf(SECRET));
  const { service, current } = openService(db, (text) => text, { cipher: null });
  await service.applyStored();

  const tavily = service.settings().providers[1];
  assert.equal(tavily?.configured, true);
  assert.equal(tavily?.keyStored, true);
  assert.equal(tavily?.keyAvailable, false);
  assert.equal(tavily?.keyEvaluated, true);
  assert.equal(tavily?.keyErrorMessage, APP_SECRET_MASTER_KEY_MESSAGE);
  assert.equal(current()?.readApiKey("tavily"), undefined, "復号できない値を写しへ渡さない");

  // 利用は 503、削除は master key 無しでも通る
  assert.deepEqual(await service.putKey("tavily", SECRET), { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE });
  assert.equal((await service.deleteKey("tavily")).status, 200);
  assert.equal(db.keys.has("tavily"), false);
  assert.equal(service.settings().providers[1]?.configured, false);
});

test("誤鍵・破損した暗号文は平文へ落とさず、固定文言で利用不可にする", async () => {
  const db = new FakeWebSearchDb();
  db.keys.set("tavily", brokenSecret());
  const { service, current } = openService(db);
  await service.applyStored();

  const tavily = service.settings().providers[1];
  assert.equal(tavily?.keyStored, true);
  assert.equal(tavily?.keyAvailable, false);
  assert.equal(tavily?.keyEvaluated, true);
  assert.equal(tavily?.keyErrorMessage, APP_SECRET_DECRYPT_FAILED_MESSAGE);
  assert.equal(current()?.readApiKey("tavily"), undefined);
});

test("runtime が無い起動では暗号文を復号せず、未評価として返す", async () => {
  const db = new FakeWebSearchDb();
  db.keys.set("tavily", secretOf(SECRET));
  const { service, current } = openService(db, (text) => text, { runtimeAvailable: false });
  await service.applyStored();

  const tavily = service.settings().providers[1];
  assert.equal(tavily?.keyStored, true);
  assert.equal(tavily?.keyAvailable, false);
  assert.equal(tavily?.keyEvaluated, false);
  assert.equal(tavily?.keyErrorMessage, APP_SECRET_UNEVALUATED_MESSAGE);
  assert.equal(current()?.readApiKey("tavily"), undefined);
});
