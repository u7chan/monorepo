// GET /v1/skills/export と /v1/skills/export/check。実ファイルシステムを使い、listen せず app.request() で検証する。
// ZIP の検証は test/zip-reader.ts の自前パーサ（unzip はホストにも CI にも無い）。
// 対象は `.agents/skills` 固定で、除外は `.git` 固定 + symlink 除外。利用者の除外設定 (exclude query) は使わない。

import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService, type SandboxServiceOptions } from "../src/sandbox/service";
import type { SandboxDownloadCheck } from "../src/sandbox/protocol";
import { parseZip, type ParsedZipEntry } from "./zip-reader";

const TOKEN = "test-sandbox-token-0123456789abcdef";

const SKILL_TEXT = '---\nname: alpha\ndescription: "説明"\n---\n本文\n';

type App = ReturnType<typeof createSandboxService>["app"];

const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-skill-export-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-skill-export-${prefix}-`));
}

function createService(root: string, options: Partial<SandboxServiceOptions> = {}) {
  return createSandboxService({ token: TOKEN, rootCwd: root, ...options });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function exportSkills(app: App): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const response = await app.request("/v1/skills/export", { headers: authHeaders() });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}

async function checkExport(app: App): Promise<{ status: number; body: SandboxDownloadCheck | { error: string } }> {
  const response = await app.request("/v1/skills/export/check", { headers: authHeaders() });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function entryNames(entries: ParsedZipEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/** alpha を 1 件持つ `.agents/skills` を作る */
async function writeAlpha(root: string): Promise<void> {
  await mkdir(join(root, ".agents/skills/alpha/refs"), { recursive: true });
  await mkdir(join(root, ".agents/skills/alpha/empty"), { recursive: true });
  await writeFile(join(root, ".agents/skills/alpha/SKILL.md"), SKILL_TEXT, "utf8");
  await writeFile(join(root, ".agents/skills/alpha/refs/note.md"), "note\n", "utf8");
}

test("直下は SKILL.md を持つフォルダだけを入れ、付随ファイルと空ディレクトリを保つ", async () => {
  const root = makeRoot("filter");
  const service = createService(root);
  try {
    await writeAlpha(root);
    // 直下の非スキル項目 (ファイルと SKILL.md を持たないディレクトリ) は入れない
    await writeFile(join(root, ".agents/skills/README.md"), "readme\n", "utf8");
    await mkdir(join(root, ".agents/skills/notes"), { recursive: true });
    await writeFile(join(root, ".agents/skills/notes/memo.txt"), "memo\n", "utf8");

    const result = await exportSkills(service.app);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Type"), "application/zip");
    assert.equal(result.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''skills.zip");
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.equal(result.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(result.headers.get("Content-Length"), null, "zip に Content-Length を付けている");

    const entries = parseZip(result.body);
    assert.deepEqual(entryNames(entries), [
      "alpha/",
      "alpha/empty/",
      "alpha/refs/",
      "alpha/refs/note.md",
      "alpha/SKILL.md",
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("alpha/SKILL.md")?.data.toString("utf8"), SKILL_TEXT);
    assert.equal(byName.get("alpha/refs/note.md")?.data.toString("utf8"), "note\n");
    // 全エントリが読める zip（CRC / サイズ / data descriptor が本文と一致する）
    for (const entry of entries) assert.ok(entry.crcMatches && entry.descriptorMatches, entry.name);
  } finally {
    service.close();
  }
});

test("`.git` は全階層で外し、利用者の除外設定 (exclude query) に依存しない", async () => {
  const root = makeRoot("exclude");
  const service = createService(root);
  try {
    await writeAlpha(root);
    // `.git` は固定で落とす。`node_modules` / `dist` はダウンロードの既定除外だが、スキル持ち出しでは入れる
    await mkdir(join(root, ".agents/skills/alpha/.git/objects"), { recursive: true });
    await writeFile(join(root, ".agents/skills/alpha/.git/HEAD"), "ref\n", "utf8");
    await mkdir(join(root, ".agents/skills/alpha/node_modules/dep"), { recursive: true });
    await writeFile(join(root, ".agents/skills/alpha/node_modules/dep/index.js"), "x\n", "utf8");
    await mkdir(join(root, ".agents/skills/alpha/dist"), { recursive: true });
    await writeFile(join(root, ".agents/skills/alpha/dist/bundle.js"), "y\n", "utf8");

    const result = await exportSkills(service.app);
    assert.equal(result.status, 200);
    const names = entryNames(parseZip(result.body));
    assert.ok(!names.some((name) => name.includes(".git")), JSON.stringify(names));
    assert.ok(names.includes("alpha/node_modules/dep/index.js"), JSON.stringify(names));
    assert.ok(names.includes("alpha/dist/bundle.js"), JSON.stringify(names));

    const checked = await checkExport(service.app);
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body, {
      kind: "archive",
      name: "skills.zip",
      // SKILL.md + refs/note.md + node_modules/dep/index.js + dist/bundle.js
      bytes: Buffer.byteLength(SKILL_TEXT) + 5 + 2 + 2,
      entries: 10,
      skipped: [".git"],
    });

    // exclude query を付けても内容は変わらない (持ち出しは利用者の除外設定を見ない)
    const withQuery = await service.app.request("/v1/skills/export?exclude=node_modules&exclude=dist", {
      headers: authHeaders(),
    });
    assert.equal(withQuery.status, 200);
    assert.deepEqual(entryNames(parseZip(Buffer.from(await withQuery.arrayBuffer()))), names);
  } finally {
    service.close();
  }
});

test("symlink のフォルダ / ファイル / SKILL.md は入れない", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = makeRoot("symlink");
  const outside = makeRoot("outside");
  const service = createService(root);
  try {
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await writeAlpha(root);
    // スキル配下の symlink はエントリに入れない
    symlinkSync(join(outside, "secret.txt"), join(root, ".agents/skills/alpha/refs/secret.txt"));
    // 直下の symlink フォルダはスキルフォルダとして扱わない
    symlinkSync(outside, join(root, ".agents/skills/linked"));
    // SKILL.md が symlink のフォルダもスキルとして配らない (中身が無い bundle にしない)
    await mkdir(join(root, ".agents/skills/alpha-link"));
    symlinkSync(join(outside, "secret.txt"), join(root, ".agents/skills/alpha-link/SKILL.md"));

    const result = await exportSkills(service.app);
    assert.equal(result.status, 200);
    assert.deepEqual(entryNames(parseZip(result.body)), [
      "alpha/",
      "alpha/empty/",
      "alpha/refs/",
      "alpha/refs/note.md",
      "alpha/SKILL.md",
    ]);
  } finally {
    service.close();
  }
});

test("`.agents/skills` が無いときは 404、スキル 0 件は空 ZIP と entries: 0", async () => {
  const root = makeRoot("missing");
  const service = createService(root);
  try {
    const missing = await exportSkills(service.app);
    assert.equal(missing.status, 404);
    assert.match(JSON.parse(missing.body.toString("utf8")).error, /Path not found/);
    assert.equal((await checkExport(service.app)).status, 404);

    await mkdir(join(root, ".agents/skills"), { recursive: true });
    const empty = await exportSkills(service.app);
    assert.equal(empty.status, 200);
    assert.deepEqual(entryNames(parseZip(empty.body)), []);
    assert.deepEqual(await checkExport(service.app), {
      status: 200,
      body: { kind: "archive", name: "skills.zip", bytes: 0, entries: 0, skipped: [] },
    });
  } finally {
    service.close();
  }
});

test("合計サイズ / 件数の上限はヘッダ送出前に 413 になる", async () => {
  const root = makeRoot("limits");
  const service = createService(root, { maxArchiveBytes: 10, maxArchiveEntries: 3 });
  try {
    await writeAlpha(root);
    // alpha/ + empty/ + refs/ + note.md + SKILL.md = 5 エントリで件数超過
    const tooMany = await exportSkills(service.app);
    assert.equal(tooMany.status, 413);
    assert.deepEqual(JSON.parse(tooMany.body.toString("utf8")), { error: "Download has too many entries (max 3)" });
    assert.equal((await checkExport(service.app)).status, 413);
  } finally {
    service.close();
  }

  const small = makeRoot("limit-bytes");
  const smallService = createService(small, { maxArchiveBytes: 4 });
  try {
    await writeAlpha(small);
    const tooLarge = await exportSkills(smallService.app);
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(JSON.parse(tooLarge.body.toString("utf8")), { error: "Download is too large (max 4 bytes)" });
    assert.equal((await checkExport(smallService.app)).status, 413);
  } finally {
    smallService.close();
  }
});

test("認証なしは 401 で、walk もしない", async () => {
  const root = makeRoot("auth");
  const service = createService(root);
  try {
    await writeAlpha(root);
    for (const url of ["/v1/skills/export", "/v1/skills/export/check"]) {
      assert.equal((await service.app.request(url)).status, 401, url);
    }
  } finally {
    service.close();
  }
});
