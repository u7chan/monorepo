// コストマスタ連携（URL の検証、SSRF 制約つきの取得、マージ・投影、保持）と設定 API の契約。
// 外部へは出ず、HTTP は注入した fetch とローカルのテストサーバーだけで検証する。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ContentCostCatalogRow, ContentCostSettingsRow } from "../src/app-db";
import {
  COST_CATALOG_ERROR_BLOCKED,
  COST_CATALOG_ERROR_CONTRACT,
  COST_CATALOG_ERROR_RATE_LIMITED,
  COST_CATALOG_ERROR_TIMEOUT,
  COST_CATALOG_ERROR_TOO_LARGE,
  CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE,
  CONTENT_COST_URL_INVALID_MESSAGE,
  CONTENT_COST_URL_REQUIRED_MESSAGE,
  allowCostMasterAddress,
  allowPrivateCostHost,
  costProjectionOf,
  costUrlError,
  createContentCostCatalog,
  isGlobalAddress,
  isPrivateNetworkAddress,
  requestCostMaster,
  type ContentCostStore,
} from "../src/content-cost";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { createBffApp } from "../src/app";
import { IMAGE_PROVIDER_ID } from "../src/images";
import { jsonBody, jsonPost, jsonPut } from "./http-helpers";
import { asPiBff, createStubPi } from "./stub-pi";

process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const KEY = "sk-cost-dummy-key-0123456789abcdef";
const COST_URL = "https://cost-master.example.com/api/models";
const OTHER_COST_URL = "https://other-cost-master.example.com/api/models";

class FakeCostStore implements ContentCostStore {
  settings: ContentCostSettingsRow | undefined;
  catalog: ContentCostCatalogRow | undefined;
  events: string[] = [];

  readContentCostSettings(): ContentCostSettingsRow | undefined {
    return this.settings;
  }

  saveContentCostSettings(settings: ContentCostSettingsRow): void {
    this.settings = settings;
    this.events.push("save");
  }

  deleteContentCostSettings(): boolean {
    const existed = this.settings !== undefined;
    this.settings = undefined;
    this.events.push("delete-settings");
    return existed;
  }

  readContentCostCatalog(): ContentCostCatalogRow | undefined {
    return this.catalog;
  }

  saveContentCostCatalog(row: ContentCostCatalogRow): void {
    this.catalog = row;
    this.events.push("save-catalog");
  }

  deleteContentCostCatalog(): void {
    this.catalog = undefined;
    this.events.push("delete-catalog");
  }
}

const jsonResponse = (body: unknown, status = 200): { status: number; text: string } => ({
  status,
  text: JSON.stringify(body),
});

function masterOf(models: unknown[], version = 3): unknown {
  return { version, fetchedAt: 1_794_600_000_000, models };
}

function priceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openrouter",
    modelId: "acme/image-a",
    billable: "output_image",
    unit: "image",
    variant: "",
    costUsd: 0.04,
    currency: "USD",
    enabled: true,
    note: null,
    ...overrides,
  };
}

test("URL は http / https のホスト名だけを受け付け、IP リテラルと認証情報を拒否する", () => {
  assert.equal(costUrlError("https://cost-master.example.com/api/models"), undefined);
  assert.equal(costUrlError("http://cost-master.example.com:3100/api/models"), undefined);
  for (const invalid of [
    "ftp://cost-master.example.com/api/models",
    "cost-master.example.com/api/models",
    "http://192.0.2.10/api/models",
    "http://[2001:db8::1]/api/models",
    "http://user:pass@cost-master.example.com/api/models",
  ]) {
    assert.equal(costUrlError(invalid), CONTENT_COST_URL_INVALID_MESSAGE, invalid);
  }
});

test("グローバルでないアドレス（loopback / private / link-local / ULA / CGNAT / documentation）を拒否する", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isGlobalAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isGlobalAddress(address), true, address);
  }
});

