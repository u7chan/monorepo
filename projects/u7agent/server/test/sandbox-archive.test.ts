// GET /v1/files/download と /v1/files/download/check。実ファイルシステムを使い、listen せず app.request() で検証する。
// zip の検証は test/zip-reader.ts の自前パーサ（unzip はホストにも CI にも無い）。

import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createSandboxService, type SandboxServiceOptions } from "../src/sandbox/service";
import type { SandboxDownloadCheck } from "../src/sandbox/protocol";
import { parseZip, type ParsedZipEntry } from "./zip-reader";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-archive-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-archive-${prefix}-`));
}

/** 既定の上限つきで起動する。上限を試すテストだけ options を差し替える */
function createService(root: string, options: Partial<SandboxServiceOptions> = {}) {
  return createSandboxService({ token: TOKEN, rootCwd: root, ...options });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function download(
  app: App,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const response = await app.request(`/v1/files/download?path=${encodeURIComponent(path)}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}

async function check(
  app: App,
  path: string,
): Promise<{ status: number; body: SandboxDownloadCheck | { error: string } }> {
  const response = await app.request(`/v1/files/download/check?path=${encodeURIComponent(path)}`, {
    headers: authHeaders(),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function entryNames(entries: ParsedZipEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

test("ディレクトリはストリーミング zip になり、除外名 / symlink は入らない", async () => {
  const root = makeRoot("dir");
  const service = createService(root);
  try {
    await mkdir(join(root, "src", "empty"), { recursive: true });
    await mkdir(join(root, "src", "nested", "node_modules"), { recursive: true });
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "日本語 名前.txt"), "こんにちは\n");
    await writeFile(join(root, "src", "nested", "node_modules", "x.js"), "module.exports = {};\n");
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "x");
    await writeFile(join(root, "dist", "bundle.js"), "y");

    const result = await download(service.app, "src");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Type"), "application/zip");
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.equal(result.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(result.headers.get("Content-Length"), null, "zip に Content-Length を付けている");
    assert.equal(result.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''src.zip");

    const entries = parseZip(result.body);
    assert.deepEqual(entryNames(entries), ["empty/", "nested/", "main.ts", "日本語 名前.txt"]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("main.ts")?.data.toString("utf8"), "export const a = 1;\n");
    assert.equal(byName.get("日本語 名前.txt")?.data.toString("utf8"), "こんにちは\n");
    assert.equal(byName.get("empty/")?.size, 0);
    // 全エントリが読める zip（CRC / サイズ / data descriptor が本文と一致する）
    for (const entry of entries) assert.ok(entry.crcMatches && entry.descriptorMatches, entry.name);
  } finally {
    service.close();
  }
});

test("ZIP のエントリは元ファイルの更新時刻を持つ（ダウンロード時刻にしない）", async () => {
  const root = makeRoot("mtime");
  const service = createService(root);
  try {
    await mkdir(join(root, "src"));
    const source = join(root, "src", "old.txt");
    await writeFile(source, "old");
    // DOS 時刻はローカル時刻で 2 秒粒度。秒は偶数にして丸めなしで一致させる
    const mtime = new Date(2001, 1, 3, 4, 5, 6);
    await utimes(source, mtime, mtime);

    const result = await download(service.app, "src");
    assert.equal(result.status, 200);
    const entry = parseZip(result.body).find((candidate) => candidate.name === "old.txt");
    assert.ok(entry, "old.txt のエントリが無い");
    assert.equal(entry.mtime.getTime(), mtime.getTime(), "エントリの更新時刻が元ファイルと違う");
  } finally {
    service.close();
  }
});

test("除外は全階層で効き、check の skipped に実効の名前が返る", async () => {
  const root = makeRoot("exclude");
  const service = createService(root);
  try {
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "app", "dist"), { recursive: true });
    await mkdir(join(root, "app", ".git"), { recursive: true });
    await writeFile(join(root, "app", "index.js"), "1");
    await writeFile(join(root, "app", "node_modules", "dep", "a.js"), "2");
    await writeFile(join(root, "app", "dist", "b.js"), "3");
    await writeFile(join(root, "app", ".git", "HEAD"), "4");

    const result = await download(service.app, "app");
    assert.equal(result.status, 200);
    assert.deepEqual(entryNames(parseZip(result.body)), ["index.js"]);

    // skipped は規則の順で重複しない
    const checked = await check(service.app, "app");
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body, {
      kind: "archive",
      name: "app.zip",
      bytes: 1,
      entries: 1,
      skipped: ["node_modules", ".git", "dist"],
    });
  } finally {
    service.close();
  }
});

