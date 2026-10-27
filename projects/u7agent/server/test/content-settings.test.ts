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
  CONTENT_SPEECH_KEY_CONFLICT_MESSAGE,
  CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  CONTENT_SETTINGS_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_SETTINGS_UNCONFIGURED_MESSAGE,
  ContentSettingsService,
  type ContentSettingsDb,
} from "../src/content-settings";
import { CONTENT_DISABLED_MESSAGE, contentGenerationDisabled } from "../src/content-disabled";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig } from "../src/images";
import { SPEECH_PROVIDER_ID } from "../src/speech";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog } from "../src/speech-catalog";
import { bgmSettings, BGM_MODEL } from "../src/bgm";
import { testAppCipher } from "./app-secret-fixture";
import {
  APP_SECRET_DECRYPT_FAILED_MESSAGE,
  APP_SECRET_MASTER_KEY_MESSAGE,
  APP_SECRET_NOT_STORED_MESSAGE,
  APP_SECRET_UNEVALUATED_MESSAGE,
} from "../src/app-secrets";

const SPEECH_STUB = {
  provider: SPEECH_PROVIDER_ID,
  id: DEFAULT_SPEECH_MODEL,
  name: "Google: Gemini 3.8 Flash TTS",
  voices: ["Zephyr", "Kore"],
};

/**
 * 音声カタログの最小 stub。内容の検証は speech-settings.test.ts が持ち、ここでは設定サービスの
 * 音声部分が応答の形へ漏れないことだけを見る（既定の全件を返すと期待値が long になる）。
 */
function stubSpeechCatalog(): SpeechCatalog {
  return {
    snapshot: () => ({ entries: [SPEECH_STUB], source: "default", fetchedAt: null }),
    voicesOf: (model) => (model === SPEECH_STUB.id ? SPEECH_STUB.voices : undefined),
    loadStored: () => {},
    refresh: async () => null,
  };
}

const KEY = "sk-image-dummy-key-0123456789abcdef";

const CIPHER = testAppCipher();

/** 平文キーを暗号化した保存形。保存値に平文が残っていないことを確かめるために使う */
function secretOf(plaintext: string): Pick<ContentSettingsRow, "ciphertext" | "nonce" | "keyVersion"> {
  const encrypted = CIPHER.encrypt("content_settings", "apiKey", plaintext);
  return { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, keyVersion: encrypted.keyVersion };
}

/** 行の平文キー。暗号文は毎回変わるため、値の比較は復号してから行う */
function storedKey(row: ContentSettingsRow | undefined): string | undefined {
  if (!row || row.ciphertext === null || row.nonce === null || row.keyVersion === null) return undefined;
  return CIPHER.decrypt("content_settings", "apiKey", {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.keyVersion,
  });
}

/** 行を期待値と比べる。暗号文 (nonce) は保存のたびに変わるので、復号した値と他の列だけを見る */
function assertRow(
  row: ContentSettingsRow | undefined,
  expected: {
    provider: string;
    imageModel: string;
    speechModel: string | null;
    speechVoice: string | null;
    enabled: boolean;
    apiKey: string;
  },
): void {
  assert.ok(row, "行が保存されている");
  assert.equal(row.provider, expected.provider);
  assert.equal(row.imageModel, expected.imageModel);
  assert.equal(row.speechModel, expected.speechModel);
  assert.equal(row.speechVoice, expected.speechVoice);
  assert.equal(row.enabled, expected.enabled);
  assert.equal(storedKey(row), expected.apiKey, "平文ではなく暗号文で保存する");
}

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
    imageInputOf: () => undefined,
    checkImageInput: async () => undefined,
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
    /** null は master key 未設定の起動を表す */
    cipher?: ReturnType<typeof testAppCipher> | null;
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
    speechCatalog: stubSpeechCatalog(),
    setContentGeneration: (config) => {
      configs.push(config);
      db.events.push(`inject:${config.enabled ? "on" : "off"}`);
    },
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
    appCipher: options.cipher === undefined ? CIPHER : options.cipher,
  });
  return { db, service, retained, configs, catalog: fake.state, latest: () => configs.at(-1) };
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

