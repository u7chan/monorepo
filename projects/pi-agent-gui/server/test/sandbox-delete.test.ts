// DELETE /v1/files。実ファイルシステムを使い、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-delete-symlink-check-"));
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

async function remove(app: App, path?: string): Promise<{ status: number; body: { error?: string } }> {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  const response = await app.request(`/v1/files${query}`, { method: "DELETE", headers: authHeaders() });
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

test("delete removes a regular file and frees the name for the next upload", async () => {
  const root = makeRoot("delete");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "photo.png"), "original");

    const deleted = await remove(service.app, "uploads/photo.png");
    assert.equal(deleted.status, 204);
    assert.deepEqual(await readdir(join(root, "uploads")), []);

    // 受け入れ条件: 消した後は同じ名前で保存でき、連番 (-1) が付かない
    const upload = await service.app.request("/v1/files/upload?dir=uploads&name=photo.png", {
      method: "POST",
      headers: authHeaders(),
      body: "second",
    });
    assert.equal(upload.status, 201);
    assert.deepEqual(await upload.json(), { path: "uploads/photo.png", name: "photo.png", renamed: false, size: 6 });
  } finally {
    service.close();
  }
});

test("delete accepts root-relative and nested paths", async () => {
  const root = makeRoot("delete-nested");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "deep.txt"), "x");
    await writeFile(join(root, "top.txt"), "y");

    assert.equal((await remove(service.app, "a/b/deep.txt")).status, 204);
    assert.equal((await remove(service.app, "top.txt")).status, 204);
    assert.deepEqual(await readdir(join(root, "a", "b")), []);
    assert.deepEqual(await readdir(root), ["a"]);
  } finally {
    service.close();
  }
});

test("delete rejects directories, special files, missing paths, and the root itself", async () => {
  const root = makeRoot("delete-reject");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");
    // FIFO は作れないプラットフォーム (Windows) があるため、作れたときだけ確認する
    const fifo = makeFifo(join(root, "pipe"));

    const directory = await remove(service.app, "dirB");
    assert.equal(directory.status, 400);
    assert.match(directory.body.error ?? "", /Not a regular file/);

    const missing = await remove(service.app, "nope.txt");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error ?? "", /Path not found/);

    if (fifo) {
      const special = await remove(service.app, "pipe");
      assert.equal(special.status, 400);
      assert.match(special.body.error ?? "", /Not a regular file/);
    }

    for (const path of ["", ".", "dirB/.."]) {
      const response = await remove(service.app, path);
      assert.equal(response.status, 400, `path=${JSON.stringify(path)} は 400`);
      assert.match(response.body.error ?? "", /Not a regular file/);
    }
    // 末尾の区切りはカーネルでは ENOTDIR になる。通常ファイルとしては扱わない
    const trailing = await remove(service.app, "dirB/stay.txt/");
    assert.equal(trailing.status, 400);
    assert.match(trailing.body.error ?? "", /Not a regular file/);
    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
  } finally {
    service.close();
  }
});

test("delete rejects paths outside the workspace", async () => {
  const base = makeRoot("delete-outside");
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(base, "outside.txt"), "keep");
    for (const path of ["../outside.txt", "../missing.txt", "/etc/hostname"]) {
      const response = await remove(service.app, path);
      assert.equal(response.status, 400, `${path} must be rejected`);
      assert.match(response.body.error ?? "", /outside the workspace/);
    }
    // `..` 自体と末尾が区切りのパスは通常ファイルではない
    for (const path of ["..", "/"]) {
      const response = await remove(service.app, path);
      assert.equal(response.status, 400, `${path} must be rejected`);
      assert.match(response.body.error ?? "", /Not a regular file/);
    }
    assert.equal(await exists(join(base, "outside.txt")), true);
  } finally {
    service.close();
  }
});

