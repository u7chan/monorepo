// 音声の設定サービス（content_settings の音声列、フォールバック、カタログ照合、注入する読取口）。
// 実 API は呼ばず fake db / fake カタログで検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSettingsRow } from "../src/app-db";
import {
  CONTENT_SETTINGS_NOT_STORED_MESSAGE,
  CONTENT_SETTINGS_UNCONFIGURED_MESSAGE,
  CONTENT_SPEECH_KEY_INCLUDED_MESSAGE,
  CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE,
  ContentSettingsService,
  type ContentSettingsDb,
} from "../src/content-settings";
import type { ImageCatalog, ImageCatalogSnapshot } from "../src/image-catalog";
import { IMAGE_PROVIDER_ID, type ContentGenerationConfig } from "../src/images";
import {
  CONTENT_SPEECH_PREVIEW_READ_FAILED_MESSAGE,
  CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE,
} from "../src/content-settings";
import { SPEECH_PROVIDER_ID } from "../src/speech";
import type { SpeechGenerationInput, SpeechGenerationResult } from "../src/speech";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import { DEFAULT_SPEECH_MODEL, type SpeechCatalog, type SpeechCatalogSnapshot } from "../src/speech-catalog";
import { testAppCipher } from "./app-secret-fixture";

const KEY = "sk-speech-dummy-key-0123456789abcdef";

const CIPHER = testAppCipher();

/** 平文キーを暗号化した保存形。content_settings のキーは AAD で列に結び付く */
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
    imageInputOf: () => undefined,
    checkImageInput: async () => undefined,
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
    /** お試し再生の生成器。省略は「未注入」（ランタイムなしで起動）を表す */
    generateSpeech?: (input: SpeechGenerationInput) => Promise<SpeechGenerationResult>;
  } = {},
) {
  const db = options.db ?? new FakeContentDb();
  const configs: ContentGenerationConfig[] = [];
  const previewCalls: SpeechGenerationInput[] = [];
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
    appCipher: CIPHER,
    ...(options.generateSpeech
      ? {
          generateSpeech: (input: SpeechGenerationInput) => {
            previewCalls.push(input);
            return options.generateSpeech!(input);
          },
        }
      : {}),
  });
  return { db, service, catalog: fake.state, previewCalls, latest: () => configs.at(-1) };
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

function rowWith(speechModel: string | null, speechVoice: string | null, enabled = true): ContentSettingsRow {
  return {
    provider: IMAGE_PROVIDER_ID,
    imageModel: "openai/gpt-image-2",
    speechModel,
    speechVoice,
    enabled,
    ...secretOf(KEY),
  };
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
  // 起動時の適用を通して、キーを復号済みにする (音声の保存はキーとの照合を含む)
  await service.applyStored();
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
  assert.equal(db.row?.speechModel, "fish/audio");
  assert.equal(db.row?.speechVoice, "any-voice-id");
  assert.equal(storedKey(db.row), KEY, "キーは暗号文のまま保つ");
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
  await service.applyStored();
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
  await service.applyStored();
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
  // キーと同じ値を音声の語彙へ渡す要求は、値を伏せた固定文言で 400 にする (反射もしない)
  for (const input of [
    { model: KEY, voice: "" },
    { model: DEFAULT_SPEECH_MODEL, voice: KEY },
  ]) {
    const included = (await service.putSpeechSelection(input).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )) as Error;
    assert.equal(statusOf(included), 400, JSON.stringify(input).replaceAll(KEY, "<key>"));
    assert.equal(included.message, CONTENT_SPEECH_KEY_INCLUDED_MESSAGE);
    assert.ok(!included.message.includes(KEY), `400 の文言にキーが残っている: ${included.message}`);
  }
});

test("カタログが default（live に一度も成功していない）のときは照合しない", async () => {
  const { db, service } = createService({ speechSource: "default", speechFetchedAt: null });
  db.row = rowWith(null, null);
  await service.applyStored();
  const outcome = await service.putSpeechSelection({ model: "ghost/model", voice: "free" });
  assert.equal(outcome.status, 200, "同梱の 1 件しか無い状態で保存済みの選択を再保存できなくしない");
  if (outcome.status !== 200) return;
  assert.deepEqual(db.row?.speechModel, "ghost/model");
  assert.deepEqual(db.row?.speechVoice, "free");
});

