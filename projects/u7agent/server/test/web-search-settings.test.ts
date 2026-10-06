// Web 検索の実行時トグル（DB を正とした 1 行の CRUD と PiBff への注入）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { WebSearchSettingsRow } from "../src/app-db";
import { WEB_SEARCH_DISABLED_MESSAGE, type WebSearchRuntimeConfig } from "../src/web-search-tool";
import {
  WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE,
  WebSearchSettingsService,
  type WebSearchSettingsDb,
} from "../src/web-search-settings";

class FakeWebSearchDb implements WebSearchSettingsDb {
  row: WebSearchSettingsRow | undefined;
  failRead = false;
  failSave = false;
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
}

function openService(db: FakeWebSearchDb, maskError: (text: string) => string = (text) => text) {
  const injected: WebSearchRuntimeConfig[] = [];
  const service = new WebSearchSettingsService({
    db,
    setWebSearchEnabled: (config) => injected.push(config),
    maskError,
  });
  return { service, injected, enabled: () => injected.at(-1)?.readEnabled() };
}

test("行が無い = 既定（有効）で、GET は固定文言も返す", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected } = openService(db);
  assert.deepEqual(service.settings(), { enabled: true, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE });

  await service.applyStored();
  assert.equal(injected.length, 1, "起動時にも写す");
  assert.equal(injected[0].readEnabled(), true);
});

test("PUT で保存し、同じサービスからは次の GET と写しが変わる", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected, enabled } = openService(db);

  const off = await service.put({ enabled: false });
  assert.equal(off.status, 200);
  assert.deepEqual(db.row, { enabled: false }, "保存は 0 / 1 ではなく boolean で受ける");
  assert.equal(enabled(), false, "OFF が実行時の写しへ入る");
  assert.deepEqual(service.settings(), { enabled: false, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE });

  const on = await service.put({ enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(db.row, { enabled: true });
  assert.equal(enabled(), true, "ON に戻すと同じ写しが true を返す");
  assert.equal(injected.length, 2, "注入は 1 回の PUT につき 1 回");
});

test("保存できないときは 503 で、写しも変えない", async () => {
  const db = new FakeWebSearchDb();
  const { service, injected, enabled } = openService(db);

  db.failSave = true;
  const outcome = await service.put({ enabled: false });
  assert.deepEqual(outcome, { status: 503, error: WEB_SEARCH_SETTINGS_NOT_STORED_MESSAGE });
  assert.equal(injected.length, 0, "保存できなかった変更は適用しない");
  assert.equal(enabled(), undefined);

  // 保存できるようになれば同じトグルが通る（失敗が固定しない）
  db.failSave = false;
  assert.equal((await service.put({ enabled: false })).status, 200);
  assert.equal(enabled(), false);
});

test("保存は確定したが読取が失敗しても、200 の applied を返す", async () => {
  const db = new FakeWebSearchDb();
  const { service, enabled } = openService(db);
  db.failReadAfterSave = true;

  const outcome = await service.put({ enabled: false });
  // 保存できているのに not_stored を返すと、画面が実効値と食い違う（読取に依存させない）
  assert.deepEqual(outcome, {
    status: 200,
    response: { enabled: false, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE, state: "applied" },
  });
  assert.equal(enabled(), false, "写しも保存後の値になる");
  assert.deepEqual(db.row, { enabled: false });
});

test("起動時に DB を読めないときは既定（有効）で立ち、警告だけを残す", async () => {
  const db = new FakeWebSearchDb();
  db.failRead = true;
  const errors: string[] = [];
  const { service, enabled } = openService(db, (text) => {
    errors.push(text);
    return text;
  });

  await service.applyStored();
  assert.equal(enabled(), true, "読めないだけで検索を黙って止めない");
  assert.equal(errors.length, 1, "ログには残す");
  // GET は DB の失敗をそのまま伝える（画面が 503 として気付ける）
  assert.throws(() => service.settings());
});
