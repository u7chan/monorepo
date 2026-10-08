// コンテンツ生成の設定サービス（DB を正とした 1 行の CRUD と PiBff への注入）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSettingsRow } from "../src/app-db";
import type { ImageCatalog, ImageCatalogSnapshot } from "../src/image-catalog";
import {
  DEFAULT_IMAGE_MODEL,
  CONTENT_KEY_NOT_STORED_MESSAGE,
  CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_PROVIDER_UNSUPPORTED_MESSAGE,
  CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_SETTINGS_UNCONFIGURED_MESSAGE,
  ContentSettingsService,
  type ContentSettingsDb,
} from "../src/content-settings";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig } from "../src/images";

const KEY = "sk-image-dummy-key-0123456789abcdef";

class FakeContentDb implements ContentSettingsDb {
  row: ContentSettingsRow | undefined;
  failRead = false;
  failSave = false;
  failDelete = false;
  /** 保存の直後から read を失敗させる（書込成功後の読取失敗を再現する） */
  failReadAfterSave = false;
  events: string[] = [];

  readContentSettings(): ContentSettingsRow | undefined {
    if (this.failRead) throw new Error("db read boom");
    return this.row;
  }

  saveContentSettings(settings: ContentSettingsRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.events.push("save");
    this.row = settings;
    if (this.failReadAfterSave) this.failRead = true;
  }

  deleteContentSettings(): boolean {
    if (this.failDelete) throw new Error("db delete boom");
    this.events.push("delete");
    const existed = this.row !== undefined;
    this.row = undefined;
    return existed;
  }
}

/**
 * カタログの fake。取得とキャッシュ読込の呼び出し回数と、返す snapshot / 失敗文言をテストから動かせる。
 */
function createFakeCatalog(
  options: {
    models?: { provider: string; id: string; name: string }[];
    /** モデル id → 形式の宣言。生成前ガードへ渡る値をここで固定する */
    outputFormats?: Record<string, string[]>;
    source?: ImageCatalogSnapshot["source"];
    fetchedAt?: number | null;
    refreshError?: string | null;
  } = {},
) {
  const state = {
    refreshes: 0,
    loadedStored: 0,
    snapshot: {
      entries: options.models ?? [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
      source: options.source ?? ("live" as const),
      fetchedAt: options.fetchedAt ?? null,
    } as ImageCatalogSnapshot,
    refreshError: options.refreshError ?? null,
  };
  const catalog: ImageCatalog = {
    snapshot: () => state.snapshot,
    outputFormatsOf: (model) => options.outputFormats?.[model],
    loadStored: () => {
      state.loadedStored += 1;
    },
    refresh: async () => {
      state.refreshes += 1;
      return state.refreshError;
    },
  };
  return { catalog, state };
}

function createService(
  options: {
    db?: FakeContentDb;
    runtimeAvailable?: boolean;
    models?: { provider: string; id: string; name: string }[];
    outputFormats?: Record<string, string[]>;
    source?: ImageCatalogSnapshot["source"];
    fetchedAt?: number | null;
    refreshError?: string | null;
  } = {},
) {
  const db = options.db ?? new FakeContentDb();
  const retained: string[] = [];
  const configs: ContentGenerationConfig[] = [];
  const fake = createFakeCatalog(options);
  const service = new ContentSettingsService({
    db,
    runtimeAvailable: options.runtimeAvailable ?? true,
    retainSecret: (value) => {
      retained.push(value);
      db.events.push("retain");
    },
    catalog: fake.catalog,
    setContentGeneration: (config) => {
      configs.push(config);
      db.events.push(`inject:${config.enabled ? "on" : "off"}`);
    },
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
  });
  return { db, service, retained, configs, catalog: fake.state, latest: () => configs.at(-1) };
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

test("GET は行が無いとき未設定を返し、キーを載せない", () => {
  const { service } = createService();
  assert.deepEqual(service.settings(), {
    configured: false,
    provider: null,
    runtimeAvailable: true,
    image: {
      model: null,
      models: [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
      catalogSource: "live",
      fetchedAt: null,
    },
  });
});

test("キー登録はマスカー → DB → 注入の順に通し、行が無ければ既定 provider / model で作る", async () => {
  const { db, service, retained, configs, catalog } = createService();
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.equal(outcome.response.configured, true);
  assert.equal(outcome.response.provider, IMAGE_PROVIDER_ID);
  assert.equal(outcome.response.image.model, DEFAULT_IMAGE_MODEL);
  assert.equal(outcome.response.image.catalogSource, "live");
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY });
  assert.deepEqual(retained, [KEY], "マスカー登録は 1 回");
  assert.deepEqual(db.events, ["retain", "save", "inject:on"]);
  assert.equal(catalog.refreshes, 0, "キー保存は外部 API を待たない");
  assert.equal(configs.at(-1)?.enabled, true);
  assert.deepEqual(
    configs.at(-1)?.read(),
    { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY },
    "注入した read は DB の行を画像ツールの語彙へ写して返す",
  );
});

test("注入した config は一覧から落ちたモデルの形式宣言も引ける（生成前ガードの経路）", async () => {
  const { service, latest } = createService({
    outputFormats: { "recraft/recraft-v4.1-vector": ["svg"] },
  });
  await service.putKey(KEY);
  assert.deepEqual(latest()?.readOutputFormats("recraft/recraft-v4.1-vector"), ["svg"]);
  assert.equal(latest()?.readOutputFormats(DEFAULT_IMAGE_MODEL), undefined, "宣言なし・未知名は止めない");
});

test("カタログの再取得は失敗しても一覧を返し、固定文言だけを catalogError に載せる", async () => {
  const failing = createService({
    refreshError: "モデル一覧の取得がタイムアウトしました",
    source: "stored",
    fetchedAt: 500,
  });
  assert.deepEqual(await failing.service.refreshCatalog(), {
    models: [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
    catalogSource: "stored",
    fetchedAt: 500,
    catalogError: "モデル一覧の取得がタイムアウトしました",
  });
  assert.equal(failing.catalog.refreshes, 1);

  const ok = createService();
  assert.deepEqual(await ok.service.refreshCatalog(), {
    models: [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
    catalogSource: "live",
    fetchedAt: null,
    catalogError: null,
  });
});

test("キー上書きは選択済みの provider / model を保つ", async () => {
  const { db, service } = createService();
  db.row = { provider: IMAGE_PROVIDER_ID, imageModel: "black-forest-labs/flux.2-max", apiKey: "old-key" };
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, imageModel: "black-forest-labs/flux.2-max", apiKey: KEY });
});

test("provider / model の変更はキーを保持し、行が無い / provider が違う / カタログ外は 400", async () => {
  const { db, service } = createService();
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.match((error as Error).message, new RegExp(CONTENT_SETTINGS_UNCONFIGURED_MESSAGE));
      throw error;
    }
  }, "行が無いのに選択だけ変えられる");

  db.row = { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: "openai", model: DEFAULT_IMAGE_MODEL });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.equal((error as Error).message, CONTENT_PROVIDER_UNSUPPORTED_MESSAGE);
      throw error;
    }
  }, "openrouter 以外を受け付けている");
  await assert.rejects(async () => {
    try {
      await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: "ghost/model" });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.match((error as Error).message, new RegExp(CONTENT_MODEL_NOT_IN_CATALOG_MESSAGE));
      throw error;
    }
  }, "カタログ外のモデルを受け付けている");
  // 入力を反射する 400 文言はマスカーを通す（model に登録済みキーを渡されても再露出させない）
  const reflected = await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: KEY }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(reflected, "カタログ外の model が 400 にならない");
  assert.equal(statusOf(reflected), 400);
  assert.ok(!(reflected as Error).message.includes(KEY), "エラー文言にキーが残っている");
  assert.ok((reflected as Error).message.includes("[REDACTED]"));

  const outcome = await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL });
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY }, "キーを保つ");
});