test("DB 失敗は 503 not_stored にして、理由の分類だけを残す", async () => {
  const { db, service } = createService();
  db.row = rowWith(null, null);
  await service.applyStored();
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
  assert.equal(storedKey(db.row), "sk-speech-new-key-0123456789");
});

test("ボイス / モデルにキーを混ぜた保存要求は 400 で拒否し、保存値を書き換えない", async () => {
  // 宣言が無いモデルは自由記述を許すため、キーを誤ってボイス欄へ貼る操作自体は通り得る。
  // 黙って消して保存せず、値を伏せた 400 で止める
  const free = createService();
  free.db.row = rowWith(null, null);
  await free.service.applyStored();
  const before = free.db.row;
  await assert.rejects(async () => {
    try {
      await free.service.putSpeechSelection({ model: "fish/audio", voice: KEY });
    } catch (error) {
      assert.equal(statusOf(error), 400);
      assert.equal((error as Error).message, CONTENT_SPEECH_KEY_INCLUDED_MESSAGE);
      assert.ok(!(error as Error).message.includes(KEY), "文言にキーを出さない");
      throw error;
    }
  }, "キーを含むボイスを受け付けている");
  assert.equal(free.db.row, before, "拒否した要求で保存値を書き換えない");
  assert.ok(!JSON.stringify(free.service.settings()).includes(KEY), "GET にキーを出さない");

  // default はカタログ照合をしないため、モデルにもキーを保存できてしまう。同じ境界で 400 にする
  const defaulted = createService({ speechSource: "default", speechFetchedAt: null });
  defaulted.db.row = rowWith(null, null);
  await defaulted.service.applyStored();
  await assert.rejects(async () => {
    await defaulted.service.putSpeechSelection({ model: KEY, voice: "" });
  }, "キーを含むモデルを受け付けている");
  assert.ok(!JSON.stringify(defaulted.service.settings()).includes(KEY));
});

test("マスカーがキーを知らない起動でも、キーを混ぜた音声の保存は 400 で拒否する", async () => {
  // pi: null の起動（bootstrap が identity masker を渡す経路）。マスカーだけに頼らず AAD で復号した値と比べる
  const free = createService({ identityMasker: true });
  free.db.row = rowWith(null, null);
  await free.service.applyStored();
  await assert.rejects(async () => {
    await free.service.putSpeechSelection({ model: "fish/audio", voice: KEY });
  });
  assert.ok(!JSON.stringify(free.service.settings()).includes(KEY), "GET にもキーを出さない");

  const defaulted = createService({ identityMasker: true, speechSource: "default", speechFetchedAt: null });
  defaulted.db.row = rowWith(null, null);
  await defaulted.service.applyStored();
  await assert.rejects(async () => {
    await defaulted.service.putSpeechSelection({ model: KEY, voice: "" });
  });
  assert.ok(!JSON.stringify(defaulted.service.settings()).includes(KEY));
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

/** お試し再生の成功結果。形式ごとの応答の違いだけをテストが見る */
function speechResult(speech: SpeechGenerationResult & { ok: true }): SpeechGenerationResult;
function speechResult(): SpeechGenerationResult;
function speechResult(
  speech: SpeechGenerationResult = {
    ok: true,
    speech: { audio: new Uint8Array([1, 2]).buffer, format: "mp3", contentType: "audio/mpeg" },
  },
): SpeechGenerationResult {
  return speech;
}

test("お試し再生は行なし 400 / 未注入 503 / DB 不通 503 で provider を呼ばない", async () => {
  // 行が無い（キー未登録）は課金前の 400
  const unset = createService({ generateSpeech: async () => speechResult() });
  assert.deepEqual(
    await unset.service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
    { status: 400, error: CONTENT_SETTINGS_UNCONFIGURED_MESSAGE },
  );
  assert.equal(unset.previewCalls.length, 0);

  // 生成器が未注入（ランタイムなしで起動）は runtime 不可と同じ 503
  const unavailable = createService();
  unavailable.db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr");
  assert.deepEqual(
    await unavailable.service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
    { status: 503, error: CONTENT_SPEECH_PREVIEW_RUNTIME_UNAVAILABLE_MESSAGE },
  );

  // DB を読めないときも provider は叩かない
  const failing = createService({ generateSpeech: async () => speechResult() });
  failing.db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr");
  failing.db.failRead = true;
  assert.deepEqual(
    await failing.service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
    { status: 503, error: CONTENT_SPEECH_PREVIEW_READ_FAILED_MESSAGE },
  );
  assert.equal(failing.previewCalls.length, 0);
});

test("お試し再生は有効 / 無効が OFF なら課金前に 400 で止め、生成器を呼ばない", async () => {
  const { db, service, previewCalls } = createService({ generateSpeech: async () => speechResult() });
  db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr", false);
  await service.applyStored();
  assert.deepEqual(await service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }), {
    status: 400,
    error: CONTENT_DISABLED_MESSAGE,
  });
  assert.deepEqual(previewCalls, [], "ツールと同じく OFF は課金も止める");
});