test("opt-in は LAN 内向けだけを許可し、loopback・link-local・ドキュメント用は許可しない", () => {
  for (const address of ["10.1.2.3", "172.20.0.1", "192.168.0.1", "100.64.0.1", "fd12:3456::1", "::ffff:192.168.1.9"]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
    assert.equal(allowCostMasterAddress(address, true), true, address);
    assert.equal(allowCostMasterAddress(address, false), false, `${address} は既定で拒否`);
  }
  for (const address of ["127.0.0.1", "169.254.169.254", "::1", "fe80::1", "192.0.2.10", "ff02::1"]) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
    assert.equal(allowCostMasterAddress(address, true), false, address);
  }
  // opt-in でもグローバルは従来どおり許可する
  assert.equal(allowCostMasterAddress("8.8.8.8", true), true);
  assert.equal(allowCostMasterAddress("8.8.8.8", false), true);
});

test("opt-in の env は未設定・未知の値を false へ倒す", () => {
  assert.equal(allowPrivateCostHost("1"), true);
  assert.equal(allowPrivateCostHost(" true "), true);
  for (const raw of [undefined, "", "0", "false", "yes", "on"]) {
    assert.equal(allowPrivateCostHost(raw), false, String(raw));
  }
});

test("opt-in のときだけ取得時の接続先検査を private 宛へ広げる", async () => {
  const seen: ((address: string) => boolean)[] = [];
  const run = async (allowPrivateHosts: boolean | undefined): Promise<void> => {
    const store = new FakeCostStore();
    const catalog = createContentCostCatalog({
      store,
      ...(allowPrivateHosts === undefined ? {} : { allowPrivateHosts }),
      fetchImpl: async (_url, options) => {
        if (options.allowAddress !== undefined) seen.push(options.allowAddress);
        return jsonResponse(masterOf([priceRow()]));
      },
    });
    catalog.loadStored();
    catalog.saveSettings({ enabled: true, url: COST_URL });
    assert.equal(await catalog.refresh(), null);
  };

  await run(true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!("172.17.0.5"), true, "Docker の private 宛を通す");
  assert.equal(seen[0]!("169.254.169.254"), false, "link-local は通さない");
  assert.equal(seen[0]!("127.0.0.1"), false, "loopback は通さない");

  // 既定（未指定）と false は従来どおり `isGlobalAddress` のまま差し替えない
  await run(undefined);
  await run(false);
  assert.equal(seen.length, 1);
});

test("許可した billable だけを残し、入力と出力を side で分け、重複は最大単価へ潰し、0 と不明を区別する", async () => {
  const store = new FakeCostStore();
  const catalog = createContentCostCatalog({
    store,
    now: () => 1_000,
    fetchImpl: async () =>
      jsonResponse(
        masterOf([
          priceRow({ variant: "", costUsd: 0.04, note: "汎用" }),
          priceRow({ variant: "", costUsd: 0.09 }),
          // 許可外の billable は表示に使わない
          priceRow({ billable: "input_image", costUsd: 0.001 }),
          // 音声は入力と出力の両方を持つ。同じ unit でも side が違えば別の行
          priceRow({ modelId: "acme/tts", billable: "input_text", unit: "character", costUsd: 0.00002 }),
          priceRow({ modelId: "acme/tts", billable: "output_audio", unit: "minute", costUsd: 0.15 }),
          priceRow({ modelId: "acme/tts-token", billable: "input_text", unit: "token", costUsd: 0.0000005 }),
          priceRow({ modelId: "acme/tts-token", billable: "output_audio", unit: "token", costUsd: 0.000009 }),
          // 未知の unit / 負の単価 / USD 以外 / 型違いは行ごと捨てる（0 にしない）
          priceRow({ unit: "second", variant: "x", costUsd: 0.5 }),
          priceRow({ variant: "negative", costUsd: -1 }),
          priceRow({ variant: "eur", currency: "EUR", costUsd: 0.5 }),
          priceRow({ variant: "string", costUsd: "0.5" }),
          priceRow({ modelId: "acme/image-b", costUsd: 0.25, enabled: false, note: "高価" }),
          priceRow({ modelId: "acme/image-c", costUsd: 0 }),
          priceRow({ modelId: "acme/image-d", unit: "megapixel", variant: "1024", costUsd: 0.02 }),
          priceRow({ modelId: "acme/image-d", unit: "megapixel", variant: "768", costUsd: 0.01 }),
          priceRow({ modelId: "acme/image-d", unit: "megapixel", variant: "768", costUsd: 0.015 }),
          // 別 provider は混ぜない
          priceRow({ provider: "other", modelId: "acme/image-e" }),
        ]),
      ),
  });
  catalog.loadStored();
  assert.equal(catalog.saveSettings({ enabled: true, url: COST_URL }).status, 200);
  assert.equal(await catalog.refresh(), null);

  const projection = catalog.projection();
  assert.deepEqual(projection.get("acme/image-a"), {
    prices: [{ unit: "image", side: "output", variant: "", costUsd: 0.09, currency: "USD" }],
    visible: true,
    note: "汎用",
  });
  assert.deepEqual(projection.get("acme/image-b"), {
    prices: [{ unit: "image", side: "output", variant: "", costUsd: 0.25, currency: "USD" }],
    visible: false,
    note: "高価",
  });
  assert.deepEqual(projection.get("acme/image-c")?.prices, [
    { unit: "image", side: "output", variant: "", costUsd: 0, currency: "USD" },
  ]);
  assert.deepEqual(projection.get("acme/image-d")?.prices, [
    { unit: "megapixel", side: "output", variant: "1024", costUsd: 0.02, currency: "USD" },
    { unit: "megapixel", side: "output", variant: "768", costUsd: 0.015, currency: "USD" },
  ]);
  assert.deepEqual(projection.get("acme/tts")?.prices, [
    { unit: "character", side: "input", variant: "", costUsd: 0.00002, currency: "USD" },
    { unit: "minute", side: "output", variant: "", costUsd: 0.15, currency: "USD" },
  ]);
  assert.deepEqual(projection.get("acme/tts-token")?.prices, [
    { unit: "token", side: "input", variant: "", costUsd: 0.0000005, currency: "USD" },
    { unit: "token", side: "output", variant: "", costUsd: 0.000009, currency: "USD" },
  ]);
  assert.equal(projection.has("acme/image-e"), false);
  assert.deepEqual(catalog.state(), { enabled: true, url: COST_URL, fetchedAt: 1_000, version: 3 });
});

