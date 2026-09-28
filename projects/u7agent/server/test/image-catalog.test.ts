// live カタログの取得・フォールバック・キャッシュ保存。実 API は呼ばず、fetch / store を差し替えて検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ImageCatalogRow } from "../src/app-db";
import {
  createImageCatalog,
  IMAGE_CATALOG_ERROR_RATE_LIMITED,
  IMAGE_CATALOG_ERROR_TIMEOUT,
  IMAGE_CATALOG_ERROR_UNKNOWN,
  IMAGE_CATALOG_TIMEOUT_MS,
  IMAGE_CATALOG_URL,
  type ImageCatalogStore,
} from "../src/image-catalog";

const LIVE = [
  { id: "openai/gpt-image-2", name: "GPT Image 2" },
  { id: "recraft/recraft-v4.1-flash", name: "Recraft V4.1 Flash" },
];

const SDK = [
  { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
  { provider: "openrouter", id: "openrouter/auto", name: "Auto Router" },
];

class FakeCatalogStore implements ImageCatalogStore {
  row: ImageCatalogRow | undefined;
  failRead = false;
  failSave = false;
  saved: ImageCatalogRow[] = [];

  readImageCatalog(): ImageCatalogRow | undefined {
    if (this.failRead) throw new Error("store read boom");
    return this.row;
  }

  saveImageCatalog(row: ImageCatalogRow): void {
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
    sdkCatalog?: () => { provider: string; id: string; name: string }[];
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
  const catalog = createImageCatalog({
    store,
    fetchImpl: baseFetch,
    now: options.now ?? (() => 1000),
    timeoutMs: options.timeoutMs ?? IMAGE_CATALOG_TIMEOUT_MS,
    sdkCatalog: options.sdkCatalog ?? (() => SDK.filter((entry) => !entry.id.startsWith("openrouter/"))),
  });
  return { catalog, store, calls };
}

test("live の取得は SDK カタログより先に採用し、id と表示名だけをキャッシュへ残す", async () => {
  const { catalog, store, calls } = create();
  assert.deepEqual(catalog.snapshot(), { entries: SDK.slice(0, 1), source: "sdk", fetchedAt: null });

  assert.equal(await catalog.refresh(), null);
  assert.deepEqual(catalog.snapshot(), {
    entries: [
      { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
      { provider: "openrouter", id: "recraft/recraft-v4.1-flash", name: "Recraft V4.1 Flash" },
    ],
    source: "live",
    fetchedAt: 1000,
  });
  assert.deepEqual(calls, [{ url: IMAGE_CATALOG_URL, headers: new Headers() }], "認証ヘッダは付けない");
  assert.deepEqual(store.saved, [
    {
      fetchedAt: 1000,
      models: [
        { id: "openai/gpt-image-2", name: "GPT Image 2" },
        { id: "recraft/recraft-v4.1-flash", name: "Recraft V4.1 Flash" },
      ],
    },
  ]);
});

test("同じ id は 1 件に畳み、表示名が無い / 文字列でないものは空文字にする", async () => {
  const { catalog } = create({
    fetch: async () =>
      jsonResponse({
        data: [
          { id: "openai/gpt-image-2", name: "GPT Image 2" },
          { id: "openai/gpt-image-2", name: "重複" },
          { id: "x/y", name: 1 },
        ],
      }),
  });
  assert.equal(await catalog.refresh(), null);
  assert.deepEqual(catalog.snapshot().entries, [
    { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
    { provider: "openrouter", id: "x/y", name: "" },
  ]);
});

test("失敗は固定文言へ分類し、一覧は前のまま保つ", async () => {
  const cases: { response: Response; error: string }[] = [
    { response: jsonResponse({ error: "boom" }, 429), error: IMAGE_CATALOG_ERROR_RATE_LIMITED },
    { response: jsonResponse({ error: "boom" }, 500), error: IMAGE_CATALOG_ERROR_RATE_LIMITED },
    { response: jsonResponse({ error: "not found" }, 404), error: IMAGE_CATALOG_ERROR_UNKNOWN },
    { response: new Response("<html>proxy</html>", { status: 200 }), error: IMAGE_CATALOG_ERROR_UNKNOWN },
    { response: jsonResponse({ data: [] }), error: IMAGE_CATALOG_ERROR_UNKNOWN },
    { response: jsonResponse({ nope: true }), error: IMAGE_CATALOG_ERROR_UNKNOWN },
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
  assert.equal(await catalog.refresh(), IMAGE_CATALOG_ERROR_TIMEOUT);
});

test("キャッシュを読んでから live を試し、失敗したらキャッシュの一覧と取得時刻を保つ", async () => {
  const store = new FakeCatalogStore();
  store.row = { fetchedAt: 500, models: [{ id: "inclusionai/ming-image-0.1-design-layer", name: "Ming Image" }] };
  const failing = create({ store, fetch: async () => jsonResponse({ error: "boom" }, 503) });
  failing.catalog.loadStored();
  assert.deepEqual(failing.catalog.snapshot(), {
    entries: [{ provider: "openrouter", id: "inclusionai/ming-image-0.1-design-layer", name: "Ming Image" }],
    source: "stored",
    fetchedAt: 500,
  });
  assert.equal(await failing.catalog.refresh(), IMAGE_CATALOG_ERROR_RATE_LIMITED);
  assert.equal(failing.catalog.snapshot().source, "stored", "取得できなければ前回の一覧のままにする");
  assert.equal(failing.catalog.snapshot().fetchedAt, 500);
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
    assert.deepEqual(catalog.snapshot(), { entries: SDK.slice(0, 1), source: "sdk", fetchedAt: null });

    brokenRead.failSave = true;
    assert.equal(await catalog.refresh(), null, "保存の失敗は取得の失敗にしない");
    assert.equal(catalog.snapshot().source, "live");
  } finally {
    console.warn = original;
  }
  assert.deepEqual(logged, [
    "[u7agent] image catalog cache unavailable: store read boom",
    "[u7agent] image catalog cache save failed",
  ]);
});
