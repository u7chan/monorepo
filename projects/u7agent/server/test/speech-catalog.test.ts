// live 音声カタログの取得・フォールバック・キャッシュ保存。実 API は呼ばず、fetch / store を差し替えて検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { SpeechCatalogRow } from "../src/app-db";
import { SPEECH_PROVIDER_ID } from "../src/speech";
import {
  createSpeechCatalog,
  DEFAULT_SPEECH_MODEL,
  SPEECH_CATALOG_ERROR_RATE_LIMITED,
  SPEECH_CATALOG_ERROR_TIMEOUT,
  SPEECH_CATALOG_ERROR_UNKNOWN,
  SPEECH_CATALOG_TIMEOUT_MS,
  SPEECH_CATALOG_URL,
  type SpeechCatalogEntry,
  type SpeechCatalogStore,
} from "../src/speech-catalog";

const LIVE = [
  { id: "google/gemini-3.8-flash-tts", name: "Google: Gemini 3.8 Flash TTS", supported_voices: ["Zephyr", "Kore"] },
  { id: "fish/audio", name: "Fish Audio", supported_voices: null },
];

const BUNDLED: SpeechCatalogEntry[] = [
  {
    provider: SPEECH_PROVIDER_ID,
    id: DEFAULT_SPEECH_MODEL,
    name: "Google: Gemini 3.8 Flash TTS",
    voices: ["Zephyr", "Kore"],
  },
];

class FakeCatalogStore implements SpeechCatalogStore {
  row: SpeechCatalogRow | undefined;
  failRead = false;
  failSave = false;
  saved: SpeechCatalogRow[] = [];

  readSpeechCatalog(): SpeechCatalogRow | undefined {
    if (this.failRead) throw new Error("store read boom");
    return this.row;
  }

  saveSpeechCatalog(row: SpeechCatalogRow): void {
    if (this.failSave) throw new Error("store save boom");
    this.saved.push(row);
    this.row = row;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function create(
  options: {
    fetch?: typeof fetch;
    store?: FakeCatalogStore;
    now?: () => number;
    timeoutMs?: number;
    defaultCatalog?: () => readonly SpeechCatalogEntry[];
  } = {},
) {
  const store = options.store ?? new FakeCatalogStore();
  const calls: { url: string; headers: Headers | undefined }[] = [];
  const baseFetch: typeof fetch =
    options.fetch ??
    (async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return jsonResponse({ data: LIVE });
    });
  const catalog = createSpeechCatalog({
    store,
    fetchImpl: baseFetch,
    now: options.now ?? (() => 1000),
    timeoutMs: options.timeoutMs ?? SPEECH_CATALOG_TIMEOUT_MS,
    defaultCatalog: options.defaultCatalog ?? (() => BUNDLED),
  });
  return { catalog, store, calls };
}

test("同梱の既定へ初期化し、既定の全 30 ボイスを宣言する", () => {
  const catalog = createSpeechCatalog({ store: new FakeCatalogStore() });
  const snapshot = catalog.snapshot();
  // 既定カタログは 1 件で、モデル id と話者を持つ（出所は docs/speech-generation.md）
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    [DEFAULT_SPEECH_MODEL],
  );
  assert.equal(snapshot.entries[0]?.name, "Google: Gemini 3.8 Flash TTS");
  assert.equal(snapshot.entries[0]?.voices?.length, 30);
  assert.equal(snapshot.entries[0]?.voices?.[0], "Zephyr");
  assert.equal(snapshot.entries[0]?.voices?.at(-1), "Sulafat");
  assert.equal(snapshot.source, "default");
  assert.equal(snapshot.fetchedAt, null);
  assert.deepEqual(catalog.voicesOf(DEFAULT_SPEECH_MODEL)?.length, 30);
});

test("live の取得は同梱より先に採用し、id と表示名と話者をキャッシュへ残す", async () => {
  const { catalog, store, calls } = create();
  assert.equal(catalog.snapshot().source, "default");

  assert.equal(await catalog.refresh(), null);
  assert.deepEqual(catalog.snapshot(), {
    entries: [
      {
        provider: SPEECH_PROVIDER_ID,
        id: "google/gemini-3.8-flash-tts",
        name: "Google: Gemini 3.8 Flash TTS",
        voices: ["Zephyr", "Kore"],
      },
      { provider: SPEECH_PROVIDER_ID, id: "fish/audio", name: "Fish Audio" },
    ],
    source: "live",
    fetchedAt: 1000,
  });
  assert.deepEqual(calls, [{ url: SPEECH_CATALOG_URL, headers: new Headers() }], "認証ヘッダは付けない");
  assert.equal(SPEECH_CATALOG_URL, "https://openrouter.ai/api/v1/models?output_modalities=speech");
  assert.deepEqual(store.saved, [
    {
      fetchedAt: 1000,
      models: [
        { id: "google/gemini-3.8-flash-tts", name: "Google: Gemini 3.8 Flash TTS", voices: ["Zephyr", "Kore"] },
        { id: "fish/audio", name: "Fish Audio" },
      ],
    },
  ]);
});