test("取得の失敗は前回値を残し、URL の変更で前回値を破棄する", async () => {
  const store = new FakeCostStore();
  let mode: "ok" | "fail" = "ok";
  const catalog = createContentCostCatalog({
    store,
    now: () => 1_000,
    fetchImpl: async () => (mode === "ok" ? jsonResponse(masterOf([priceRow()])) : { status: 503, text: "" }),
  });
  catalog.loadStored();
  catalog.saveSettings({ enabled: true, url: COST_URL });
  assert.equal(await catalog.refresh(), null);
  const first = catalog.projection().get("acme/image-a");
  assert.ok(first && first.prices.length > 0);

  mode = "fail";
  assert.equal(await catalog.refresh(), COST_CATALOG_ERROR_RATE_LIMITED);
  assert.deepEqual(catalog.projection().get("acme/image-a"), first, "失敗で価格も visible も反転させない");
  assert.equal(catalog.state().fetchedAt, 1_000);

  // 契約外の応答も前回値を保つ
  const contract = createContentCostCatalog({
    store,
    fetchImpl: (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(masterOf([priceRow()])) : jsonResponse({ models: "not-an-array" });
      };
    })(),
  });
  contract.loadStored();
  assert.equal(await contract.refresh(), null);
  assert.ok(contract.projection().size > 0);
  assert.equal(await contract.refresh(), COST_CATALOG_ERROR_CONTRACT);
  assert.ok(contract.projection().size > 0, "契約外でも前回値を保つ");

  // URL を変えると別マスタの値を現在値として出さない
  catalog.saveSettings({ enabled: true, url: OTHER_COST_URL });
  assert.equal(catalog.projection().size, 0);
  assert.equal(catalog.state().fetchedAt, null);
  assert.equal(store.catalog, undefined, "保持していたスナップショットを消す");
});