test("GET は行が無いとき未設定を返し、キーを載せない", () => {
  const { service } = createService();
  assert.deepEqual(service.settings(), {
    bgm: bgmSettings(false),
    configured: false,
    keyStored: false,
    keyAvailable: false,
    keyEvaluated: true,
    keyErrorMessage: null,
    provider: null,
    enabled: true,
    disabledMessage: CONTENT_DISABLED_MESSAGE,
    runtimeAvailable: true,
    image: {
      model: null,
      models: [{ provider: IMAGE_PROVIDER_ID, id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" }],
      catalogSource: "live",
      fetchedAt: null,
    },
    speech: {
      model: null,
      voice: "",
      models: [SPEECH_STUB],
      catalogSource: "default",
      fetchedAt: null,
    },
  });
});

test("BGMの表示DTOはキー有無だけで決まりreadBgmは実行時の回転・削除に追随する", async () => {
  const { service, configs, db, catalog } = createService();
  assert.deepEqual(service.settings().bgm, bgmSettings(false));
  assert.equal(catalog.refreshes, 0);
  const saved = await service.putKey(KEY);
  assert.equal(saved.status, 200);
  if (saved.status !== 200) return;
  assert.deepEqual(saved.response.bgm, bgmSettings(true));
  const sessionRead = configs.at(-1)!.readBgm;
  assert.deepEqual(sessionRead(), { model: BGM_MODEL, apiKey: KEY });
  const rotated = KEY + "-rotated";
  await service.putKey(rotated);
  assert.deepEqual(sessionRead(), { model: BGM_MODEL, apiKey: rotated });
  assert.deepEqual(service.settings().bgm, bgmSettings(true));
  assert.equal(JSON.stringify(service.settings()).includes(rotated), false);
  assert.equal(Object.hasOwn(db.row!, "bgmModel"), false);
  assert.equal(catalog.refreshes, 0);
  const removed = await service.deleteKey();
  assert.equal(removed.status, 200);
  assert.equal(sessionRead(), undefined);
  assert.deepEqual(service.settings().bgm, bgmSettings(false));
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
  assertRow(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    apiKey: KEY,
  });
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

test("キー上書きは選択済みの provider / model と有効 / 無効を保つ", async () => {
  const { db, service, latest } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: "black-forest-labs/flux.2-max",
    speechModel: null,
    speechVoice: null,
    enabled: false,
    ...secretOf("old-key"),
  };
  const outcome = await service.putKey(KEY);
  assert.equal(outcome.status, 200);
  assertRow(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: "black-forest-labs/flux.2-max",
    speechModel: null,
    speechVoice: null,
    // OFF のままキーだけ差し替える（キー登録で黙って有効へ戻さない）
    enabled: false,
    apiKey: KEY,
  });
  assert.equal(latest()?.enabled, false, "OFF のままツールを公開しない");
});

test("有効 / 無効は行の 1 列で、キーと選択を保ったまま切り替えられる", async () => {
  const { db, service, latest } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  // 起動時の適用を通して、メモリ上の復号結果を利用可にする
  await service.applyStored();

  const off = await service.putEnabled(false);
  assert.equal(off.status, 200);
  if (off.status !== 200) return;
  assert.equal(off.response.state, "applied");
  assert.equal(off.response.enabled, false);
  assert.equal(off.response.configured, true, "OFF でも未設定にはしない");
  assert.equal(off.response.image.model, DEFAULT_IMAGE_MODEL, "モデルの選択を保つ");
  assertRow(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: false,
    apiKey: KEY,
  });
  assert.equal(latest()?.enabled, false, "次に作るセッションへ即時反映する");
  assert.equal(latest()?.configured, true, "停止の理由をキー未設定と書き分けられる");
  assert.equal(latest()?.disabled, true, "実行時の課金前チェックも OFF を見る");
  assert.deepEqual(
    latest()?.read(),
    { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY },
    "OFF でも実行時の読み取りはキーを返す（キー無効エラーとは別の止め方）",
  );

  const on = await service.putEnabled(true);
  assert.equal(on.status, 200);
  if (on.status !== 200) return;
  assert.equal(on.response.enabled, true);
  assert.equal(db.row?.enabled, true);
  assert.equal(latest()?.enabled, true);
  assert.equal(latest()?.disabled, false);
});

test("有効 / 無効の変更は行が無ければ 400、保存できなければ 503 で写しも変えない", async () => {
  const unset = createService();
  await assert.rejects(async () => {
    try {
      await unset.service.putEnabled(false);
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.equal((error as Error).message, CONTENT_SETTINGS_UNCONFIGURED_MESSAGE);
      throw error;
    }
  }, "キー未設定で止める対象は無い");

  const failing = createService();
  failing.db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  failing.db.failSave = true;
  assert.deepEqual(await failing.service.putEnabled(false), {
    status: 503,
    error: CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  });
  assert.equal(failing.latest(), undefined, "保存できていないのに写しを差し替えない");
  assert.equal(failing.db.row?.enabled, true);
});

test("実行時の OFF 判定はキー未設定（行が無い）を OFF と混同しない", () => {
  // 削除後は enabled も false になるが、ツールへ返すのはキー無効エラーでなければならない
  assert.equal(contentGenerationDisabled(undefined), false);
  assert.equal(contentGenerationDisabled({ disabled: false }), false, "キーがあって ON なら止めない");
  assert.equal(contentGenerationDisabled({ disabled: true }), true, "設定のトグルが OFF のときだけ止める");
});

test("GET は有効 / 無効と、OFF の間にモデルへ返す固定文言を載せる", () => {
  const { db, service } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: false,
    ...secretOf(KEY),
  };
  assert.equal(service.settings().enabled, false);
  assert.equal(service.settings().disabledMessage, CONTENT_DISABLED_MESSAGE);
  assert.equal(service.settings().configured, true);
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

  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  await service.applyStored();
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
  assertRow(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    apiKey: KEY,
  });
});

