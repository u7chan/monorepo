// アーカイブ除外名の設定 (server/src/archive-settings.ts) と、その HTTP 契約 (GET / PUT / DELETE
// /api/settings/archive)、health と download / check が同じ実効値を使うことの整合を検証する。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { AppDb } from "../src/app-db";
import {
  ARCHIVE_EXCLUDE_COUNT_ERROR,
  ARCHIVE_EXCLUDE_MAX_NAMES,
  ARCHIVE_EXCLUDE_NAME_ERROR,
  DEFAULT_ARCHIVE_EXCLUDE_NAMES,
} from "../src/archive-rules";
import { createArchiveSettings } from "../src/archive-settings";
import type { ArchiveSettingsResponse } from "../src/schema";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-archive-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** download / check が受け取った除外名を記録するスタブ */
function recordingWorkspace() {
  const excludes: string[][] = [];
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    listFiles: async () => ({ path: ".", entries: [], truncated: false }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }) => ({ path: name, name, renamed: false, size: 0 }),
    rawFile: async () => ({ contentType: "image/png", body: null }),
    downloadEntry: async (_path: string, excludeNames: readonly string[]) => {
      excludes.push([...excludeNames]);
      return {
        contentType: "application/zip",
        contentDisposition: "attachment; filename*=UTF-8''src.zip",
        body: new Blob([new Uint8Array([0x50, 0x4b])]).stream(),
      };
    },
    checkDownload: async (_path: string, excludeNames: readonly string[]) => {
      excludes.push([...excludeNames]);
      return { kind: "archive", name: "src.zip", bytes: 0, entries: 0, skipped: [] };
    },
  };
  return { workspace, excludes };
}

function createStore() {
  const db = AppDb.open({ storeDir: null });
  return { db, settings: createArchiveSettings({ db }) };
}

