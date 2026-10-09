// 音声の設定サービス（content_settings の音声列、フォールバック、カタログ照合、注入する読取口）。
// 実 API は呼ばず fake db / fake カタログで検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSettingsRow } from "../src/app-db";
import {
  CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  CONTENT_SETTINGS_UNCONFIGURED_MESSAGE,
  CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE,
  ContentSettingsService,
  type ContentSettingsDb,
} from "../src/content-settings";
import type { ImageCatalog, ImageCatalogSnapshot } from "../src/image-catalog";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig } from "../src/images";
import { SPEECH_PROVIDER_ID } from "../src/speech";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog, type SpeechCatalogSnapshot } from "../src/speech-catalog";

const KEY = "sk-speech-dummy-key-0123456789abcdef";

class FakeContentDb implements ContentSettingsDb {
  row: ContentSettingsRow | undefined;
  failRead = false;
  failSave = false;
  events: string[] = [];

  readContentSettings(): ContentSettingsRow | undefined {
    if (this.failRead) throw new Error("db read boom");
    return this.row;
  }

  saveContentSettings(settings: ContentSettingsRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.events.push("save");
    this.row = settings;
  }

  deleteContentSettings(): boolean {
    this.events.push("delete");
    const existed = this.row !== undefined;
    this.row = undefined;
    return existed;
  }
}

const LIVE_MODELS = [
  {
    provider: SPEECH_PROVIDER_ID,
    id: DEFAULT_SPEECH_MODEL,
    name: "Google: Gemini 3.8 Flash TTS",
    voices: ["Zephyr", "Kore"],
  },
  { provider: SPEECH_PROVIDER_ID, id: "fish/audio", name: "Fish Audio" },
];

