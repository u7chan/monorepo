// POST /v1/files/rename。実ファイルシステムを使い、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-rename-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-${prefix}-`));
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function rename(
  app: App,
  body: { path?: unknown; name?: unknown },
): Promise<{ status: number; body: { path?: string; name?: string; error?: string } }> {
  const response = await app.request("/v1/files/rename", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as { error?: string }) : {} };
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** mkfifo(1) が無いプラットフォーム (Windows) では特殊ファイルの確認を飛ばす */
function makeFifo(path: string): boolean {
  return spawnSync("mkfifo", [path], { stdio: "pipe" }).status === 0;
}

test("rename moves a regular file and returns the new root-relative path", async () => {
  const root = makeRoot("rename-file");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads", "nested"), { recursive: true });
    await writeFile(join(root, "uploads", "nested", "photo.png"), "original");

    const renamed = await rename(service.app, { path: "uploads/nested/photo.png", name: "shot.png" });
    assert.equal(renamed.status, 200, renamed.body.error ?? "");
    assert.deepEqual(renamed.body, { path: "uploads/nested/shot.png", name: "shot.png" });
    assert.equal(await exists(join(root, "uploads", "nested", "photo.png")), false);
    assert.equal(await readFile(join(root, "uploads", "nested", "shot.png"), "utf-8"), "original");

    // 一覧にも新しい名前で出る (旧名の行は消える)
    const listing = await service.app.request("/v1/files?path=uploads%2Fnested", { headers: authHeaders() });
    assert.deepEqual(
      ((await listing.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name),
      ["shot.png"],
    );
  } finally {
    service.close();
  }
});

test("rename moves a directory with its children and keeps the tree reachable", async () => {
  const root = makeRoot("rename-dir");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "old", "deep"), { recursive: true });
    await writeFile(join(root, "old", "deep", "inner.txt"), "inner");

    const renamed = await rename(service.app, { path: "old", name: "new" });
    assert.equal(renamed.status, 200, renamed.body.error ?? "");
    assert.deepEqual(renamed.body, { path: "new", name: "new" });
    assert.equal(await exists(join(root, "old")), false);
    assert.equal(await readFile(join(root, "new", "deep", "inner.txt"), "utf-8"), "inner");

    // 改名後も一覧の path として辿れる (親の一覧にも新しい名前だけが出る)
    const listing = await service.app.request("/v1/files?path=new%2Fdeep", { headers: authHeaders() });
    assert.equal(listing.status, 200);
    assert.deepEqual(
      ((await listing.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name),
      ["inner.txt"],
    );
    assert.deepEqual(await readdir(root), ["new"]);
  } finally {
    service.close();
  }
});

test("rename allows a case-only change", async () => {
  const root = makeRoot("rename-case");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "photo.png"), "x");
    // 大文字小文字だけ違う名前は同じ実体を指す (case-insensitive な fs では lstat が成功する) ため、同名扱いにしない
    const renamed = await rename(service.app, { path: "photo.png", name: "PHOTO.PNG" });
    assert.equal(renamed.status, 200, renamed.body.error ?? "");
    assert.deepEqual(renamed.body, { path: "PHOTO.PNG", name: "PHOTO.PNG" });
    assert.deepEqual(await readdir(root), ["PHOTO.PNG"]);
  } finally {
    service.close();
  }
});

test("rename answers 409 for an existing name and changes nothing", async () => {
  const root = makeRoot("rename-conflict");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirA"), { recursive: true });
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");

    // ファイル → 既存ファイル / ディレクトリ → 既存ディレクトリ / ファイル → 既存ディレクトリ のどれも 409
    for (const body of [
      { path: "a.txt", name: "b.txt" },
      { path: "dirA", name: "dirB" },
      { path: "a.txt", name: "dirB" },
      { path: "dirA", name: "b.txt" },
    ]) {
      const response = await rename(service.app, body);
      assert.equal(response.status, 409, `${body.path} -> ${body.name}: ${response.body.error ?? ""}`);
      assert.match(response.body.error ?? "", /Already exists/);
    }
    assert.equal(await readFile(join(root, "a.txt"), "utf-8"), "a");
    assert.equal(await readFile(join(root, "b.txt"), "utf-8"), "b");
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt", "dirA", "dirB"]);
  } finally {
    service.close();
  }
});

