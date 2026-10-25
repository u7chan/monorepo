// 共有の除外名の設定 (server/src/shared-content-exclusions.ts) と、その HTTP 契約
// (GET / PUT / DELETE /api/settings/shared-content-exclusions)。検証・既定へ戻す・壊れた JSON の 503 と、
// 対象ディレクトリ自身の名前を落とす実効値の解決を固定する。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBffApp } from "../src/app";
import { AppDb } from "../src/app-db";
import { createSharedContentExclusions } from "../src/shared-content-exclusions";
import {
  DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES,
  SHARED_CONTENT_EXCLUDE_COUNT_ERROR,
  SHARED_CONTENT_EXCLUDE_INDEX_ERROR,
  SHARED_CONTENT_EXCLUDE_MAX_NAMES,
  SHARED_CONTENT_EXCLUDE_NAME_ERROR,
  effectiveSharedContentExcludeNames,
  normalizeSharedContentExcludeNames,
  validateSharedContentExcludeNames,
} from "../src/shared-content-rules";
import type { SharedContentExclusionsResponse } from "../src/schema";

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-shared-exclusions-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createStore() {
  const db = AppDb.open({ storeDir: null });
  return { db, settings: createSharedContentExclusions({ db }) };
}

test("既定はアーカイブと別で、成果物の名前 (dist / build / out) を含まない", () => {
  // 共有の対象は dist / build そのものになり得る。既定で落とすと共有できない
  for (const name of ["dist", "build", "out"]) {
    assert.equal(DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES.includes(name), false, name);
  }
  for (const name of [".git", "AGENTS.md", "README.md", ".env", ".env.local", ".env.production", ".npmrc"]) {
    assert.equal(DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES.includes(name), true, name);
  }
  // glob を持たないので `.env.*` は個別に列挙する
  assert.equal(
    DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES.some((name) => name.includes("*")),
    false,
  );
});