function createFakeSpeechCatalog(
  options: {
    models?: typeof LIVE_MODELS;
    source?: SpeechCatalogSnapshot["source"];
    fetchedAt?: number | null;
    refreshError?: string | null;
  } = {},
) {
  const state = {
    refreshes: 0,
    loadedStored: 0,
    snapshot: {
      entries: options.models ?? LIVE_MODELS,
      source: options.source ?? ("live" as const),
      fetchedAt: options.fetchedAt ?? null,
    } as SpeechCatalogSnapshot,
    refreshError: options.refreshError ?? null,
  };
  const catalog: SpeechCatalog = {
    snapshot: () => state.snapshot,
    voicesOf: (model) => state.snapshot.entries.find((entry) => entry.id === model)?.voices,
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

/** 画像側はこのファイルの対象ではないため、空の一覧を返す最小 stub に固定する */
function stubImageCatalog(): ImageCatalog {
  const snapshot: ImageCatalogSnapshot = { entries: [], source: "sdk", fetchedAt: null };
  return {
    snapshot: () => snapshot,
    outputFormatsOf: () => undefined,
    loadStored: () => {},
    refresh: async () => null,
  };
}

function createService(
  options: {
    db?: FakeContentDb;
    speechModels?: typeof LIVE_MODELS;
    speechSource?: SpeechCatalogSnapshot["source"];
    speechFetchedAt?: number | null;
    refreshError?: string | null;
    /** ランタイムなし（`pi: null`）の起動を模す。既定は保存済みキーを知るマスカー */
    identityMasker?: boolean;
  } = {},
) {
  const db = options.db ?? new FakeContentDb();
  const configs: ContentGenerationConfig[] = [];
  const fake = createFakeSpeechCatalog({
    models: options.speechModels,
    source: options.speechSource,
    fetchedAt: options.speechFetchedAt,
    refreshError: options.refreshError,
  });
  const service = new ContentSettingsService({
    db,
    runtimeAvailable: true,
    retainSecret: () => {},
    catalog: stubImageCatalog(),
    speechCatalog: fake.catalog,
    setContentGeneration: (config) => {
      configs.push(config);
      db.events.push(`inject:${config.enabled ? "on" : "off"}`);
    },
    maskError: options.identityMasker ? (text) => text : (text) => text.split(KEY).join("[REDACTED]"),
  });
  return { db, service, catalog: fake.state, latest: () => configs.at(-1) };
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

function rowWith(speechModel: string | null, speechVoice: string | null): ContentSettingsRow {
  return { provider: IMAGE_PROVIDER_ID, imageModel: "openai/gpt-image-2", speechModel, speechVoice, apiKey: KEY };
}

test("GET は音声列が NULL の既存行を既定モデルと先頭ボイスへフォールバックする", () => {
  const { db, service } = createService();
  db.row = rowWith(null, null);
  const settings = service.settings();
  assert.deepEqual(settings.speech, {
    model: DEFAULT_SPEECH_MODEL,
    voice: "Zephyr",
    models: LIVE_MODELS,
    catalogSource: "live",
    fetchedAt: null,
  });

  db.row = rowWith(DEFAULT_SPEECH_MODEL, "Kore");
  assert.equal(service.settings().speech.voice, "Kore", "保存値があれば優先する");

  // 宣言が無いモデルは voice を空にする（送らない）
  db.row = rowWith("fish/audio", null);
  assert.equal(service.settings().speech.voice, "");
});

test("PUT はモデル / ボイスを保存し、キーと画像の選択を保つ", async () => {
  const { db, service, latest } = createService();
  db.row = rowWith(null, null);
  const outcome = await service.putSpeechSelection({ model: "fish/audio", voice: "any-voice-id" });
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.state, "applied");
  assert.equal(outcome.response.image.model, "openai/gpt-image-2", "画像の選択を保つ");
  assert.deepEqual(outcome.response.speech, {
    model: "fish/audio",
    voice: "any-voice-id",
    models: LIVE_MODELS,
    catalogSource: "live",
    fetchedAt: null,
  });
  assert.deepEqual(db.row, {
    provider: IMAGE_PROVIDER_ID,
    imageModel: "openai/gpt-image-2",
    speechModel: "fish/audio",
    speechVoice: "any-voice-id",
    apiKey: KEY,
  });
  assert.equal(latest()?.enabled, true, "保存で注入を更新する");
  assert.deepEqual(
    latest()?.readSpeech(),
    { provider: IMAGE_PROVIDER_ID, model: "fish/audio", voice: "any-voice-id", apiKey: KEY },
    "注入した readSpeech は音声ツールの語彙で返す",
  );
});

test("空文字のボイスは未指定として NULL で保存し、実効値は先頭ボイスへ戻る", async () => {
  const { db, service } = createService();
  db.row = rowWith(null, null);
  const outcome = await service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: "" });
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(db.row?.speechVoice, null);
  assert.equal(outcome.response.speech.voice, "Zephyr");
});

test("行が無い / カタログ外モデル / 宣言外の声は 400 にする", async () => {
  const missing = createService();
  await assert.rejects(async () => {
    try {
      await missing.service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.equal((error as Error).message, CONTENT_SETTINGS_UNCONFIGURED_MESSAGE);
      throw error;
    }
  }, "行が無いのに保存できている");

  const { db, service } = createService();
  db.row = rowWith(null, null);
  for (const input of [
    { model: "ghost/model", voice: "" },
    { model: DEFAULT_SPEECH_MODEL, voice: "Ghost" },
  ]) {
    const error = await service.putSpeechSelection(input).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    assert.equal(statusOf(error), 400, JSON.stringify(input));
  }
  // 入力を反射する 400 文言はマスカーを通す（model / voice にキーを誤って渡されても再露出させない）
  const reflectedModel = (await service.putSpeechSelection({ model: KEY, voice: "" }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )) as Error;
  assert.equal(statusOf(reflectedModel), 400);
  assert.ok(reflectedModel.message.startsWith(CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE));
  assert.ok(!reflectedModel.message.includes(KEY), `400 の文言にキーが残っている: ${reflectedModel.message}`);
  assert.ok(reflectedModel.message.includes("[REDACTED]"));

  const reflectedVoice = (await service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: KEY }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )) as Error;
  assert.equal(statusOf(reflectedVoice), 400);
  assert.ok(reflectedVoice.message.startsWith(CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE));
  assert.ok(!reflectedVoice.message.includes(KEY), `400 の文言にキーが残っている: ${reflectedVoice.message}`);
  assert.ok(reflectedVoice.message.includes("[REDACTED]"));
});