test("OFF と未設定は取得せず、全件を表示の既定へ投影し、行なしの保存を受け付ける", async () => {
  const store = new FakeCostStore();
  let fetches = 0;
  const catalog = createContentCostCatalog({
    store,
    now: () => 1_000,
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse(masterOf([priceRow()]));
    },
  });
  catalog.loadStored();
  assert.equal(await catalog.refresh(), null, "未設定では取得しない");
  assert.equal(fetches, 0);
  assert.deepEqual(catalog.state(), { enabled: false, url: null, fetchedAt: null, version: null });
  assert.deepEqual(
    costProjectionOf(undefined, true),
    new Map(),
    "未設定は空の投影（呼び出し側が全件 visible: true / prices: [] にする）",
  );

  // 行が無くても設定できる。ON は URL 必須
  assert.deepEqual(catalog.saveSettings({ enabled: true, url: "" }), {
    status: 400,
    error: CONTENT_COST_URL_REQUIRED_MESSAGE,
  });
  assert.deepEqual(catalog.saveSettings({ enabled: false, url: "" }), { status: 200 });
  assert.equal(store.settings, undefined, "OFF + 空 URL は行の削除");

  // OFF は取得もしない。保持値は fetchedAt / version として返す
  catalog.saveSettings({ enabled: true, url: COST_URL });
  assert.equal(await catalog.refresh(), null);
  assert.equal(fetches, 1);
  catalog.saveSettings({ enabled: false, url: COST_URL });
  assert.equal(await catalog.refresh(), null);
  assert.equal(fetches, 1, "OFF では取得しない");
  assert.deepEqual(catalog.projection(), new Map(), "OFF は価格も表示可否も投影しない");
  assert.deepEqual(catalog.state(), { enabled: false, url: COST_URL, fetchedAt: 1_000, version: 3 });
});

test("保存の失敗は 503、契約外の応答は取得エラーとして前回値を残す", async () => {
  const store = new FakeCostStore();
  const failing = createContentCostCatalog({ store });
  failing.loadStored();
  Object.assign(store, {
    saveContentCostSettings: () => {
      throw new Error("db down");
    },
  });
  assert.deepEqual(failing.saveSettings({ enabled: true, url: COST_URL }), {
    status: 503,
    error: CONTENT_COST_SETTINGS_NOT_STORED_MESSAGE,
  });

  const contract = createContentCostCatalog({
    store: new FakeCostStore(),
    fetchImpl: async () => ({ status: 200, text: "<html>" }),
  });
  contract.loadStored();
  contract.saveSettings({ enabled: true, url: COST_URL });
  assert.equal(await contract.refresh(), COST_CATALOG_ERROR_CONTRACT);
  assert.equal(contract.projection().size, 0);
});

test("行数の上限を超えた応答は契約外として前回値を保つ", async () => {
  const store = new FakeCostStore();
  let calls = 0;
  const catalog = createContentCostCatalog({
    store,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(masterOf([priceRow()]))
        : jsonResponse(masterOf(Array.from({ length: 2_001 }, () => priceRow())));
    },
  });
  catalog.loadStored();
  catalog.saveSettings({ enabled: true, url: COST_URL });
  assert.equal(await catalog.refresh(), null);
  assert.equal(await catalog.refresh(), COST_CATALOG_ERROR_CONTRACT);
  assert.equal(catalog.projection().get("acme/image-a")?.prices.length, 1, "前回値を保つ");
});

