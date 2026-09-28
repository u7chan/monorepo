// 画像生成の設定サービス（DB を正とした 1 行の CRUD と PiBff への注入）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ImageSettingsRow } from "../src/app-db";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_KEY_NOT_STORED_MESSAGE,
  IMAGE_MODEL_NOT_IN_CATALOG_MESSAGE,
  IMAGE_PROVIDER_ID,
  IMAGE_PROVIDER_UNSUPPORTED_MESSAGE,
  IMAGE_SETTINGS_NOT_STORED_MESSAGE,
  IMAGE_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE,
  IMAGE_SETTINGS_UNCONFIGURED_MESSAGE,
  ImageSettingsService,
  type ImageSettingsDb,
} from "../src/image-settings";
import type { ImageGenerationConfig } from "../src/images";

const KEY = "sk-image-dummy-key-0123456789abcdef";

class FakeImageDb implements ImageSettingsDb {
  row: ImageSettingsRow | undefined;
  failRead = false;
  failSave = false;
  failDelete = false;
  /** 保存の直後から read を失敗させる（書込成功後の読取失敗を再現する） */
  failReadAfterSave = false;
  events: string[] = [];

  readImageSettings(): ImageSettingsRow | undefined {
    if (this.failRead) throw new Error("db read boom");
    return this.row;
  }

  saveImageSettings(settings: ImageSettingsRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.events.push("save");
    this.row = settings;
    if (this.failReadAfterSave) this.failRead = true;
  }

  deleteImageSettings(): boolean {
    if (this.failDelete) throw new Error("db delete boom");
    this.events.push("delete");
    const existed = this.row !== undefined;
    this.row = undefined;
    return existed;
  }
}

function createService(
  options: {
    db?: FakeImageDb;
    runtimeAvailable?: boolean;
    models?: { provider: string; id: string; name: string }[];
  } = {},
) {
  const db = options.db ?? new FakeImageDb();
  const retained: string[] = [];
  const configs: ImageGenerationConfig[] = [];
  const service = new ImageSettingsService({
    db,
    runtimeAvailable: options.runtimeAvailable ?? true,
    retainSecret: (value) => {
      retained.push(value);
      db.events.push("retain");
    },
    catalog: () => options.models ?? [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
    setImageGeneration: (config) => {
      configs.push(config);
      db.events.push(`inject:${config.enabled ? "on" : "off"}`);
    },
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
  });
  return { db, service, retained, configs, latest: () => configs.at(-1) };
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

test("GET は行が無いとき未設定を返し、キーを載せない", () => {
  const { service } = createService();
  assert.deepEqual(service.settings(), {
    configured: false,
    provider: null,
    model: null,
    models: [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
    runtimeAvailable: true,
  });
});

test("キー登録はマスカー → DB → 注入の順に通し、行が無ければ既定 provider / model で作る", async () => {
  const { db, service, retained, configs } = createService();
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.equal(outcome.response.configured, true);
  assert.equal(outcome.response.provider, IMAGE_PROVIDER_ID);
  assert.equal(outcome.response.model, DEFAULT_IMAGE_MODEL);
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY });
  assert.deepEqual(retained, [KEY], "マスカー登録は 1 回");
  assert.deepEqual(db.events, ["retain", "save", "inject:on"]);
  assert.equal(configs.at(-1)?.enabled, true);
  assert.deepEqual(configs.at(-1)?.read(), db.row, "注入した read は現在の行を返す");
});

test("キー上書きは選択済みの provider / model を保つ", async () => {
  const { db, service } = createService();
  db.row = { provider: IMAGE_PROVIDER_ID, model: "black-forest-labs/flux.2-max", apiKey: "old-key" };
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, model: "black-forest-labs/flux.2-max", apiKey: KEY });
});