test("除外名のディレクトリそのものは 400 で断る", async () => {
  const root = makeRoot("excluded-target");
  const service = createService(root);
  try {
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "a.js"), "1");

    const result = await download(service.app, "node_modules");
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body.toString("utf8")), {
      error: "Directory is excluded from archives: node_modules",
    });
    const checked = await check(service.app, "node_modules");
    assert.equal(checked.status, 400);
    assert.deepEqual(checked.body, { error: "Directory is excluded from archives: node_modules" });
  } finally {
    service.close();
  }
});

test("空ディレクトリは配下ならエントリとして残り、空のディレクトリ自体は空の zip になる", async () => {
  const root = makeRoot("empty-dir");
  const service = createService(root);
  try {
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "parent", "empty"), { recursive: true });
    await writeFile(join(root, "parent", "a.txt"), "a");

    // 配下の空ディレクトリは展開後に残す（入れないと消える）
    const nested = await download(service.app, "parent");
    assert.equal(nested.status, 200);
    assert.deepEqual(entryNames(parseZip(nested.body)), ["empty/", "a.txt"]);

    // 対象そのものが空なら中身が無いので zip も空になる（フォルダ名は zip の名前が担う）
    const result = await download(service.app, "empty");
    assert.equal(result.status, 200);
    assert.deepEqual(entryNames(parseZip(result.body)), []);

    const checked = await check(service.app, "empty");
    assert.deepEqual(checked.body, { kind: "archive", name: "empty.zip", bytes: 0, entries: 0, skipped: [] });
  } finally {
    service.close();
  }
});

test("symlink は辿らず、要求もエントリも 400 / 除外になる", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = makeRoot("symlink");
  const outside = makeRoot("outside");
  const service = createService(root);
  try {
    await writeFile(join(outside, "secret.txt"), "secret");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "real.txt"), "real");
    symlinkSync(join(outside, "secret.txt"), join(root, "link-file.txt"));
    symlinkSync(outside, join(root, "link-dir"));

    // 要求そのものが symlink なら 400（辿った先を配らない）
    const linked = await download(service.app, "link-dir");
    assert.equal(linked.status, 400);
    assert.match(JSON.parse(linked.body.toString("utf8")).error, /Symbolic links cannot be downloaded/);
    assert.equal((await check(service.app, "link-dir")).status, 400);

    // 配下の symlink はエラーにせず、エントリにも入れない
    await mkdir(join(root, "src", "nested"));
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "nested", "secret-link.txt"));
    const result = await download(service.app, "src");
    assert.equal(result.status, 200);
    assert.deepEqual(entryNames(parseZip(result.body)), ["nested/", "real.txt"]);
    const checked = await check(service.app, "src");
    assert.deepEqual((checked.body as SandboxDownloadCheck).skipped, []);
  } finally {
    service.close();
  }
});

test("通常ファイルは生配信になり、名前と長さをヘッダで返す", async () => {
  const root = makeRoot("file");
  const service = createService(root);
  try {
    await writeFile(join(root, "report 日本語.md"), "# 見出し\n");
    const result = await download(service.app, "report 日本語.md");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(result.headers.get("Content-Length"), String(Buffer.byteLength("# 見出し\n")));
    assert.equal(
      result.headers.get("Content-Disposition"),
      "attachment; filename*=UTF-8''report%20%E6%97%A5%E6%9C%AC%E8%AA%9E.md",
    );
    assert.equal(result.body.toString("utf8"), "# 見出し\n");

    const checked = await check(service.app, "report 日本語.md");
    assert.deepEqual(checked.body, {
      kind: "file",
      name: "report 日本語.md",
      bytes: result.body.length,
      entries: 0,
      skipped: [],
    });
  } finally {
    service.close();
  }
});

test("ワークスペース root は直下の内容をルートに置く zip になる", async () => {
  const root = makeRoot("root");
  const service = createService(root);
  try {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "top.txt"), "top");
    await writeFile(join(root, "sub", "inner.txt"), "inner");
    await mkdir(join(root, "node_modules"));

    for (const requested of ["", ".", "/"]) {
      const result = await download(service.app, requested);
      assert.equal(result.status, 200, requested);
      assert.equal(
        result.headers.get("Content-Disposition"),
        `attachment; filename*=UTF-8''${encodeURIComponent(`${basename(root)}.zip`)}`,
        requested,
      );
      // フォルダ自身は前置されない（直下の内容が zip のルート）
      assert.deepEqual(entryNames(parseZip(result.body)), ["sub/", "sub/inner.txt", "top.txt"], requested);
    }

    const checked = await check(service.app, "");
    assert.deepEqual(checked.body, {
      kind: "archive",
      name: `${basename(root)}.zip`,
      bytes: 8,
      entries: 3,
      skipped: ["node_modules"],
    });
  } finally {
    service.close();
  }
});