test("お試し再生は pcm を RIFF 付きの wav にし、指定した演技指示と速度を生成器へ渡す", async () => {
  const { db, service, previewCalls } = createService({
    generateSpeech: async () =>
      speechResult({
        ok: true,
        speech: {
          audio: new Uint8Array([1, 2, 3, 4]).buffer,
          format: "pcm",
          contentType: "audio/pcm",
          sampleRate: 24_000,
          channels: 1,
        },
      }),
  });
  db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr");
  await service.applyStored();
  const outcome = await service.previewSpeech({
    model: DEFAULT_SPEECH_MODEL,
    voice: "Zephyr",
    text: "こんにちは",
    instructions: "静かに読む",
    speed: 1.5,
  });
  assert.equal(outcome.status, 200);
  if (outcome.status !== 200) return;
  assert.equal(outcome.contentType, "audio/wav");
  assert.equal(outcome.audio.byteLength, 48, "RIFF ヘッダ 44 バイト + pcm の実データ");
  assert.deepEqual(previewCalls, [
    {
      provider: SPEECH_PROVIDER_ID,
      model: DEFAULT_SPEECH_MODEL,
      text: "こんにちは",
      voice: "Zephyr",
      instructions: "静かに読む",
      speed: 1.5,
      apiKey: KEY,
      signal: undefined,
    },
  ]);

  // 生成の失敗は分類コード付きの 502 へ写す
  const failing = createService({
    generateSpeech: async () => ({ ok: false, code: "rate_limited", message: "音声生成が混雑しています" }),
  });
  failing.db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr");
  await failing.service.applyStored();
  assert.deepEqual(
    await failing.service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Zephyr", text: "こんにちは" }),
    { status: 502, error: "音声生成が混雑しています", code: "rate_limited" },
  );
});

test("お試し再生はカタログの出どころに関係なく宣言がある声を照合し、未宣言の声を 400 で止める", async () => {
  // default（live に一度も成功していない）でも、同梱モデルの宣言は引く
  const defaulted = createService({
    generateSpeech: async () => speechResult(),
    speechSource: "default",
    speechFetchedAt: null,
  });
  defaulted.db.row = rowWith(DEFAULT_SPEECH_MODEL, "Zephyr");
  await defaulted.service.applyStored();
  assert.deepEqual(
    await defaulted.service.previewSpeech({ model: DEFAULT_SPEECH_MODEL, voice: "Ghost", text: "こんにちは" }),
    {
      status: 400,
      error: `${CONTENT_SPEECH_VOICE_NOT_SUPPORTED_MESSAGE}: Ghost`,
    },
  );
  assert.equal(defaulted.previewCalls.length, 0);
  // default ではカタログ外モデルの照合を免除する（保存と同じ規則）
  const free = await defaulted.service.previewSpeech({ model: "fish/audio", voice: "", text: "こんにちは" });
  assert.equal(free.status, 200);
});