test("未設定のときは既定の一覧を実効値として返す", () => {
  const { db, settings } = createStore();
  assert.equal(settings.read(), undefined);
  assert.deepEqual(settings.effectiveNames(), [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  const response = settings.response();
  assert.deepEqual(response.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  assert.deepEqual(response.defaultExcludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  assert.equal(response.overridden, false);
  assert.equal(response.maxNames, ARCHIVE_EXCLUDE_MAX_NAMES);
  assert.equal(response.maxNameLength, 200);
  db.close();
});

test("保存は正規化して上書きし、明示空も上書きとして残る", () => {
  const { db, settings } = createStore();
  const saved = settings.save([" dist ", "dist", "", "Node_Modules"]);
  assert.deepEqual(saved.excludeNames, ["dist", "Node_Modules"]);
  assert.equal(saved.overridden, true);
  assert.deepEqual(settings.read(), ["dist", "Node_Modules"]);
  // 空配列は「除外なし」として尊重する (既定へ戻さない)
  const empty = settings.save([]);
  assert.deepEqual(empty.excludeNames, []);
  assert.equal(empty.overridden, true);
  assert.deepEqual(settings.read(), []);
  db.close();
});

test("リセットは保存行を消して未設定へ戻す", () => {
  const { db, settings } = createStore();
  settings.save(["dist"]);
  const reset = settings.reset();
  assert.equal(reset.overridden, false);
  assert.deepEqual(reset.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  assert.equal(settings.read(), undefined);
  db.close();
});

test("検証エラーは 400 になり、保存しない", () => {
  const { db, settings } = createStore();
  for (const bad of [["a/b"], ["."], [".."], ["a\u0000b"], ["x".repeat(201)]]) {
    assert.throws(
      () => settings.save(bad),
      (error) => (error as { statusCode?: number }).statusCode === 400,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => settings.save(Array.from({ length: ARCHIVE_EXCLUDE_MAX_NAMES + 1 }, (_, index) => `n-${index}`)),
    (error) =>
      (error as { statusCode?: number }).statusCode === 400 && (error as Error).message === ARCHIVE_EXCLUDE_COUNT_ERROR,
  );
  // 1 件も保存されていない (未設定のまま)
  assert.equal(settings.read(), undefined);

  settings.save(["dist"]);
  assert.throws(
    () => settings.save(["a/b"]),
    (error) => (error as Error).message === `${ARCHIVE_EXCLUDE_NAME_ERROR}: a/b`,
  );
  // 失敗した保存で前の一覧を壊さない
  assert.deepEqual(settings.read(), ["dist"]);
  db.close();
});

test("DB が使えないときは実効値だけ既定へ落とし、応答は 503 にする", () => {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-archive-settings-closed-"));
  try {
    const db = AppDb.open({ storeDir: dir });
    const settings = createArchiveSettings({ db });
    db.close();
    // health は落とさない (用途は行の出し分け)。空へ倒すと除外なしの ZIP を作れてしまう
    assert.deepEqual(settings.effectiveNames(), [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
    // 設定 API は失敗を隠さない
    assert.throws(
      () => settings.response(),
      (error) => (error as { statusCode?: number }).statusCode === 503,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ファイルを開き直しても保存した一覧が残る", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const saved = await jsonBody(
      first.app.request("/api/settings/archive", jsonPut({ excludeNames: ["dist", "vendor"] })),
    );
    assert.deepEqual(saved.excludeNames, ["dist", "vendor"]);
    assert.equal(saved.overridden, true);
    await first.close();

    // 同じディレクトリを開き直す = 再起動
    const second = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const loaded = await jsonBody(second.app.request("/api/settings/archive"));
    assert.deepEqual(loaded.excludeNames, ["dist", "vendor"]);
    assert.equal(loaded.overridden, true);
    await second.close();
  });
});

test("GET / PUT / DELETE は同じ形を返し、PUT の形は zod で検証する", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const initial: ArchiveSettingsResponse = await jsonBody(bff.app.request("/api/settings/archive"));
    assert.deepEqual(initial.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
    assert.equal(initial.overridden, false);

    const put = await bff.app.request("/api/settings/archive", jsonPut({ excludeNames: [" .git ", ".git"] }));
    assert.equal(put.status, 200);
    const saved: ArchiveSettingsResponse = await jsonBody(put);
    assert.deepEqual(saved.excludeNames, [".git"]);
    assert.equal(saved.overridden, true);

    // 明示空も上書き
    const empty: ArchiveSettingsResponse = await jsonBody(
      bff.app.request("/api/settings/archive", jsonPut({ excludeNames: [] })),
    );
    assert.deepEqual(empty.excludeNames, []);
    assert.equal(empty.overridden, true);

    // 不正名は 400 で、応答は画面がそのまま出せる理由
    const bad = await bff.app.request("/api/settings/archive", jsonPut({ excludeNames: ["a/b"] }));
    assert.equal(bad.status, 400);
    assert.equal((await jsonBody(bad)).error, `${ARCHIVE_EXCLUDE_NAME_ERROR}: a/b`);

    // 形が違う本文は 400 (値の検証は store 側)
    assert.equal((await bff.app.request("/api/settings/archive", jsonPut({}))).status, 400);
    assert.equal((await bff.app.request("/api/settings/archive", jsonPut({ excludeNames: "dist" }))).status, 400);

    const reset: ArchiveSettingsResponse = await jsonBody(
      bff.app.request("/api/settings/archive", { method: "DELETE" }),
    );
    assert.equal(reset.overridden, false);
    assert.deepEqual(reset.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
    await bff.close();
  });
});

test("DB が使えないときの設定 API は 503 になる", async () => {
  const cwd = "/tmp/project";
  const previous = process.env.PI_SESSION_STORE;
  // ワークスペースの中を store に指定するとパス解決で失敗する (会話ストアと同じ扱い)
  process.env.PI_SESSION_STORE = join(cwd, "inside-workspace");
  const bff = await createBffApp({ cwd, pi: null, workspace: null });
  if (previous === undefined) delete process.env.PI_SESSION_STORE;
  else process.env.PI_SESSION_STORE = previous;

  const cases: [string, RequestInit | undefined][] = [
    ["/api/settings/archive", undefined],
    ["/api/settings/archive", jsonPut({ excludeNames: ["dist"] })],
    ["/api/settings/archive", { method: "DELETE" }],
  ];
  for (const [url, init] of cases) {
    const response = await bff.app.request(url, init);
    assert.equal(response.status, 503, `${init?.method ?? "GET"} ${url}`);
    assert.match((await jsonBody(response)).error, /アプリデータ/);
  }
  // health は落ちず、実効値は既定のまま
  const health = await jsonBody(bff.app.request("/api/health"));
  assert.equal(health.appDb.ok, false);
  assert.deepEqual(health.archive.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  await bff.close();
});

test("PUT の直後は health と download / check が同じ実効値を見る", async () => {
  await withStoreDir(async (dir) => {
    const { workspace, excludes } = recordingWorkspace();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace });

    const saved = await jsonBody(
      bff.app.request("/api/settings/archive", jsonPut({ excludeNames: ["dist", "vendor"] })),
    );
    const health = await jsonBody(bff.app.request("/api/health"));
    assert.deepEqual(health.archive.excludeNames, saved.excludeNames);

    await bff.app.request("/api/files/download?path=src");
    await bff.app.request("/api/files/download/check?path=src");
    assert.deepEqual(excludes, [
      ["dist", "vendor"],
      ["dist", "vendor"],
    ]);

    // 既定に戻すと 3 経路とも既定へ揃う
    await bff.app.request("/api/settings/archive", { method: "DELETE" });
    const resetHealth = await jsonBody(bff.app.request("/api/health"));
    assert.deepEqual(resetHealth.archive.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
    await bff.app.request("/api/files/download/check?path=src");
    assert.deepEqual(excludes[2], [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);

    // 明示空は「除外なし」として伝わる (空の param を 1 つ送る)
    await bff.app.request("/api/settings/archive", jsonPut({ excludeNames: [] }));
    const emptyHealth = await jsonBody(bff.app.request("/api/health"));
    assert.deepEqual(emptyHealth.archive.excludeNames, []);
    await bff.app.request("/api/files/download/check?path=src");
    assert.deepEqual(excludes[3], []);
    await bff.close();
  });
});