test("末尾スラッシュ付きのディレクトリも同じ対象を指す", async () => {
  const root = makeRoot("trailing");
  const service = createService(root);
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "a");
    const result = await download(service.app, "src/");
    assert.equal(result.status, 200);
    assert.deepEqual(entryNames(parseZip(result.body)), ["a.txt"]);
  } finally {
    service.close();
  }
});

test("不存在は 404、root 外は 400、特殊なパスも 404 / 400", async () => {
  const root = makeRoot("missing");
  const service = createService(root);
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "file.txt"), "file");
    assert.equal((await download(service.app, "nope")).status, 404);
    assert.equal((await check(service.app, "nope")).status, 404);
    assert.equal((await download(service.app, "src/nope/deep")).status, 404);
    assert.equal((await download(service.app, "../outside")).status, 400);
    assert.equal((await download(service.app, "/etc")).status, 400);
    assert.equal((await check(service.app, "../outside")).status, 400);
    // 親がディレクトリでない要求は「ディレクトリでない」
    assert.equal((await download(service.app, "file.txt/child")).status, 400);
    // 最終要素の親参照は root の外を指し得るので受け付けない
    for (const requested of ["..", "sub/..", "sub/../."]) {
      assert.equal((await download(service.app, requested)).status, 400, requested);
      assert.equal((await check(service.app, requested)).status, 400, requested);
    }
  } finally {
    service.close();
  }
});

test("合計サイズ / 件数の上限はヘッダ送出前に 413 になる", async () => {
  const root = makeRoot("limits");
  const service = createService(root, { maxArchiveBytes: 10, maxArchiveEntries: 2 });
  try {
    await mkdir(join(root, "big"));
    await writeFile(join(root, "big", "a.txt"), "0123456789"); // 10 バイトは通る
    await writeFile(join(root, "big", "b.txt"), "x"); // 合計 11 バイトで超過

    const tooLarge = await download(service.app, "big");
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(JSON.parse(tooLarge.body.toString("utf8")), { error: "Download is too large (max 10 bytes)" });
    assert.equal((await check(service.app, "big")).status, 413);

    // 単体ファイルも同じ文言で拒否する
    const single = await download(service.app, "big/b.txt");
    assert.equal(single.status, 200, "上限内の単体ファイルは配れる");
    const singleTooLarge = await check(service.app, "big/a.txt");
    assert.deepEqual(singleTooLarge.body, { kind: "file", name: "a.txt", bytes: 10, entries: 0, skipped: [] });

    // エントリ数の上限（ディレクトリ 1 + ファイル 1 = 2 は通るが、3 つ目で超過）
    await mkdir(join(root, "many"));
    for (const name of ["a", "b", "c"]) await writeFile(join(root, "many", `${name}.txt`), "");
    const tooMany = await download(service.app, "many");
    assert.equal(tooMany.status, 413);
    assert.deepEqual(JSON.parse(tooMany.body.toString("utf8")), { error: "Download has too many entries (max 2)" });
    assert.equal((await check(service.app, "many")).status, 413);
  } finally {
    service.close();
  }
});

test("単体ファイルの上限超過も 413 で断る", async () => {
  const root = makeRoot("single-limit");
  const service = createService(root, { maxArchiveBytes: 3 });
  try {
    await writeFile(join(root, "long.txt"), "1234");
    const result = await download(service.app, "long.txt");
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body.toString("utf8")), { error: "Download is too large (max 3 bytes)" });
    assert.equal((await check(service.app, "long.txt")).status, 413);
  } finally {
    service.close();
  }
});

test("認証なしは 401 で、walk もしない", async () => {
  const root = makeRoot("auth");
  const service = createService(root);
  try {
    await mkdir(join(root, "src"));
    for (const url of ["/v1/files/download?path=src", "/v1/files/download/check?path=src"]) {
      const response = await service.app.request(url);
      assert.equal(response.status, 401, url);
    }
  } finally {
    service.close();
  }
});
