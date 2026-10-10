// POST /v1/files/move。実ファイルシステムを使い、listen せず app.request() で検証する。

import assert from "node:assert/strict";
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
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-move-symlink-check-"));
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

async function move(
  app: App,
  body: { from?: unknown; to?: unknown },
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const response = await app.request("/v1/files/move", {
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

test("move moves a regular file to another parent and returns the new root-relative path", async () => {
  const root = makeRoot("move-file");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads", "nested"), { recursive: true });
    await mkdir(join(root, "projects"), { recursive: true });
    await writeFile(join(root, "uploads", "nested", "photo.png"), "original");

    const moved = await move(service.app, { from: "uploads/nested/photo.png", to: "projects/shot.png" });
    assert.equal(moved.status, 200, moved.body.error ?? "");
    assert.deepEqual(moved.body, { path: "projects/shot.png" });
    assert.equal(await exists(join(root, "uploads", "nested", "photo.png")), false);
    assert.equal(await readFile(join(root, "projects", "shot.png"), "utf-8"), "original");

    // 一覧にも移動先の親でだけ出る (元の親の一覧からは消える)
    const sourceListing = await service.app.request("/v1/files?path=uploads%2Fnested", { headers: authHeaders() });
    assert.deepEqual(
      ((await sourceListing.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name),
      [],
    );
    const destinationListing = await service.app.request("/v1/files?path=projects", { headers: authHeaders() });
    assert.deepEqual(
      ((await destinationListing.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name),
      ["shot.png"],
    );
  } finally {
    service.close();
  }
});

test("move moves a directory with its children to another parent and keeps the tree reachable", async () => {
  const root = makeRoot("move-dir");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "old", "deep"), { recursive: true });
    await mkdir(join(root, "spaces", "s1"), { recursive: true });
    await writeFile(join(root, "old", "deep", "inner.txt"), "inner");

    const moved = await move(service.app, { from: "old", to: "spaces/s1/moved" });
    assert.equal(moved.status, 200, moved.body.error ?? "");
    assert.deepEqual(moved.body, { path: "spaces/s1/moved" });
    assert.equal(await exists(join(root, "old")), false);
    assert.equal(await readFile(join(root, "spaces", "s1", "moved", "deep", "inner.txt"), "utf-8"), "inner");

    // 移動後も一覧の path として辿れる
    const listing = await service.app.request("/v1/files?path=spaces%2Fs1%2Fmoved", { headers: authHeaders() });
    assert.equal(listing.status, 200);
    assert.deepEqual(
      ((await listing.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name),
      ["deep"],
    );
    assert.deepEqual(await readdir(root), ["spaces"]);
  } finally {
    service.close();
  }
});

test("move answers 409 for an existing destination and changes nothing", async () => {
  const root = makeRoot("move-conflict");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirA"), { recursive: true });
    await mkdir(join(root, "dirB"), { recursive: true });
    await mkdir(join(root, "dirC"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "dirA", "inner.txt"), "innerA");
    await writeFile(join(root, "dirC", "c.txt"), "c");

    // ファイル → 既存ファイル / ディレクトリ → 既存ディレクトリ / ファイル → 既存ディレクトリ のどれも 409
    for (const body of [
      { from: "a.txt", to: "b.txt" },
      { from: "dirA", to: "dirB" },
      { from: "a.txt", to: "dirB" },
      { from: "dirA", to: "b.txt" },
      { from: "dirA", to: "dirC/c.txt" },
    ]) {
      const response = await move(service.app, body);
      assert.equal(response.status, 409, `${body.from} -> ${body.to}: ${response.body.error ?? ""}`);
      assert.match(response.body.error ?? "", /Already exists/);
    }
    assert.equal(await readFile(join(root, "a.txt"), "utf-8"), "a");
    assert.equal(await readFile(join(root, "b.txt"), "utf-8"), "b");
    assert.equal(await readFile(join(root, "dirA", "inner.txt"), "utf-8"), "innerA");
    assert.equal(await readFile(join(root, "dirC", "c.txt"), "utf-8"), "c");
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt", "dirA", "dirB", "dirC"]);
  } finally {
    service.close();
  }
});

test("move rejects invalid from / to shapes without touching anything", async () => {
  const root = makeRoot("move-invalid");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");
    await writeFile(join(root, "file.txt"), "f");

    // 移動元は 1 エントリを表すパスだけ (root 自身・`.` / `..`・末尾の区切りは 400)
    for (const from of ["", ".", "..", "dirB/"]) {
      const response = await move(service.app, { from, to: "next.txt" });
      assert.equal(response.status, 400, `from=${JSON.stringify(from)}`);
      assert.match(response.body.error ?? "", /Not a file or directory/);
    }

    // 移動先の最終要素は 1 セグメント名だけ (isValidEntryName と同じ規則)
    for (const to of ["", ".", "..", "dirB/", "a\\b", "x".repeat(201), "bad\u0000name"]) {
      const response = await move(service.app, { from: "dirB/stay.txt", to });
      assert.equal(response.status, 400, `to=${JSON.stringify(to)}`);
      assert.match(response.body.error ?? "", /Invalid name/);
    }

    // 移動先の親はディレクトリだけ
    const notDirectory = await move(service.app, { from: "dirB/stay.txt", to: "file.txt/next.txt" });
    assert.equal(notDirectory.status, 400, notDirectory.body.error ?? "");
    assert.match(notDirectory.body.error ?? "", /Not a directory/);

    // from / to は JSON の string だけを受ける
    for (const from of [42, null, { a: 1 }]) {
      assert.equal((await move(service.app, { from, to: "next.txt" })).status, 400);
    }
    for (const to of [42, null, { a: 1 }]) {
      assert.equal((await move(service.app, { from: "dirB/stay.txt", to })).status, 400);
    }

    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
    assert.deepEqual(await readdir(join(root, "dirB")), ["stay.txt"]);
  } finally {
    service.close();
  }
});

