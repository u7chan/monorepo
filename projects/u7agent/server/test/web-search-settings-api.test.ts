// Web 検索の実行時トグル API（GET / PUT /api/settings/web-search）。実 API は呼ばず stub pi とアプリ DB で検証する。
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

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-web-search-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET は既定で有効、PUT は適用されて再取得と再起動後も残る", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = await jsonBody(await bff.app.request("/api/settings/web-search"));
      assert.deepEqual(before, { enabled: true, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE });
      // 行が無い = 既定（有効）なので、起動直後の写しも有効
      assert.equal(pi.webSearchConfigs.at(-1)?.readEnabled(), true);

      const off = await jsonBody(await bff.app.request("/api/settings/web-search", jsonPut({ enabled: false })));
      assert.deepEqual(off, { enabled: false, disabledMessage: WEB_SEARCH_DISABLED_MESSAGE, state: "applied" });
      // 実行中のセッションが読む写しも、同じ注入面を通して OFF になる
      assert.equal(pi.webSearchConfigs.at(-1)?.readEnabled(), false);
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), {
        enabled: false,
        disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
      });

      const on = await jsonBody(await bff.app.request("/api/settings/web-search", jsonPut({ enabled: true })));
      assert.equal(on.state, "applied");
      assert.equal(on.enabled, true);
      assert.equal(pi.webSearchConfigs.at(-1)?.readEnabled(), true);
    } finally {
      await bff.close();
    }

    // 保存は行として残る（再起動 = 同じストアで開き直しても設定が生きる）
    const reopened = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const off = await jsonBody(await reopened.app.request("/api/settings/web-search", jsonPut({ enabled: false })));
      assert.equal(off.enabled, false);
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(join(dir, APP_DB_FILENAME));
    const row = check.prepare("SELECT id, enabled FROM web_search_settings").get() as
      | { id: number; enabled: number }
      | undefined;
    assert.deepEqual({ ...row }, { id: 1, enabled: 0 }, "1 行だけを持つ");
    check.close();

    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      assert.deepEqual(await jsonBody(await restarted.app.request("/api/settings/web-search")), {
        enabled: false,
        disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
      });
    } finally {
      await restarted.close();
    }
  });
});

test("本文が boolean でなければ 400 で、何も保存しない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const invalid = await bff.app.request("/api/settings/web-search", jsonPut({ enabled: "no" }));
      assert.equal(invalid.status, 400);
      const missing = await bff.app.request("/api/settings/web-search", jsonPut({}));
      assert.equal(missing.status, 400);
      // どちらも何も保存しない
      assert.deepEqual(await jsonBody(await bff.app.request("/api/settings/web-search")), {
        enabled: true,
        disabledMessage: WEB_SEARCH_DISABLED_MESSAGE,
      });
    } finally {
      await bff.close();
    }
  });
});