test("rename rejects invalid names and paths without touching the entry", async () => {
  const root = makeRoot("rename-invalid");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");
    const fifo = makeFifo(join(root, "pipe"));

    for (const name of ["", ".", "..", "a/b", "a\\b", "x".repeat(201)]) {
      const response = await rename(service.app, { path: "dirB/stay.txt", name });
      assert.equal(response.status, 400, `name=${JSON.stringify(name)}`);
      assert.match(response.body.error ?? "", /Invalid name/);
    }
    // 名前は JSON の string だけを受ける
    for (const name of [42, null, { a: 1 }]) {
      assert.equal((await rename(service.app, { path: "dirB/stay.txt", name })).status, 400);
    }

    // エントリを表さない path は 400 (root 自身・`.` / `..`・末尾の区切り・特殊ファイル)
    for (const path of ["", ".", "..", "dirB/", "dirB/.."]) {
      const response = await rename(service.app, { path, name: "next.txt" });
      assert.equal(response.status, 400, `path=${JSON.stringify(path)}`);
    }
    if (fifo) {
      const special = await rename(service.app, { path: "pipe", name: "next" });
      assert.equal(special.status, 400);
      assert.match(special.body.error ?? "", /Not a file or directory/);
    }
    for (const path of [42, null]) {
      assert.equal((await rename(service.app, { path, name: "next.txt" })).status, 400);
    }

    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
    assert.deepEqual(await readdir(join(root, "dirB")), ["stay.txt"]);
  } finally {
    service.close();
  }
});

test("rename answers 404 for a missing entry", async () => {
  const root = makeRoot("rename-missing");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const response = await rename(service.app, { path: "nope.txt", name: "next.txt" });
    assert.equal(response.status, 404);
    assert.match(response.body.error ?? "", /Path not found/);

    const inMissingDir = await rename(service.app, { path: "nope/next.txt", name: "next.txt" });
    assert.equal(inMissingDir.status, 404);
  } finally {
    service.close();
  }
});

test("rename rejects paths outside the workspace", async () => {
  const base = makeRoot("rename-outside");
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(base, "outside.txt"), "keep");
    for (const path of ["../outside.txt", "../missing.txt", "/etc/hostname"]) {
      const response = await rename(service.app, { path, name: "next.txt" });
      assert.equal(response.status, 400, `${path} must be rejected`);
      assert.match(response.body.error ?? "", /outside the workspace/);
    }
    assert.equal(await exists(join(base, "outside.txt")), true);
    assert.equal(await exists(join(base, "next.txt")), false);
  } finally {
    service.close();
  }
});

test(
  "rename rejects symlinks and never overwrites a symlink",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("rename-symlink");
    const outside = makeRoot("rename-symlink-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await writeFile(join(root, "inside.txt"), "inside");
      await mkdir(join(outside, "nested"), { recursive: true });
      await writeFile(join(outside, "nested", "target.txt"), "outside");
      await symlink(join(root, "inside.txt"), join(root, "linkFile"));
      await symlink(join(outside, "nested"), join(root, "linkOutsideDir"));
      await symlink(join(root, "gone.txt"), join(root, "linkBroken"));

      for (const path of ["linkFile", "linkOutsideDir", "linkBroken"]) {
        const response = await rename(service.app, { path, name: "renamed" });
        assert.equal(response.status, 400, `${path} must be rejected`);
        assert.match(response.body.error ?? "", /Symbolic links cannot be renamed/);
      }
      // リンクも指し先も残る (root 外の実体を動かしていない)
      assert.equal(await exists(join(root, "linkFile")), true);
      assert.equal(await exists(join(root, "inside.txt")), true);
      assert.equal(await exists(join(outside, "nested", "target.txt")), true);

      // symlink ディレクトリ経由では root 外のファイルを動かせない (親の解決が root 外になる)
      const throughLink = await rename(service.app, { path: "linkOutsideDir/target.txt", name: "renamed.txt" });
      assert.equal(throughLink.status, 400);
      assert.match(throughLink.body.error ?? "", /outside the workspace/);
      assert.equal(await exists(join(outside, "nested", "target.txt")), true);

      // 改名先が symlink のときは、実体が同じでも上書きしない (409)
      const ontoLink = await rename(service.app, { path: "inside.txt", name: "linkFile" });
      assert.equal(ontoLink.status, 409, ontoLink.body.error ?? "");
      assert.equal(await exists(join(root, "inside.txt")), true);
      assert.equal(await exists(join(root, "linkFile")), true);
    } finally {
      service.close();
    }
  },
);

test(
  "rename follows a symlinked directory inside the root like the listing does",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("rename-link-inside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "dirB"), { recursive: true });
      await writeFile(join(root, "dirB", "inner.txt"), "inner");
      await symlink(join(root, "dirB"), join(root, "linkInside"));

      const response = await rename(service.app, { path: "linkInside/inner.txt", name: "renamed.txt" });
      assert.equal(response.status, 200, response.body.error ?? "");
      // 応答は辿った先の実パス基準 (一覧の path と同じ規則)
      assert.deepEqual(response.body, { path: "dirB/renamed.txt", name: "renamed.txt" });
      assert.deepEqual(await readdir(join(root, "dirB")), ["renamed.txt"]);
    } finally {
      service.close();
    }
  },
);

test("rename requires the bearer token", async () => {
  const root = makeRoot("rename-auth");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "a.txt"), "x");
    const unauthorized = await service.app.request("/v1/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "a.txt", name: "b.txt" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(await exists(join(root, "a.txt")), true);
  } finally {
    service.close();
  }
});