test("未設定のときは既定の一覧を実効値として返す", () => {
  const { db, settings } = createStore();
  assert.equal(settings.read(), undefined);
  assert.deepEqual(settings.effectiveNames(), [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
  const response = settings.response();
  assert.deepEqual(response.excludeNames, [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
  assert.deepEqual(response.defaultExcludeNames, [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
  assert.equal(response.overridden, false);
  assert.equal(response.maxNames, SHARED_CONTENT_EXCLUDE_MAX_NAMES);
  assert.equal(response.maxNameLength, 200);
  db.close();
});

test("保存は正規化して上書きし、明示空も上書きとして残る", () => {
  const { db, settings } = createStore();
  const saved = settings.save([" AGENTS.md ", "AGENTS.md", "", "README.md"]);
  assert.deepEqual(saved.excludeNames, ["AGENTS.md", "README.md"]);
  assert.equal(saved.overridden, true);
  assert.deepEqual(settings.read(), ["AGENTS.md", "README.md"]);
  // 空配列は「除外なし」として尊重する (既定へ戻さない)
  const empty = settings.save([]);
  assert.deepEqual(empty.excludeNames, []);
  assert.equal(empty.overridden, true);
  assert.deepEqual(settings.read(), []);
  db.close();
});

test("リセットは保存行を消して未設定へ戻す", () => {
  const { db, settings } = createStore();
  settings.save(["AGENTS.md"]);
  const reset = settings.reset();
  assert.equal(reset.overridden, false);
  assert.deepEqual(reset.excludeNames, [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
  assert.equal(settings.read(), undefined);
  db.close();
});

test("検証エラーは 400 になり、保存しない (index.html は公開に必要なので拒否)", () => {
  const { db, settings } = createStore();
  for (const bad of [["a/b"], ["."], [".."], ["a\\b"], ["a\u0000b"], ["x".repeat(201)]]) {
    assert.throws(
      () => settings.save(bad),
      (error) => (error as { statusCode?: number }).statusCode === 400,
      JSON.stringify(bad),
    );
  }
  // 名前は全階層一致なので、許可すると入れ子の index.html も落とせてしまう
  assert.throws(
    () => settings.save(["index.html"]),
    (error) => (error as Error).message === SHARED_CONTENT_EXCLUDE_INDEX_ERROR,
  );
  assert.throws(
    () => settings.save(Array.from({ length: SHARED_CONTENT_EXCLUDE_MAX_NAMES + 1 }, (_, index) => `n-${index}`)),
    (error) =>
      (error as { statusCode?: number }).statusCode === 400 &&
      (error as Error).message === SHARED_CONTENT_EXCLUDE_COUNT_ERROR,
  );
  // 1 件も保存されていない (未設定のまま)
  assert.equal(settings.read(), undefined);

  settings.save(["AGENTS.md"]);
  assert.throws(
    () => settings.save(["a/b"]),
    (error) => (error as Error).message === `${SHARED_CONTENT_EXCLUDE_NAME_ERROR}: a/b`,
  );
  // 失敗した保存で前の一覧を壊さない
  assert.deepEqual(settings.read(), ["AGENTS.md"]);
  db.close();
});

test("正規化と検証は純関数として同じ結果を返す", () => {
  assert.deepEqual(normalizeSharedContentExcludeNames([" .env ", ".env", ""]), [".env"]);
  assert.equal(validateSharedContentExcludeNames([".env"]), undefined);
  assert.equal(validateSharedContentExcludeNames(["index.html"]), SHARED_CONTENT_EXCLUDE_INDEX_ERROR);
  assert.equal(validateSharedContentExcludeNames(["a/b"]), `${SHARED_CONTENT_EXCLUDE_NAME_ERROR}: a/b`);
});

test("実効値は対象ディレクトリのベース名と一致する名前だけを落とす", () => {
  assert.deepEqual(effectiveSharedContentExcludeNames("projects/app/dist", ["dist", ".env", "AGENTS.md"]), [
    ".env",
    "AGENTS.md",
  ]);
  // 一致しなければそのまま
  assert.deepEqual(effectiveSharedContentExcludeNames("projects/app/site", ["dist"]), ["dist"]);
  // 対象のベース名は 1 階層だけを見る (パス指定は持たない)
  assert.deepEqual(effectiveSharedContentExcludeNames("projects/dist/site", ["dist"]), ["dist"]);
  assert.deepEqual(effectiveSharedContentExcludeNames("projects/app/site", []), []);
});

test("DB が使えないときは実効値だけ既定へ落とし、応答は 503 にする", () => {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-shared-exclusions-closed-"));
  try {
    const db = AppDb.open({ storeDir: dir });
    const settings = createSharedContentExclusions({ db });
    db.close();
    // プレビュー / 公開は空へ倒さない (設定した除外が黙って無効にならない)
    assert.deepEqual(settings.effectiveNames(), [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
    // 設定 API は失敗を隠さない
    assert.throws(
      () => settings.response(),
      (error) => (error as { statusCode?: number }).statusCode === 503,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("壊れた JSON の行があると設定 API は 503 になる", () => {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-shared-exclusions-broken-"));
  try {
    const db = AppDb.open({ storeDir: dir });
    // 保存経路では作れない壊れた行を直接入れる
    db.saveSharedContentExcludeNames(["AGENTS.md"]);
    db.close();
    const raw = new DatabaseSync(join(dir, "u7agent.db"));
    raw.prepare("UPDATE shared_content_settings SET excludeNames = ?").run("not json");
    raw.close();
    const reopened = AppDb.open({ storeDir: dir });
    const broken = createSharedContentExclusions({ db: reopened });
    assert.throws(
      () => broken.response(),
      (error) => (error as { statusCode?: number }).statusCode === 503,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ファイルを開き直しても保存した一覧が残る", async () => {
  await withStoreDir(async (dir) => {
    const first = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const saved = await jsonBody(
      first.app.request("/api/settings/shared-content-exclusions", jsonPut({ excludeNames: ["AGENTS.md"] })),
    );
    assert.deepEqual(saved.excludeNames, ["AGENTS.md"]);
    assert.equal(saved.overridden, true);
    await first.close();

    const second = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const loaded = await jsonBody(second.app.request("/api/settings/shared-content-exclusions"));
    assert.deepEqual(loaded.excludeNames, ["AGENTS.md"]);
    assert.equal(loaded.overridden, true);
    await second.close();
  });
});

test("GET / PUT / DELETE は同じ形を返し、PUT の形は zod で検証する", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    const initial: SharedContentExclusionsResponse = await jsonBody(
      bff.app.request("/api/settings/shared-content-exclusions"),
    );
    assert.deepEqual(initial.excludeNames, [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
    assert.equal(initial.overridden, false);

    const put = await bff.app.request(
      "/api/settings/shared-content-exclusions",
      jsonPut({ excludeNames: [" .env ", ".env", "AGENTS.md"] }),
    );
    assert.equal(put.status, 200);
    const saved: SharedContentExclusionsResponse = await jsonBody(put);
    assert.deepEqual(saved.excludeNames, [".env", "AGENTS.md"]);
    assert.equal(saved.overridden, true);

    // 明示空も上書き
    const empty: SharedContentExclusionsResponse = await jsonBody(
      bff.app.request("/api/settings/shared-content-exclusions", jsonPut({ excludeNames: [] })),
    );
    assert.deepEqual(empty.excludeNames, []);
    assert.equal(empty.overridden, true);

    // 不正名と index.html は 400 で、応答は画面がそのまま出せる理由
    const bad = await bff.app.request("/api/settings/shared-content-exclusions", jsonPut({ excludeNames: ["a/b"] }));
    assert.equal(bad.status, 400);
    assert.equal((await jsonBody(bad)).error, `${SHARED_CONTENT_EXCLUDE_NAME_ERROR}: a/b`);
    const index = await bff.app.request(
      "/api/settings/shared-content-exclusions",
      jsonPut({ excludeNames: ["index.html"] }),
    );
    assert.equal(index.status, 400);
    assert.equal((await jsonBody(index)).error, SHARED_CONTENT_EXCLUDE_INDEX_ERROR);

    // 形が違う本文は 400 (値の検証は store 側)
    assert.equal((await bff.app.request("/api/settings/shared-content-exclusions", jsonPut({}))).status, 400);
    assert.equal(
      (await bff.app.request("/api/settings/shared-content-exclusions", jsonPut({ excludeNames: "dist" }))).status,
      400,
    );

    const reset: SharedContentExclusionsResponse = await jsonBody(
      bff.app.request("/api/settings/shared-content-exclusions", { method: "DELETE" }),
    );
    assert.equal(reset.overridden, false);
    assert.deepEqual(reset.excludeNames, [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES]);
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
    ["/api/settings/shared-content-exclusions", undefined],
    ["/api/settings/shared-content-exclusions", jsonPut({ excludeNames: ["AGENTS.md"] })],
    ["/api/settings/shared-content-exclusions", { method: "DELETE" }],
  ];
  for (const [url, init] of cases) {
    const response = await bff.app.request(url, init);
    assert.equal(response.status, 503, `${init?.method ?? "GET"} ${url}`);
    assert.match((await jsonBody(response)).error, /アプリデータ/);
  }
  await bff.close();
});