test("カタログが default（live に一度も成功していない）のときは照合しない", async () => {
  const { db, service } = createService({ speechSource: "default", speechFetchedAt: null });
  db.row = rowWith(null, null);
  const outcome = await service.putSpeechSelection({ model: "ghost/model", voice: "free" });
  assert.equal(outcome.status, 200, "同梱の 1 件しか無い状態で保存済みの選択を再保存できなくしない");
  if (outcome.status !== 200) return;
  assert.deepEqual(db.row?.speechModel, "ghost/model");
  assert.deepEqual(db.row?.speechVoice, "free");
});

test("DB 失敗は 503 not_stored にして、理由の分類だけを残す", async () => {
  const { db, service } = createService();
  db.row = rowWith(null, null);
  db.failSave = true;
  assert.deepEqual(await service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }), {
    status: 503,
    error: CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  });

  db.failSave = false;
  db.failRead = true;
  assert.deepEqual(await service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr" }), {
    status: 503,
    error: CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  });
});

test("再取得は失敗しても一覧を返し、固定文言だけを catalogError に載せる", async () => {
  const failing = createService({
    refreshError: "モデル一覧の取得がタイムアウトしました",
    speechSource: "stored",
    speechFetchedAt: 500,
  });
  assert.deepEqual(await failing.service.refreshSpeechCatalog(), {
    models: LIVE_MODELS,
    catalogSource: "stored",
    fetchedAt: 500,
    catalogError: "モデル一覧の取得がタイムアウトしました",
  });
  assert.equal(failing.catalog.refreshes, 1);

  const ok = createService();
  assert.deepEqual(await ok.service.refreshSpeechCatalog(), {
    models: LIVE_MODELS,
    catalogSource: "live",
    fetchedAt: null,
    catalogError: null,
  });
});

test("起動時の適用は画像と同じ順にキャッシュを読んで live を試し、有効化時に読取口を差し替える", async () => {
  const configured = createService();
  configured.db.row = rowWith(null, null);
  await configured.service.applyStored();
  assert.equal(configured.latest()?.enabled, true);
  assert.deepEqual(
    [configured.catalog.loadedStored, configured.catalog.refreshes],
    [1, 1],
    "キャッシュを読んでから live を試す",
  );
  assert.deepEqual(configured.latest()?.readSpeech(), {
    provider: IMAGE_PROVIDER_ID,
    model: DEFAULT_SPEECH_MODEL,
    voice: "Zephyr",
    apiKey: KEY,
  });
  assert.deepEqual(configured.latest()?.readVoices(DEFAULT_SPEECH_MODEL), ["Zephyr", "Kore"]);
  assert.equal(configured.latest()?.readVoices("ghost/model"), undefined);

  const unset = createService();
  await unset.service.applyStored();
  assert.equal(unset.latest()?.enabled, false);
  assert.equal(unset.latest()?.readSpeech(), undefined);
  assert.deepEqual([unset.catalog.loadedStored, unset.catalog.refreshes], [1, 0], "未設定では取得しない");
});

test("キー削除は音声の選択も含めて行ごと消し、注入を無効にする", async () => {
  const { db, service, latest } = createService();
  db.row = rowWith(DEFAULT_SPEECH_MODEL, "Kore");
  await service.deleteKey();
  assert.equal(db.row, undefined);
  assert.equal(latest()?.enabled, false);
  assert.equal(latest()?.readSpeech(), undefined);
  assert.equal(service.settings().speech.model, null, "未設定では音声モデルも null へ戻る");
  assert.equal(service.settings().speech.voice, "");
});