test("キー削除は行ごと消して注入を無効にし、未設定でも 200 を返す", async () => {
  const { db, service, configs } = createService();
  db.row = { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY };
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
  const { db, service, retained, catalog } = createService({ runtimeAvailable: false });
  const outcome = await service.putKey(KEY);
  assert.deepEqual(outcome, { status: 503, error: CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE });
  assert.deepEqual(db.events, []);
  assert.deepEqual(retained, []);
  assert.equal(catalog.refreshes, 0, "保存できなければ取得もしない");
  assert.equal(service.settings().runtimeAvailable, false);
});

test("DB 失敗は 503 not_stored にして理由の分類だけを残す", async () => {
  const { db, service } = createService();
  db.failSave = true;
  assert.deepEqual(await service.putKey(KEY), { status: 503, error: CONTENT_KEY_NOT_STORED_MESSAGE });

  db.failSave = false;
  db.row = { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  db.failRead = true;
  assert.deepEqual(await service.putKey(KEY), { status: 503, error: CONTENT_KEY_NOT_STORED_MESSAGE });
  assert.deepEqual(await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }), {
    status: 503,
    error: CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  });

  db.failRead = false;
  db.failSave = true;
  assert.deepEqual(await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }), {
    status: 503,
    error: CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  });

  db.failSave = false;
  db.failDelete = true;
  assert.deepEqual(await service.deleteKey(), { status: 503, error: CONTENT_SETTINGS_NOT_STORED_MESSAGE });
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
  assert.deepEqual(db.row, { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY });
});

test("起動時の適用は行の有無を注入し、読めないときは無効で立ち警告だけを残す", async () => {
  const configured = createService();
  configured.db.row = { provider: IMAGE_PROVIDER_ID, imageModel: DEFAULT_IMAGE_MODEL, apiKey: KEY };
  await configured.service.applyStored();
  assert.equal(configured.latest()?.enabled, true);
  assert.deepEqual(configured.latest()?.read(), {
    provider: IMAGE_PROVIDER_ID,
    model: DEFAULT_IMAGE_MODEL,
    apiKey: KEY,
  });
  assert.deepEqual(configured.retained, [KEY], "起動時点の行もマスカーへ登録する");
  assert.deepEqual(
    [configured.catalog.loadedStored, configured.catalog.refreshes],
    [1, 1],
    "キャッシュを読んでから live を試す",
  );

  const unset = createService();
  await unset.service.applyStored();
  assert.equal(unset.latest()?.enabled, false);
  assert.equal(unset.latest()?.read(), undefined);
  assert.deepEqual(
    [unset.catalog.loadedStored, unset.catalog.refreshes],
    [1, 0],
    "未設定では一覧を出す画面が無いので取得しない",
  );

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
  assert.equal(broken.catalog.refreshes, 0, "行を確定できないときは取得しない");
  assert.ok(logged.join("\n").includes("content settings unavailable"), logged.join("\n"));
});