test("キー削除は行ごと消して注入を無効にし、未設定でも 200 を返す", async () => {
  const { db, service, configs } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  const first = await service.deleteKey();
  assert.equal(first.status, 200);
  if (first.status !== 200) return;
  assert.equal(first.response.state, "applied");
  assert.equal(first.response.configured, false);
  assert.equal(first.response.provider, null);
  assert.equal(db.row, undefined);
  assert.equal(configs.at(-1)?.enabled, false);
  assert.equal(configs.at(-1)?.disabled, false, "削除は「設定で OFF」ではない（実行時はキー無効エラーへ落とす）");
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
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
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
  assertRow(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    apiKey: KEY,
  });
});

test("起動時の適用は行の有無を注入し、読めないときは無効で立ち警告だけを残す", async () => {
  const configured = createService();
  configured.db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
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

test("master key が無い起動でも、保存済みキーは「未設定」と混同せず、削除はできる", async () => {
  const { service, db } = createService({ cipher: null });
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  await service.applyStored();

  const settings = service.settings();
  assert.equal(settings.keyStored, true);
  assert.equal(settings.keyAvailable, false);
  assert.equal(settings.keyEvaluated, true, "復号を試せない既知の失敗として評価済みにする");
  assert.equal(settings.keyErrorMessage, APP_SECRET_MASTER_KEY_MESSAGE);
  assert.ok(!JSON.stringify(settings).includes(KEY));

  // ツールは開かない (平文の代用もしない)
  assert.equal(service.settings().configured, true);
  const outcome = await service.putKey(KEY);
  assert.deepEqual(outcome, { status: 503, error: APP_SECRET_NOT_STORED_MESSAGE });

  // 復号が要らない削除は master key 無しでも通る
  assert.equal((await service.deleteKey()).status, 200);
  assert.equal(db.row, undefined);
  assert.equal(service.settings().keyStored, false);
});

test("誤鍵・破損した暗号文は平文へ落とさず、固定文言で利用不可にする", async () => {
  const { service, db } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ciphertext: new Uint8Array([1, 2, 3, 4]),
    nonce: new Uint8Array(12),
    keyVersion: 1,
  };
  await service.applyStored();

  const settings = service.settings();
  assert.equal(settings.keyStored, true);
  assert.equal(settings.keyAvailable, false);
  assert.equal(settings.keyEvaluated, true);
  assert.equal(settings.keyErrorMessage, APP_SECRET_DECRYPT_FAILED_MESSAGE);
  assert.ok(!JSON.stringify(service.settings()).includes(KEY), "応答にキーを出さない");
});

test("runtime が無い起動では暗号文を復号せず、未評価として返す", async () => {
  const { service, db } = createService({ runtimeAvailable: false });
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  await service.applyStored();

  const settings = service.settings();
  assert.equal(settings.keyStored, true);
  assert.equal(settings.keyAvailable, false);
  assert.equal(settings.keyEvaluated, false, "誤鍵・破損と断定しない");
  assert.equal(settings.keyErrorMessage, APP_SECRET_UNEVALUATED_MESSAGE);
});

test("保存済みの音声値が新しいキーを含むなら、キーの置換を拒否して平文を残さない", async () => {
  const { service, db } = createService();
  await service.putKey(KEY);
  // 宣言が無いモデルなので自由記述を許す。次のキーと同じ値をボイスとして残す
  const nextKey = "sk-image-rotated-key-0123456789";
  assert.equal((await service.putSpeechSelection({ model: "fish/audio", voice: nextKey })).status, 200);

  const before = db.row;
  const rejected = await service.putKey(nextKey);
  assert.equal(rejected.status, 400, "音声値に含まれるキーへは置換できない");
  if (rejected.status === 400) {
    assert.equal(rejected.error, CONTENT_SPEECH_KEY_CONFLICT_MESSAGE);
    assert.ok(!rejected.error.includes(nextKey), "文言にキーを出さない");
  }
  assert.equal(db.row, before, "拒否した要求で保存値を書き換えない");
  assert.equal(storedKey(db.row), KEY, "保存済みのキーは元のまま");
});

test("起動時の DB 読取に失敗したら未評価のまま残し、復旧後の GET で案内を出す", async () => {
  const { service, db } = createService();
  db.row = {
    provider: IMAGE_PROVIDER_ID,
    imageModel: DEFAULT_IMAGE_MODEL,
    speechModel: null,
    speechVoice: null,
    enabled: true,
    ...secretOf(KEY),
  };
  db.failRead = true;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    await service.applyStored();
  } finally {
    console.error = original;
  }
  assert.ok(logged.join("\n").includes("content settings unavailable"));

  // DB が復旧しても、GET で復号はせず「まだ確認できていない」のまま返す
  db.failRead = false;
  const settings = service.settings();
  assert.equal(settings.keyStored, true);
  assert.equal(settings.keyAvailable, false);
  assert.equal(settings.keyEvaluated, false);
  assert.equal(settings.keyErrorMessage, APP_SECRET_UNEVALUATED_MESSAGE);
});