test("キーの登録は音声の選択を巻き戻さない", async () => {
  const { db, service } = createService();
  db.row = rowWith(DEFAULT_SPEECH_MODEL, "Kore");
  const outcome = await service.putKey("sk-speech-new-key-0123456789");
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.response.speech.model, DEFAULT_SPEECH_MODEL);
  assert.equal(outcome.response.speech.voice, "Kore");
  assert.equal(db.row?.apiKey, "sk-speech-new-key-0123456789");
});

test("ボイス / モデルに保護済みキーがあっても、応答と実行時の解決はどちらも未設定として扱う", async () => {
  // 宣言が無いモデルは自由記述を許すため、キーを誤ってボイス欄へ貼ると保存は成功する
  const free = createService();
  free.db.row = rowWith(null, null);
  const saved = await free.service.putSpeechSelection({ model: "fish/audio", voice: KEY });
  assert.equal(saved.status, 200);
  if (saved.status !== 200) return;
  assert.equal(saved.response.speech.voice, "", "マスク済みの文字列もそのまま返さない");
  assert.ok(!JSON.stringify(saved.response).includes(KEY), "成功応答にキーを出さない");
  assert.equal(free.service.settings().speech.voice, "");
  assert.ok(!JSON.stringify(free.service.settings()).includes(KEY), "GET にキーを出さない");
  assert.equal(
    free.latest()?.readSpeech()?.voice,
    free.service.settings().speech.voice,
    "実行時の解決も表示と同じ（保存値のキーをボイスとして送らない）",
  );
  assert.equal(free.db.row?.speechVoice, KEY, "保存値そのものは消さない");

  // 別の成功 mutation（キー登録）の応答も同じ境界を通る
  const rotated = await free.service.putKey("sk-speech-rotated-key-0123456789");
  assert.equal(rotated.status, 200);
  if (rotated.status === 200) {
    assert.ok(!JSON.stringify(rotated.response).includes(KEY), "キー登録の成功応答にも出さない");
  }

  // default はカタログ照合をしないため、モデルにもキーを保存できる
  const defaulted = createService({ speechSource: "default", speechFetchedAt: null });
  defaulted.db.row = rowWith(null, null);
  const savedModel = await defaulted.service.putSpeechSelection({ model: KEY, voice: "" });
  assert.equal(savedModel.status, 200);
  if (savedModel.status !== 200) return;
  assert.equal(savedModel.response.speech.model, DEFAULT_SPEECH_MODEL, "キーは既定モデルへ落とす");
  assert.ok(!JSON.stringify(savedModel.response).includes(KEY));
  assert.equal(defaulted.service.settings().speech.model, DEFAULT_SPEECH_MODEL);
  assert.ok(!JSON.stringify(defaulted.service.settings()).includes(KEY));
  assert.equal(defaulted.latest()?.readSpeech()?.model, DEFAULT_SPEECH_MODEL);
  assert.equal(defaulted.db.row?.speechModel, KEY, "保存値そのものは消さない");
});

