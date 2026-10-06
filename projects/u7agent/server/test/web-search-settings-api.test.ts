// Web 検索の設定 API（GET / PUT / DELETE /api/settings/web-search...）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { DatabaseSync } from "node:sqlite";
import { createBffApp } from "../src/app";
import { WEB_SEARCH_DISABLED_MESSAGE } from "../src/web-search-tool";
import { asPiBff, createStubPi } from "./stub-pi";

const SECRET = "tvly-secret-value-0123456789";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonRequest = (method: "PUT" | "DELETE", payload?: unknown): RequestInit =>
  payload === undefined
    ? { method }
    : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-web-search-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const defaultSettings = (tavilyConfigured = false) => ({
  enabled: true,
  provider: "exa",
  providers: [
    { id: "exa", name: "Exa", host: "mcp.exa.ai", keyless: true, configured: true },
    { id: "tavily", name: "Tavily", host: "api.tavily.com", keyless: false, configured: tavilyConfigured },
  ],
  disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
});

test("GET は既定（有効 / Exa）、PUT は適用されて再取得と再起動後も残る", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), defaultSettings());
      // 行が無い = 既定なので、起動直後の写しも有効 / Exa
      assert.equal(pi.webSearchConfigs.at(-1)?.readEnabled(), true);
      assert.equal(pi.webSearchConfigs.at(-1)?.readProvider(), "exa");

      const off = await jsonBody(
        await bff.app.request("/api/settings/web-search", jsonRequest("PUT", { enabled: false })),
      );
      assert.deepEqual(off, { ...defaultSettings(), enabled: false, state: "applied" });
      // 実行中のセッションが読む写しも、同じ注入面を通して OFF になる
      assert.equal(pi.webSearchConfigs.at(-1)?.readEnabled(), false);

      const tavily = await jsonBody(
        await bff.app.request("/api/settings/web-search/provider", jsonRequest("PUT", { provider: "tavily" })),
      );
      assert.equal(tavily.state, "applied");
      assert.equal(tavily.provider, "tavily");
      assert.equal(tavily.enabled, false, "provider の変更でトグルを戻さない");
      assert.equal(pi.webSearchConfigs.at(-1)?.readProvider(), "tavily");

      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), {
        ...defaultSettings(),
        enabled: false,
        provider: "tavily",
      });
    } finally {
      await bff.close();
    }

    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const row = check.prepare("SELECT id, enabled, provider FROM web_search_settings").get() as
      | { id: number; enabled: number; provider: string }
      | undefined;
    assert.deepEqual({ ...row }, { id: 1, enabled: 0, provider: "tavily" }, "1 行だけを持つ");
    check.close();

    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      assert.deepEqual(await jsonBody(await restarted.app.request("/api/settings/web-search")), {
        ...defaultSettings(),
        enabled: false,
        provider: "tavily",
      });
    } finally {
      await restarted.close();
    }
  });
});

test("キーの登録・削除は往復し、値は応答にもログにも出さない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/web-search/provider", jsonRequest("PUT", { provider: "tavily" }));
      const put = await jsonBody(
        await bff.app.request("/api/settings/web-search/providers/tavily/key", jsonRequest("PUT", { apiKey: SECRET })),
      );
      assert.equal(put.state, "applied");
      assert.equal(JSON.stringify(put).includes(SECRET), false, "応答にキー値を載せない");
      assert.equal(pi.retainedSecrets.includes(SECRET), true, "マスカーへ登録する");
      assert.equal(pi.webSearchConfigs.at(-1)?.readApiKey("tavily"), SECRET, "実行時の写しから読める");

      const settings = await jsonBody(await bff.app.request("/api/settings/web-search"));
      assert.equal(settings.providers[1].configured, true);
      assert.equal(JSON.stringify(settings).includes(SECRET), false);

      const deleted = await jsonBody(
        await bff.app.request("/api/settings/web-search/providers/tavily/key", jsonRequest("DELETE")),
      );
      assert.equal(deleted.state, "applied");
      assert.equal(deleted.providers[1].configured, false);
      assert.equal(pi.webSearchConfigs.at(-1)?.readApiKey("tavily"), undefined);
      // 未設定の削除も 200（冪等）
      const again = await bff.app.request("/api/settings/web-search/providers/tavily/key", jsonRequest("DELETE"));
      assert.equal(again.status, 200);
    } finally {
      await bff.close();
    }

    // 再起動後もキーは使える（DB の行として残る）
    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const settings = await jsonBody(await restarted.app.request("/api/settings/web-search"));
      assert.equal(settings.providers[1].configured, false, "削除後は未設定のまま");
    } finally {
      await restarted.close();
    }
  });
});

test("保存したキーは再起動後も読め、保護対象へ入る", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      await first.app.request("/api/settings/web-search/providers/tavily/key", jsonRequest("PUT", { apiKey: SECRET }));
    } finally {
      await first.close();
    }

    const pi = createStubPi();
    const second = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const settings = await jsonBody(await second.app.request("/api/settings/web-search"));
      assert.equal(settings.providers[1].configured, true);
      assert.equal(pi.retainedSecrets.includes(SECRET), true, "起動時に読んだキーも保護対象へ入る");
      assert.equal(pi.webSearchConfigs.at(-1)?.readApiKey("tavily"), SECRET);
    } finally {
      await second.close();
    }

    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const rows = check.prepare("SELECT provider, apiKey FROM web_search_provider_keys").all() as {
      provider: string;
      apiKey: string;
    }[];
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ provider: "tavily", apiKey: SECRET }],
    );
    check.close();
  });
});

test("本文が契約に合わなければ 400 で、何も保存しない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const invalid: [string, RequestInit][] = [
        ["/api/settings/web-search", jsonRequest("PUT", { enabled: "no" })],
        ["/api/settings/web-search", jsonRequest("PUT", {})],
        ["/api/settings/web-search/provider", jsonRequest("PUT", { provider: "brave" })],
        ["/api/settings/web-search/provider", jsonRequest("PUT", {})],
        ["/api/settings/web-search/providers/tavily/key", jsonRequest("PUT", { apiKey: "short" })],
        ["/api/settings/web-search/providers/tavily/key", jsonRequest("PUT", {})],
      ];
      for (const [path, init] of invalid) {
        assert.equal((await bff.app.request(path, init)).status, 400, path);
      }
      // キー不要 / 未知の provider へのキー操作は 400（zod は通ってもサービスが拒否する）
      const keyless = await bff.app.request(
        "/api/settings/web-search/providers/exa/key",
        jsonRequest("PUT", { apiKey: SECRET }),
      );
      assert.equal(keyless.status, 400);
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), defaultSettings());
    } finally {
      await bff.close();
    }
  });
});