test("provider / model の変更はキーを保持し、行が無い / provider が違う / カタログ外は 400", async () => {
  const { db, service } = createService();
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.match((error as Error).message, new RegExp(IMAGE_SETTINGS_UNCONFIGURED_MESSAGE));
      throw error;
    }
  }, "行が無いのに選択だけ変えられる");

  db.row = { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: "openai", model: DEFAULT_IMAGE_MODEL });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.equal((error as Error).message, IMAGE_PROVIDER_UNSUPPORTED_MESSAGE);
      throw error;
    }
  }, "openrouter 以外を受け付けている");
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: "ghost/model" });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.match((error as Error).message, new RegExp(IMAGE_MODEL_NOT_IN_CATALOG_MESSAGE));
      throw error;
    }
  }, "カタログ外のモデルを受け付けている");

  const outcome = await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL });
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY }, "キーを保つ");
});

test("キー削除は行ごと消して注入を無効にし、未設定でも 200 を返す", async () => {
  const { db, service, configs } = createService();
  db.row = { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  const first = await service.deleteKey();
  assert.equal(first.status, 200);
  if (first.status !== 200) return;
  assert.equal(first.response.state, "applied");
  assert.equal(first.response.configured, false);
  assert.equal(first.response.provider, null);
  assert.equal(db.row, undefined);
  assert.equal(configs.at(-1)?.enabled, false);
  assert.equal(configs.at(-1)?.read(), undefined, "削除後の read は未設定を返す");

  const second = await service.deleteKey();
  assert.equal(second.status, 200, "削除は冪等");
});

test("ランタイム初期化に失敗しているときのキー登録は 503 not_stored（DB とマスカーへ触らない）", async () => {
  const { db, service, retained } = createService({ runtimeAvailable: false });
  const outcome = await service.putKey(KEY);
  assert.deepEqual(outcome, { status: 503, error: IMAGE_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE });
  assert.deepEqual(db.events, []);
  assert.deepEqual(retained, []);
  assert.equal(service.settings().runtimeAvailable, false);
});

test("DB 失敗は 503 not_stored にして理由の分類だけを残す", async () => {
  const { db, service } = createService();
  db.failSave = true;
  assert.deepEqual(await service.putKey(KEY), { status: 503, error: IMAGE_KEY_NOT_STORED_MESSAGE });

  db.failSave = false;
  db.row = { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  db.failRead = true;
  assert.deepEqual(await service.putKey(KEY), { status: 503, error: IMAGE_KEY_NOT_STORED_MESSAGE });
  assert.deepEqual(await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }), {
    status: 503,
    error: IMAGE_SETTINGS_NOT_STORED_MESSAGE,
  });

  db.failRead = false;
  db.failSave = true;
  assert.deepEqual(await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }), {
    status: 503,
    error: IMAGE_SETTINGS_NOT_STORED_MESSAGE,
  });

  db.failSave = false;
  db.failDelete = true;
  assert.deepEqual(await service.deleteKey(), { status: 503, error: IMAGE_SETTINGS_NOT_STORED_MESSAGE });
});

test("書込成功後の読取失敗でも applied を返す（not_stored と誤伝しない）", async () => {
  const { db, service } = createService();
  db.failReadAfterSave = true;
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.equal(outcome.response.configured, true);
  assert.equal(outcome.response.provider, IMAGE_PROVIDER_ID);
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY });
});

test("起動時の適用は行の有無を注入し、読めないときは無効で立ち警告だけを残す", async () => {
  const configured = createService();
  configured.db.row = { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  await configured.service.applyStored();
  assert.equal(configured.latest()?.enabled, true);
  assert.deepEqual(configured.latest()?.read(), configured.db.row);
  assert.deepEqual(configured.retained, [KEY], "起動時点の行もマスカーへ登録する");

  const unset = createService();
  await unset.service.applyStored();
  assert.equal(unset.latest()?.enabled, false);
  assert.equal(unset.latest()?.read(), undefined);

  const broken = createService();
  broken.db.failRead = true;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    await broken.service.applyStored();
  } finally {
    console.error = original;
  }
  assert.equal(broken.latest()?.enabled, false, "読めないときは無効で立つ");
  assert.ok(logged.join("\n").includes("image settings unavailable"), logged.join("\n"));
});