test("マスカーがキーを知らない起動でも、400 の文言へキーを反射しない", async () => {
  const { db, service } = createService({ identityMasker: true });
  db.row = rowWith(null, null);

  const voiceError = (await service.putSpeechSelection({ model: DEFAULT_SPEECH_MODEL, voice: KEY }).then(
    () => undefined,
    (error: unknown) => error,
  )) as Error;
  assert.equal(statusOf(voiceError), 400);
  assert.ok(voiceError.message.startsWith(CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE), "分類の文言は残す");
  assert.ok(!voiceError.message.includes(KEY), `400 の文言にキーが残っている: ${voiceError.message}`);
  assert.ok(voiceError.message.includes("[REDACTED]"));

  const modelError = (await service.putSpeechSelection({ model: KEY, voice: "" }).then(
    () => undefined,
    (error: unknown) => error,
  )) as Error;
  assert.equal(statusOf(modelError), 400);
  assert.ok(modelError.message.startsWith(CONTENT_SPEECH_MODEL_NOT_IN_CATALOG_MESSAGE));
  assert.ok(!modelError.message.includes(KEY), `400 の文言にキーが残っている: ${modelError.message}`);
  assert.ok(modelError.message.includes("[REDACTED]"));

  // 画像モデルの反射も同じ境界を通る
  const imageError = (await service.putSelection({ provider: IMAGE_PROVIDER_ID, model: KEY }).then(
    () => undefined,
    (error: unknown) => error,
  )) as Error;
  assert.equal(statusOf(imageError), 400);
  assert.ok(!imageError.message.includes(KEY), `400 の文言にキーが残っている: ${imageError.message}`);
  assert.ok(imageError.message.includes("[REDACTED]"));
});

test("マスカーがキーを知らない起動でも、同じ行の APIキーをボイス / モデルとして出さない", async () => {
  // pi: null の起動（bootstrap が identity masker を渡す経路）。マスカーだけに頼ると保存値が再露出する
  const free = createService({ identityMasker: true });
  free.db.row = rowWith(null, null);
  const saved = await free.service.putSpeechSelection({ model: "fish/audio", voice: KEY });
  assert.equal(saved.status, 200);
  if (saved.status !== 200) return;
  assert.equal(saved.response.speech.voice, "", "成功応答にキーを出さない");
  assert.ok(!JSON.stringify(saved.response).includes(KEY));
  assert.equal(free.service.settings().speech.voice, "", "GET にもキーを出さない");
  assert.ok(!JSON.stringify(free.service.settings()).includes(KEY));
  assert.equal(free.latest()?.readSpeech()?.voice, "", "実行時解決にもキーを出さない");
  assert.equal(free.db.row?.speechVoice, KEY, "保存値そのものは消さない");

  // default の自由なモデル指定も同じ境界を通る
  const defaulted = createService({ identityMasker: true, speechSource: "default", speechFetchedAt: null });
  defaulted.db.row = rowWith(null, null);
  const savedModel = await defaulted.service.putSpeechSelection({ model: KEY, voice: "" });
  assert.equal(savedModel.status, 200);
  if (savedModel.status !== 200) return;
  assert.equal(savedModel.response.speech.model, DEFAULT_SPEECH_MODEL);
  assert.ok(!JSON.stringify(savedModel.response).includes(KEY));
  assert.equal(defaulted.service.settings().speech.model, DEFAULT_SPEECH_MODEL);
  assert.ok(!JSON.stringify(defaulted.service.settings()).includes(KEY));
  assert.equal(defaulted.latest()?.readSpeech()?.model, DEFAULT_SPEECH_MODEL);
  assert.equal(defaulted.db.row?.speechModel, KEY, "保存値そのものは消さない");
});

test("ボイスが NULL の行はカタログの並びが変われば、応答も実行時も同じ先頭ボイスへ寄る", async () => {
  // NULL のボイスは「そのモデルが宣言する先頭」へフォールバックする。並びが変われば実効値も変わる
  const { db, service, latest, catalog } = createService();
  db.row = rowWith(DEFAULT_SPEECH_MODEL, null);
  await service.applyStored();
  assert.equal(service.settings().speech.voice, "Zephyr");
  catalog.snapshot = {
    ...catalog.snapshot,
    entries: catalog.snapshot.entries.map((entry) =>
      entry.id === DEFAULT_SPEECH_MODEL ? { ...entry, voices: ["Kore", "Zephyr"] } : entry,
    ),
  };
  assert.equal(service.settings().speech.voice, "Kore", "GET は新しい並びの先頭を返す");
  assert.equal(latest()?.readSpeech()?.voice, "Kore", "実行時も GET と同じ値へ解決する");
});