test(
  "delete rejects symlinks without touching their targets",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("delete-symlink");
    const outside = makeRoot("delete-symlink-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await writeFile(join(root, "inside.txt"), "inside");
      await mkdir(join(outside, "nested"), { recursive: true });
      await writeFile(join(outside, "nested", "target.txt"), "outside");
      await symlink(join(root, "inside.txt"), join(root, "linkFile"));
      await symlink(join(outside, "nested"), join(root, "linkOutsideDir"));
      await symlink(join(root, "gone.txt"), join(root, "linkBroken"));

      for (const path of ["linkFile", "linkOutsideDir", "linkBroken"]) {
        const response = await remove(service.app, path);
        assert.equal(response.status, 400, `${path} must be rejected`);
        assert.match(response.body.error ?? "", /Symbolic links cannot be deleted/);
      }
      // リンクも指し先も残る (root 外の実体を消していない)
      assert.equal(await exists(join(root, "linkFile")), true);
      assert.equal(await exists(join(root, "inside.txt")), true);
      assert.equal(await exists(join(outside, "nested", "target.txt")), true);

      // symlink ディレクトリ経由では root 外のファイルを消せない (親の解決が root 外になる)
      const throughLink = await remove(service.app, "linkOutsideDir/target.txt");
      assert.equal(throughLink.status, 400);
      assert.match(throughLink.body.error ?? "", /outside the workspace/);
      assert.equal(await exists(join(outside, "nested", "target.txt")), true);
    } finally {
      service.close();
    }
  },
);

test(
  "delete applies .. after following symlinks, like the listing does",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    // `..` は symlink を辿った後に適用される。字句的に畳んでから親を作ると、要求パスが指すファイルとは
    // 別のファイルを消してしまう (root 内の link が別のディレクトリを指す場合)
    const root = makeRoot("delete-dotdot");
    const outside = makeRoot("delete-dotdot-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "sub"), { recursive: true });
      await mkdir(join(root, "other"), { recursive: true });
      await mkdir(join(outside, "nested"), { recursive: true });
      await writeFile(join(root, "photo.png"), "root");
      await writeFile(join(root, "sub", "photo.png"), "sub");
      await writeFile(join(outside, "photo.png"), "outside");
      await symlink(join(root, "other"), join(root, "sub", "link"));
      await symlink(join(outside, "nested"), join(root, "sub", "linkOutside"));

      // sub/link/.. は (字句の sub ではなく) カーネルと同じく root へ解決する
      const response = await remove(service.app, "sub/link/../photo.png");
      assert.equal(response.status, 204, response.body.error ?? "");
      assert.equal(await exists(join(root, "photo.png")), false, "要求パスが指すファイルを消す");
      assert.equal(await exists(join(root, "sub", "photo.png")), true, "字句の .. で別のファイルを消さない");

      // root 外へ出る `..` は一覧と同じく 400 (外の実体を消さない)
      const escape = await remove(service.app, "sub/linkOutside/../photo.png");
      assert.equal(escape.status, 400);
      assert.match(escape.body.error ?? "", /outside the workspace/);
      assert.equal(await exists(join(outside, "photo.png")), true);
    } finally {
      service.close();
    }
  },
);

test(
  "delete follows a symlinked directory inside the root like the listing does",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("delete-link-inside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "dirB"), { recursive: true });
      await writeFile(join(root, "dirB", "inner.txt"), "inner");
      await symlink(join(root, "dirB"), join(root, "linkInside"));

      const response = await remove(service.app, "linkInside/inner.txt");
      assert.equal(response.status, 204, response.body.error ?? "");
      assert.deepEqual(await readdir(join(root, "dirB")), []);
    } finally {
      service.close();
    }
  },
);

test("delete requires the bearer token", async () => {
  const root = makeRoot("delete-auth");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "a.txt"), "x");
    assert.equal((await service.app.request("/v1/files?path=a.txt", { method: "DELETE" })).status, 401);
    assert.equal(
      (
        await service.app.request("/v1/files?path=a.txt", {
          method: "DELETE",
          headers: { Authorization: "Bearer wrong-token-0123456789abcdef" },
        })
      ).status,
      401,
    );
    assert.equal(await exists(join(root, "a.txt")), true);
  } finally {
    service.close();
  }
});