test("move answers 404 for a missing source and a missing destination parent", async () => {
  const root = makeRoot("move-missing");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "a.txt"), "a");

    const missingSource = await move(service.app, { from: "nope.txt", to: "a2.txt" });
    assert.equal(missingSource.status, 404);
    assert.match(missingSource.body.error ?? "", /Path not found/);

    const inMissingDir = await move(service.app, { from: "missing/a.txt", to: "a2.txt" });
    assert.equal(inMissingDir.status, 404);

    // 移動先の親は呼び出し側が POST /v1/dirs で作ってから呼ぶ
    const missingParent = await move(service.app, { from: "a.txt", to: "missing/a.txt" });
    assert.equal(missingParent.status, 404);
    assert.match(missingParent.body.error ?? "", /Path not found/);

    assert.equal(await readFile(join(root, "a.txt"), "utf-8"), "a");
    assert.deepEqual(await readdir(root), ["a.txt"]);
  } finally {
    service.close();
  }
});

test("move rejects paths outside the workspace and changes nothing", async () => {
  const base = makeRoot("move-outside");
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(base, "outside.txt"), "keep");
    await writeFile(join(root, "inside.txt"), "inside");

    for (const from of ["../outside.txt", "../missing.txt", "/etc/hostname"]) {
      const response = await move(service.app, { from, to: "moved.txt" });
      assert.equal(response.status, 400, `${from} must be rejected`);
      assert.match(response.body.error ?? "", /outside the workspace/);
    }
    for (const to of ["../moved.txt", "/etc/moved.txt"]) {
      const response = await move(service.app, { from: "inside.txt", to });
      assert.equal(response.status, 400, `${to} must be rejected`);
      assert.match(response.body.error ?? "", /outside the workspace/);
    }

    assert.equal(await readFile(join(base, "outside.txt"), "utf-8"), "keep");
    assert.equal(await exists(join(base, "moved.txt")), false);
    assert.equal(await readFile(join(root, "inside.txt"), "utf-8"), "inside");
    assert.deepEqual(await readdir(root), ["inside.txt"]);
  } finally {
    service.close();
  }
});

