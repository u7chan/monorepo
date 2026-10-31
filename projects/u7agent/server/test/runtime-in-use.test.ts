// GET /api/runtime/in-use の契約。設定 → ランタイム の環境タブが 1 回で読む集約で、
// 状態の写像・空文字（指定なし）の null 正規化・カタログや資格情報を載せないこと・DB 不通の 503 を固定する。
// 実 API は呼ばず、stub pi とアプリ DB で検証する。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { CloudflareSettingsService } from "../src/cloudflare-settings";
import type { ContentSettingsService } from "../src/content-settings";
import { createRuntimeRoutes } from "../src/routes/runtime";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { DEFAULT_SPEECH_MODEL } from "../src/speech-catalog";
import type { TitleSummarySettingsService } from "../src/title-summary-settings";
import type { WebSearchSettingsService } from "../src/web-search-settings";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { asPiBff, createStubPi } from "./stub-pi";

// 検証対象の応答にキー・暗号文を載せないことを確かめるため、このファイルの BFF には master key を立てる
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const CONTENT_KEY = "sk-content-dummy-key-0123456789abcdef";
const CLOUDFLARE_TOKEN = "cloudflare-dummy-token-0123456789";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TITLE_MODEL = "stub/stub-model";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-runtime-in-use-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 実 API を叩かせないための live カタログ stub。この画面はカタログを取得しない */
const liveCatalogFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });

const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({ ...options, imageCatalogFetch: liveCatalogFetch });

/** 設定サービスを差し替えた最小の Hono。DB を持たずに写像だけを固定する */
function routeWithStubs(settings: {
  content?: Record<string, unknown>;
  webSearch?: Record<string, unknown>;
  title?: Record<string, unknown>;
  cloudflare?: Record<string, unknown>;
}) {
  const routes = createRuntimeRoutes({
    pi: null,
    runtimeDiagnostics: null,
    contentSettings: {
      settings: () => ({
        configured: false,
        provider: null,
        keyStored: false,
        keyAvailable: false,
        keyEvaluated: false,
        keyErrorMessage: null,
        enabled: true,
        disabledMessage: "停止中です",
        runtimeAvailable: false,
        image: { model: null, models: [], catalogSource: "sdk", fetchedAt: null },
        speech: { model: null, voice: "", models: [], catalogSource: "sdk", fetchedAt: null },
        bgm: { model: null, format: "mp3", expectedDurationSeconds: 30 },
        ...settings.content,
      }),
    } as unknown as ContentSettingsService,
    webSearchSettings: {
      settings: () => ({
        enabled: false,
        provider: "exa",
        providers: [
          {
            id: "exa",
            name: "Exa",
            host: "exa.ai",
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
            configured: true,
            keyStored: true,
            keyAvailable: true,
            keyEvaluated: true,
            keyErrorMessage: null,
          },
        ],
        disabledMessage: "停止中です",
        ...settings.webSearch,
      }),
    } as unknown as WebSearchSettingsService,
    titleSummarySettings: {
      settings: () => ({
        enabled: false,
        model: null,
        thinkingLevel: null,
        effectiveThinkingLevel: null,
        definition: "定義",
        defaultDefinition: "定義",
        models: [],
        modelAvailable: true,
        ...settings.title,
      }),
    } as unknown as TitleSummarySettingsService,
    cloudflareSettings: {
      status: () => ({
        configured: false,
        accountId: null,
        available: false,
        unavailableReason: "master key がありません",
        ...settings.cloudflare,
      }),
    } as unknown as CloudflareSettingsService,
  });
  return new Hono().get("/api/runtime/in-use", routes.inUse);
}

test("未設定の状態を写像し、音声の空文字は null へ正規化する", async () => {
  const response = await routeWithStubs({}).request("/api/runtime/in-use");
  assert.equal(response.status, 200);
  const body = await jsonBody(response);

  assert.deepEqual(body, {
    title: {
      enabled: false,
      model: null,
      thinkingLevel: null,
      effectiveThinkingLevel: null,
      modelAvailable: true,
    },
    content: {
      configured: false,
      enabled: true,
      keyAvailable: false,
      imageModel: null,
      speechModel: null,
      // 「指定なし」を値として返さない
      speechVoice: null,
      bgmModel: null,
    },
    webSearch: { enabled: false, provider: "exa", host: "exa.ai" },
    // availableReason は返さない（画面は available だけで分岐する）
    cloudflare: { configured: false, available: false, accountId: null },
  });
});