test("接続先の検証は DNS の全 IP を見て、リダイレクトを追わず、本文と時間に上限を置く", async () => {
  const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
  assert.deepEqual(
    await requestCostMaster(new URL("http://cost-master.example.com/api/models"), {
      timeoutMs: 1_000,
      maxBytes: 1024,
      lookup: privateLookup,
    }),
    { error: COST_CATALOG_ERROR_BLOCKED },
  );

  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://192.0.2.10/api/models" });
      res.end();
      return;
    }
    if (req.url === "/large") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"models":[${"0".repeat(4_000)}]}`);
      return;
    }
    if (req.url === "/slow") return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ host: req.headers.host }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 }];
  const allowLoopback = (address: string): boolean => address === "127.0.0.1";
  const base = `http://cost-master.example.com:${port}`;
  try {
    const ok = await requestCostMaster(new URL(`${base}/api/models`), {
      timeoutMs: 1_000,
      maxBytes: 1024,
      lookup: loopbackLookup,
      allowAddress: allowLoopback,
    });
    assert.deepEqual(ok, { status: 200, text: JSON.stringify({ host: `cost-master.example.com:${port}` }) });

    const redirect = await requestCostMaster(new URL(`${base}/redirect`), {
      timeoutMs: 1_000,
      maxBytes: 1024,
      lookup: loopbackLookup,
      allowAddress: allowLoopback,
    });
    assert.deepEqual(redirect, { status: 302, text: "" }, "Location を追わない");

    const large = await requestCostMaster(new URL(`${base}/large`), {
      timeoutMs: 1_000,
      maxBytes: 1_024,
      lookup: loopbackLookup,
      allowAddress: allowLoopback,
    });
    assert.deepEqual(large, { error: COST_CATALOG_ERROR_TOO_LARGE });

    const slow = await requestCostMaster(new URL(`${base}/slow`), {
      timeoutMs: 50,
      maxBytes: 1_024,
      lookup: loopbackLookup,
      allowAddress: allowLoopback,
    });
    assert.deepEqual(slow, { error: COST_CATALOG_ERROR_TIMEOUT });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// --- 設定 API（統合 refresh と PUT /cost-url） ---

const liveImageCatalogFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      data: [
        { id: "acme/image-a", name: "Image A" },
        { id: "acme/image-b", name: "Image B" },
        { id: "acme/image-c", name: "Image C" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const liveSpeechCatalogFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ data: [{ id: "google/gemini-3.8-flash-tts", name: "TTS" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-content-cost-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("統合 refresh は価格と visible をマージし、無効なモデルでも保存と試行は通る", async () => {
  await withStoreDir(async (dir) => {
    let costFetches = 0;
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: liveImageCatalogFetch,
      speechCatalogFetch: liveSpeechCatalogFetch,
      contentCostFetch: async () => {
        costFetches += 1;
        return jsonResponse(
          masterOf([
            priceRow(),
            priceRow({ modelId: "acme/image-b", costUsd: 0.25, enabled: false, note: "高価" }),
            // 画像は入力側を表示しない
            priceRow({ modelId: "acme/image-a", billable: "input_text", unit: "character", costUsd: 0.00002 }),
            // 音声は入力と出力の両方を写す
            priceRow({
              modelId: "google/gemini-3.8-flash-tts",
              billable: "input_text",
              unit: "character",
              costUsd: 0.000015,
              note: "音声",
            }),
            priceRow({
              modelId: "google/gemini-3.8-flash-tts",
              billable: "output_audio",
              unit: "minute",
              costUsd: 0.15,
            }),
            // live に無いモデルは一覧へ足さない
            priceRow({ modelId: "acme/ghost" }),
          ]),
        );
      },
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));

      const saved = await jsonBody(
        await bff.app.request("/api/settings/content/cost-url", jsonPut({ enabled: true, url: COST_URL })),
      );
      assert.equal(saved.state, "applied");
      assert.deepEqual(saved.cost, { enabled: true, url: COST_URL, fetchedAt: null, version: null });
      assert.equal(costFetches, 0, "保存では取得しない");

      const refreshed = await jsonBody(
        await bff.app.request("/api/settings/content/catalog/refresh", { method: "POST" }),
      );
      assert.deepEqual(refreshed.errors, {});
      assert.equal(costFetches, 1);
      assert.deepEqual(refreshed.cost, {
        enabled: true,
        url: COST_URL,
        fetchedAt: Number(refreshed.cost.fetchedAt),
        version: 3,
      });
      assert.equal(typeof refreshed.cost.fetchedAt, "number");
      assert.deepEqual(
        refreshed.image.models.map((model: any) => [model.id, model.visible, model.prices]),
        [
          ["acme/image-a", true, [{ unit: "image", side: "output", variant: "", costUsd: 0.04, currency: "USD" }]],
          ["acme/image-b", false, [{ unit: "image", side: "output", variant: "", costUsd: 0.25, currency: "USD" }]],
          ["acme/image-c", true, []],
        ],
      );
      assert.equal(refreshed.image.models[1].note, "高価", "無効の理由を画面へ渡す");
      assert.ok(!refreshed.image.models.some((model: any) => model.id === "acme/ghost"), "一覧の正は live");
      assert.deepEqual(
        refreshed.speech.models.map((model: any) => [model.id, model.visible, model.note]),
        [["google/gemini-3.8-flash-tts", true, "音声"]],
      );
      assert.deepEqual(
        refreshed.speech.models[0].prices,
        [
          { unit: "character", side: "input", variant: "", costUsd: 0.000015, currency: "USD" },
          { unit: "minute", side: "output", variant: "", costUsd: 0.15, currency: "USD" },
        ],
        "音声は入力と出力の両方を返す",
      );

      // 変更系の応答（#applied）にも同じ価格が乗る
      const speechSaved = await jsonBody(
        await bff.app.request(
          "/api/settings/content/speech",
          jsonPut({ model: "google/gemini-3.8-flash-tts", voice: "Zephyr" }),
        ),
      );
      assert.equal(speechSaved.state, "applied");
      assert.deepEqual(speechSaved.speech.models[0].prices, refreshed.speech.models[0].prices);

      // visible: false は表示の投影だけで、保存の照合には影響しない
      const selected = await bff.app.request(
        "/api/settings/content/image",
        jsonPut({ provider: IMAGE_PROVIDER_ID, model: "acme/image-b", parameters: {} }),
      );
      assert.equal(selected.status, 200);

      // 試行の照合も現在の一覧をそのまま使う（無効でも開始できる）
      const trial = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: "openrouter/acme/image-b", prompt: "a cat" }),
      );
      assert.equal(trial.status, 202);

      // OFF は取得も表示もしない。サーバーが prices: [] / visible: true を投影する
      const off = await jsonBody(
        await bff.app.request("/api/settings/content/cost-url", jsonPut({ enabled: false, url: COST_URL })),
      );
      assert.equal(off.cost.enabled, false);
      assert.equal(typeof off.cost.fetchedAt, "number", "停止中でも前回取得を返す");
      assert.ok(off.image.models.every((model: any) => model.visible === true));
      assert.ok(off.image.models.every((model: any) => model.prices.length === 0));
      assert.ok(off.speech.models.every((model: any) => model.prices.length === 0));
      assert.ok(off.speech.models.every((model: any) => model.visible === true));

      const refreshedOff = await jsonBody(
        await bff.app.request("/api/settings/content/catalog/refresh", { method: "POST" }),
      );
      assert.deepEqual(refreshedOff.errors, {});
      assert.equal(costFetches, 1, "OFF では master へ出ない");
    } finally {
      await bff.close();
    }
  });
});