test("同じ id と話者は 1 件に畳み、表示名が無い / 文字列でないものは空文字にする", async () => {
  const { catalog } = create({
    fetch: async () =>
      jsonResponse({
        data: [
          { id: "a/one", name: "One", supported_voices: ["Zephyr", "Zephyr", "", 1] },
          { id: "a/one", name: "重複" },
          { id: "b/two", name: 2, supported_voices: "Zephyr" },
          { id: "c/three", name: "Three", supported_voices: [] },
        ],
      }),
  });
  assert.equal(await catalog.refresh(), null);
  assert.deepEqual(catalog.snapshot().entries, [
    { provider: SPEECH_PROVIDER_ID, id: "a/one", name: "One", voices: ["Zephyr"] },
    { provider: SPEECH_PROVIDER_ID, id: "b/two", name: "" },
    { provider: SPEECH_PROVIDER_ID, id: "c/three", name: "Three" },
  ]);
  assert.equal(catalog.voicesOf("b/two"), undefined, "形が違う宣言は不明として読む");
  assert.equal(catalog.voicesOf("ghost/model"), undefined, "カタログに無い id は不明");
});

test("キャッシュの読み書きはテーブルが image_catalog と同型でも voices を持つ", async () => {
  const store = new FakeCatalogStore();
  store.row = {
    fetchedAt: 500,
    models: [
      { id: "google/gemini-3.8-flash-tts", name: "Google: Gemini 3.8 Flash TTS", voices: ["Zephyr"] },
      { id: "fish/audio", name: "Fish Audio" },
    ],
  };
  const { catalog } = create({ store, fetch: async () => jsonResponse({ error: "boom" }, 503) });
  catalog.loadStored();
  assert.deepEqual(catalog.snapshot(), {
    entries: [
      {
        provider: SPEECH_PROVIDER_ID,
        id: "google/gemini-3.8-flash-tts",
        name: "Google: Gemini 3.8 Flash TTS",
        voices: ["Zephyr"],
      },
      { provider: SPEECH_PROVIDER_ID, id: "fish/audio", name: "Fish Audio" },
    ],
    source: "stored",
    fetchedAt: 500,
  });
  assert.equal(await catalog.refresh(), SPEECH_CATALOG_ERROR_RATE_LIMITED);
  assert.deepEqual(catalog.snapshot().source, "stored", "取得できなければ前回の一覧のままにする");
  assert.equal(catalog.snapshot().fetchedAt, 500);
});

test("失敗は固定文言へ分類し、一覧は前のまま保つ", async () => {
  const cases: { response: Response; error: string }[] = [
    { response: jsonResponse({ error: "boom" }, 429), error: SPEECH_CATALOG_ERROR_RATE_LIMITED },
    { response: jsonResponse({ error: "boom" }, 503), error: SPEECH_CATALOG_ERROR_RATE_LIMITED },
    { response: jsonResponse({ error: "not found" }, 404), error: SPEECH_CATALOG_ERROR_UNKNOWN },
    { response: new Response("<html>proxy</html>", { status: 200 }), error: SPEECH_CATALOG_ERROR_UNKNOWN },
    { response: jsonResponse({ data: [] }), error: SPEECH_CATALOG_ERROR_UNKNOWN },
    { response: jsonResponse({ nope: true }), error: SPEECH_CATALOG_ERROR_UNKNOWN },
  ];
  for (const { response, error } of cases) {
    const { catalog } = create({ fetch: async () => response });
    const before = catalog.snapshot();
    assert.equal(await catalog.refresh(), error, `status ${response.status} の分類`);
    assert.deepEqual(catalog.snapshot(), before, "失敗しても前の一覧を保つ");
  }
});

test("期限切れはタイムアウトとして分類する", async () => {
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const { catalog } = create({ fetch: hanging, timeoutMs: 5 });
  assert.equal(await catalog.refresh(), SPEECH_CATALOG_ERROR_TIMEOUT);
});

test("キャッシュが読めない / 保存できないときも、いま返している一覧を壊さない", async () => {
  const brokenRead = new FakeCatalogStore();
  brokenRead.failRead = true;
  const { catalog } = create({ store: brokenRead });
  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    catalog.loadStored();
    assert.deepEqual(catalog.snapshot(), { entries: BUNDLED, source: "default", fetchedAt: null });

    brokenRead.failSave = true;
    assert.equal(await catalog.refresh(), null, "保存の失敗は取得の失敗にしない");
    assert.equal(catalog.snapshot().source, "live");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(logged, [
    "[u7agent] speech catalog cache unavailable: store read boom",
    "[u7agent] speech catalog cache save failed",
  ]);
});