test("設定値を写像し、カタログを応答へ含めない", async () => {
  const response = await routeWithStubs({
    content: {
      configured: true,
      enabled: false,
      keyAvailable: true,
      image: { model: "openai/gpt-image-2", models: [{ id: "leaked/model" }], catalogSource: "live", fetchedAt: 1 },
      speech: { model: DEFAULT_SPEECH_MODEL, voice: "Kore", models: [{ id: "leaked/speech" }] },
      bgm: { model: "google/lyria-3-clip-preview", format: "mp3", expectedDurationSeconds: 30 },
    },
    webSearch: { enabled: true, provider: "tavily" },
    title: {
      enabled: true,
      model: TITLE_MODEL,
      thinkingLevel: "low",
      effectiveThinkingLevel: "high",
      modelAvailable: false,
    },
    cloudflare: { configured: true, available: true, accountId: ACCOUNT_ID },
  }).request("/api/runtime/in-use");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("leaked"), false, "モデル一覧 (カタログ) を載せない");
  assert.deepEqual(JSON.parse(text), {
    title: {
      enabled: true,
      model: TITLE_MODEL,
      thinkingLevel: "low",
      effectiveThinkingLevel: "high",
      modelAvailable: false,
    },
    content: {
      configured: true,
      enabled: false,
      keyAvailable: true,
      imageModel: "openai/gpt-image-2",
      speechModel: DEFAULT_SPEECH_MODEL,
      speechVoice: "Kore",
      bgmModel: "google/lyria-3-clip-preview",
    },
    // provider の一覧は返さず、既定 provider の host だけを返す
    webSearch: { enabled: true, provider: "tavily", host: "api.tavily.com" },
    cloudflare: { configured: true, available: true, accountId: ACCOUNT_ID },
  });
});

test("保存済みの設定を 1 回で返し、APIキー・トークン・暗号文を載せない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const put = async (path: string, payload: unknown) => {
        const response = await bff.app.request(path, jsonPut(payload));
        assert.equal(response.status, 200, `${path} の保存`);
        return jsonBody(response);
      };
      await put("/api/settings/content/key", { apiKey: CONTENT_KEY });
      await put("/api/settings/web-search", { enabled: true });
      await put("/api/settings/web-search/provider", { provider: "tavily" });
      await put("/api/settings/web-search/providers/tavily/key", { apiKey: CONTENT_KEY });
      await put("/api/settings/session-title", {
        enabled: true,
        model: TITLE_MODEL,
        thinkingLevel: "low",
      });
      await put("/api/settings/cloudflare", { accountId: ACCOUNT_ID, apiToken: CLOUDFLARE_TOKEN });

      const response = await bff.app.request("/api/runtime/in-use");
      assert.equal(response.status, 200);
      const text = await response.text();
      const body = JSON.parse(text);

      assert.equal(body.title.enabled, true);
      assert.equal(body.title.model, TITLE_MODEL);
      assert.equal(body.title.thinkingLevel, "low");
      assert.equal(body.title.effectiveThinkingLevel, "low");
      assert.equal(body.title.modelAvailable, true);

      assert.equal(body.content.configured, true, "キー登録で行ができる");
      assert.equal(body.content.enabled, true);
      assert.equal(body.content.keyAvailable, true);
      assert.ok(body.content.imageModel, "既定の画像モデルが入る");
      assert.equal(body.content.speechModel, DEFAULT_SPEECH_MODEL, "音声の既定モデルへ寄せる");
      assert.ok(body.content.speechVoice, "宣言のあるモデルは先頭のボイスへ寄せる");
      assert.ok(body.content.bgmModel);

      assert.equal(body.webSearch.enabled, true);
      assert.equal(body.webSearch.provider, "tavily");
      assert.ok(body.webSearch.host, "既定 provider の host を返す");
      assert.equal(body.cloudflare.configured, true);
      assert.equal(body.cloudflare.available, true);
      assert.equal(body.cloudflare.accountId, ACCOUNT_ID);

      for (const secret of [CONTENT_KEY, CLOUDFLARE_TOKEN, TEST_MASTER_KEY]) {
        assert.equal(text.includes(secret), false, "資格情報を応答へ載せない");
      }
      assert.equal(text.includes("models"), false, "カタログを応答へ載せない");
    } finally {
      await bff.close();
    }
  });
});

test("コンテンツ生成の停止は 3 つの生成物で 1 つのゲートになる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const key = await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: CONTENT_KEY }));
      assert.equal(key.status, 200);
      const stopped = await bff.app.request("/api/settings/content", jsonPut({ enabled: false }));
      assert.equal(stopped.status, 200);

      const body = await jsonBody(await bff.app.request("/api/runtime/in-use"));
      assert.equal(body.content.configured, true);
      assert.equal(body.content.enabled, false);
      // 停止中でも選択済みのモデルは消さない (画面は行を残して理由を出す)
      assert.ok(body.content.imageModel);
    } finally {
      await bff.close();
    }
  });
});

test("アプリ DB を読めないときは 503 に揃える", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    bff.appDb.close();
    const response = await bff.app.request("/api/runtime/in-use");
    assert.equal(response.status, 503);
    assert.match((await jsonBody(response)).error, /アプリデータ/);
    await bff.close();
  });
});