test(
  "move rejects symlinks and root escapes through them without changing anything",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("move-symlink");
    const outside = makeRoot("move-symlink-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await writeFile(join(root, "inside.txt"), "inside");
      await mkdir(join(outside, "nested"), { recursive: true });
      await writeFile(join(outside, "nested", "target.txt"), "outside");
      await symlink(join(root, "inside.txt"), join(root, "linkFile"));
      await symlink(join(outside, "nested"), join(root, "linkOutsideDir"));
      await symlink(join(root, "gone.txt"), join(root, "linkBroken"));

      // 移動元そのものが symlink なら動かさない (リンクを rename すると root 外の実体を動かせてしまう)
      for (const from of ["linkFile", "linkOutsideDir", "linkBroken"]) {
        const response = await move(service.app, { from, to: "renamed" });
        assert.equal(response.status, 400, `${from} must be rejected`);
        assert.match(response.body.error ?? "", /Symbolic links cannot be moved/);
      }

      // 移動元 / 移動先の親が root 外を指す symlink なら、その先を動かさない
      const fromViaLink = await move(service.app, { from: "linkOutsideDir/target.txt", to: "renamed.txt" });
      assert.equal(fromViaLink.status, 400);
      assert.match(fromViaLink.body.error ?? "", /outside the workspace/);
      const toViaLink = await move(service.app, { from: "inside.txt", to: "linkOutsideDir/moved.txt" });
      assert.equal(toViaLink.status, 400);
      assert.match(toViaLink.body.error ?? "", /outside the workspace/);

      // 移動先が symlink なら、実体が同じでも上書きしない (409)
      const ontoLink = await move(service.app, { from: "inside.txt", to: "linkFile" });
      assert.equal(ontoLink.status, 409, ontoLink.body.error ?? "");
      assert.match(ontoLink.body.error ?? "", /Already exists/);

      // リンクも指し先も残る (root 外の実体を動かしていない)
      assert.equal(await exists(join(root, "inside.txt")), true);
      assert.equal(await exists(join(root, "linkFile")), true);
      assert.equal(await exists(join(outside, "nested", "target.txt")), true);
      assert.equal(await exists(join(root, "renamed.txt")), false);
      assert.equal(await exists(join(outside, "nested", "moved.txt")), false);
    } finally {
      service.close();
    }
  },
);

test(
  "move follows a symlinked directory inside the root like the listing does",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("move-link-inside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "dirB"), { recursive: true });
      await mkdir(join(root, "other"), { recursive: true });
      await writeFile(join(root, "dirB", "inner.txt"), "inner");
      await symlink(join(root, "dirB"), join(root, "linkInside"));

      const moved = await move(service.app, { from: "linkInside/inner.txt", to: "other/renamed.txt" });
      assert.equal(moved.status, 200, moved.body.error ?? "");
      assert.deepEqual(moved.body, { path: "other/renamed.txt" });
      assert.equal(await exists(join(root, "dirB", "inner.txt")), false);
      assert.equal(await readFile(join(root, "other", "renamed.txt"), "utf-8"), "inner");

      // 移動先の親が root 内の symlink なら、辿った先の実パス基準で応答する (一覧の path と同じ規則)
      const back = await move(service.app, { from: "other/renamed.txt", to: "linkInside/moved-back.txt" });
      assert.equal(back.status, 200, back.body.error ?? "");
      assert.deepEqual(back.body, { path: "dirB/moved-back.txt" });
      assert.equal(await readFile(join(root, "dirB", "moved-back.txt"), "utf-8"), "inner");
      assert.equal(await exists(join(root, "other", "renamed.txt")), false);
    } finally {
      service.close();
    }
  },
);

test("move rejects moving a directory into its own subtree and changes nothing", async () => {
  const root = makeRoot("move-into-itself");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dir", "child"), { recursive: true });
    await writeFile(join(root, "dir", "child", "inner.txt"), "inner");

    const response = await move(service.app, { from: "dir", to: "dir/sub" });
    assert.equal(response.status, 400, response.body.error ?? "");
    assert.match(response.body.error ?? "", /Cannot move/);
    assert.equal(await exists(join(root, "dir", "sub")), false);
    assert.equal(await readFile(join(root, "dir", "child", "inner.txt"), "utf-8"), "inner");
  } finally {
    service.close();
  }
});

test("move requires the bearer token", async () => {
  const root = makeRoot("move-auth");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "a.txt"), "x");
    const unauthorized = await service.app.request("/v1/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "a.txt", to: "b.txt" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(await exists(join(root, "a.txt")), true);
    assert.equal(await exists(join(root, "b.txt")), false);
  } finally {
    service.close();
  }
});