test("cost-url の検証は ON の URL 必須と接続先の形を見て、失敗した取得は前回値を保つ", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: liveImageCatalogFetch,
      speechCatalogFetch: liveSpeechCatalogFetch,
      contentCostFetch: async () => ({
        status: 500,
        text: "",
      }),
    });
    try {
      const required = await bff.app.request("/api/settings/content/cost-url", jsonPut({ enabled: true, url: "" }));
      assert.equal(required.status, 400);
      assert.equal((await jsonBody(required)).error, CONTENT_COST_URL_REQUIRED_MESSAGE);

      const invalid = await bff.app.request(
        "/api/settings/content/cost-url",
        jsonPut({ enabled: true, url: "http://192.0.2.10/api/models" }),
      );
      assert.equal(invalid.status, 400);
      assert.equal((await jsonBody(invalid)).error, CONTENT_COST_URL_INVALID_MESSAGE);

      await bff.app.request("/api/settings/content/cost-url", jsonPut({ enabled: true, url: COST_URL }));
      const failed = await jsonBody(await bff.app.request("/api/settings/content/catalog/refresh", { method: "POST" }));
      assert.deepEqual(failed.errors, { cost: COST_CATALOG_ERROR_RATE_LIMITED });
      assert.ok(!JSON.stringify(failed.errors).includes(COST_URL), "失敗の文言に接続先を出さない");
      assert.equal(failed.cost.enabled, true);
      assert.equal(failed.cost.fetchedAt, null, "取得できていないので前回値は無い");
      assert.ok(failed.image.models.every((model: any) => model.prices.length === 0));
      assert.ok(failed.image.models.every((model: any) => model.visible === true));
    } finally {
      await bff.close();
    }
  });
});

test("URL が一致しない価格スナップショットは現在値として使わない", () => {
  const store = new FakeCostStore();
  store.settings = { enabled: true, url: COST_URL };
  store.catalog = {
    fetchedAt: 1,
    sourceUrl: OTHER_COST_URL,
    version: 1,
    models: [
      {
        modelId: "acme/image-a",
        unit: "image",
        side: "output",
        variant: "",
        costUsd: 0.04,
        currency: "USD",
        enabled: true,
        note: null,
      },
    ],
  };
  const catalog = createContentCostCatalog({ store });
  catalog.loadStored();
  assert.deepEqual(catalog.projection(), new Map());
  assert.deepEqual(catalog.state(), { enabled: true, url: COST_URL, fetchedAt: null, version: null });
});
