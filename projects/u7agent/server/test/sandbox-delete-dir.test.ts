// DELETE /v1/dirs。実ファイルシステムを使い、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRecursiveQuery, SANDBOX_MAX_FILE_ENTRIES } from "../src/sandbox/protocol";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-delete-dir-symlink-check-"));
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

/** query は生で渡す (recursive の重複と空値を URLSearchParams を介さずに組めるようにする) */
async function removeDir(app: App, query: string): Promise<{ status: number; body: { error?: string }; text: string }> {
  const response = await app.request(`/v1/dirs${query}`, { method: "DELETE", headers: authHeaders() });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as { error?: string }) : {}, text };
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

test("parseRecursiveQuery は文字列 true が 1 つだけのときに再帰する", () => {
  assert.deepEqual(parseRecursiveQuery(undefined), { ok: true, recursive: false });
  assert.deepEqual(parseRecursiveQuery([]), { ok: true, recursive: false });
  assert.deepEqual(parseRecursiveQuery(["true"]), { ok: true, recursive: true });
  for (const values of [["false"], ["1"], ["TRUE"], [""], [" true"], ["true", "true"], ["true", "false"]]) {
    assert.deepEqual(parseRecursiveQuery(values), { ok: false }, JSON.stringify(values));
  }
});

test("delete dir removes an empty directory without recursive", async () => {
  const root = makeRoot("delete-dir-empty");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "nested", "empty"), { recursive: true });

    const response = await removeDir(service.app, "?path=empty");
    assert.equal(response.status, 204);
    assert.equal(response.text, "", "成功は本文なし");
    assert.equal(await exists(join(root, "empty")), false);

    // recursive=true でも空ディレクトリは消える (同じ導線で扱える)
    const recursive = await removeDir(service.app, `?path=${encodeURIComponent("nested/empty")}&recursive=true`);
    assert.equal(recursive.status, 204);
    assert.equal(await exists(join(root, "nested", "empty")), false);
    assert.equal(await exists(join(root, "nested")), true, "親は残る");
  } finally {
    service.close();
  }
});

test("delete dir rejects a non-empty directory without recursive and deletes nothing", async () => {
  const root = makeRoot("delete-dir-nonempty");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB", "nested"), { recursive: true });
    await writeFile(join(root, "dirB", "nested", "stay.txt"), "x");
    await writeFile(join(root, "dirB", "top.txt"), "y");

    const response = await removeDir(service.app, "?path=dirB");
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /not empty/);
    assert.equal(await exists(join(root, "dirB", "top.txt")), true, "部分削除もしない");
    assert.equal(await exists(join(root, "dirB", "nested", "stay.txt")), true);
  } finally {
    service.close();
  }
});

test("delete dir removes the whole subtree with recursive=true", async () => {
  const root = makeRoot("delete-dir-recursive");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "a", "deep", "deeper"), { recursive: true });
    await writeFile(join(root, "a", "deep", "deeper", "x.txt"), "x");
    await mkdir(join(root, "ab"), { recursive: true });
    await writeFile(join(root, "ab", "keep.txt"), "keep");
    await writeFile(join(root, "a-file.txt"), "keep");

    const response = await removeDir(service.app, `?path=${encodeURIComponent("a")}&recursive=true`);
    assert.equal(response.status, 204);
    assert.equal(await exists(join(root, "a")), false);
    // 受け入れ条件: `a` の削除で接頭辞が同じ `ab` を巻き込まない
    assert.equal(await exists(join(root, "ab", "keep.txt")), true);
    assert.equal(await exists(join(root, "a-file.txt")), true);
  } finally {
    service.close();
  }
});

test("delete dir rejects recursive values that are not exactly true, deleting nothing", async () => {
  const root = makeRoot("delete-dir-recursive-invalid");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");

    const queries = [
      "?path=dirB&recursive=false",
      "?path=dirB&recursive=1",
      "?path=dirB&recursive=TRUE",
      "?path=dirB&recursive=",
      "?path=dirB&recursive=true&recursive=true",
      "?path=dirB&recursive=true&recursive=false",
    ];
    for (const query of queries) {
      const response = await removeDir(service.app, query);
      assert.equal(response.status, 400, query);
      assert.match(response.body.error ?? "", /recursive/, query);
      assert.equal(await exists(join(root, "dirB", "stay.txt")), true, query);
    }
  } finally {
    service.close();
  }
});

test("delete dir validates the path form and the target kind without deleting anything", async () => {
  const root = makeRoot("delete-dir-validate");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");
    await writeFile(join(root, "note.txt"), "y");

    // root 自身 ("." / 空 / 省略) と、削除対象の名前を表さない形式は、再帰でも 400
    for (const path of ["", ".", "..", "dirB/..", "dirB/", "./"]) {
      const response = await removeDir(service.app, `?path=${encodeURIComponent(path)}&recursive=true`);
      assert.equal(response.status, 400, `path=${JSON.stringify(path)}`);
      assert.match(response.body.error ?? "", /Not a directory/, `path=${JSON.stringify(path)}`);
    }
    assert.equal((await removeDir(service.app, "?recursive=true")).status, 400, "path 省略は root なので 400");

    // 通常ファイルは 400 (DELETE /v1/files の担当)
    const file = await removeDir(service.app, "?path=note.txt&recursive=true");
    assert.equal(file.status, 400);
    assert.match(file.body.error ?? "", /Not a directory/);

    // 実在しないパスは 404
    const missing = await removeDir(service.app, "?path=nope&recursive=true");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error ?? "", /Path not found/);

    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
    assert.equal(await exists(join(root, "note.txt")), true);
  } finally {
    service.close();
  }
});

test("delete dir rejects paths outside the workspace", async () => {
  const base = makeRoot("delete-dir-outside");
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(base, "outsideDir"), { recursive: true });
    await writeFile(join(base, "outsideDir", "keep.txt"), "keep");

    for (const path of ["../outsideDir", "../missingDir", "/etc"]) {
      const response = await removeDir(service.app, `?path=${encodeURIComponent(path)}&recursive=true`);
      assert.equal(response.status, 400, path);
      assert.match(response.body.error ?? "", /outside the workspace/, path);
    }
    assert.equal(await exists(join(base, "outsideDir", "keep.txt")), true);
  } finally {
    service.close();
  }
});

test(
  "delete dir rejects a symlinked final element without touching the target",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("delete-dir-symlink");
    const outside = makeRoot("delete-dir-symlink-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "real"), { recursive: true });
      await writeFile(join(root, "real", "keep.txt"), "x");
      await mkdir(join(outside, "target"), { recursive: true });
      await symlink(join(root, "real"), join(root, "linkInside"));
      await symlink(join(outside, "target"), join(root, "linkOutside"));
      await symlink(join(root, "gone"), join(root, "linkBroken"));

      for (const path of ["linkInside", "linkOutside", "linkBroken"]) {
        const response = await removeDir(service.app, `?path=${path}&recursive=true`);
        assert.equal(response.status, 400, path);
        assert.match(response.body.error ?? "", /Symbolic links cannot be deleted/, path);
      }
      // リンクも指し先も残る (root 外の実体を消していない)
      assert.equal(await exists(join(root, "linkInside")), true);
      assert.equal(await exists(join(root, "real", "keep.txt")), true);
      assert.equal(await exists(join(outside, "target")), true);
    } finally {
      service.close();
    }
  },
);

test(
  "delete dir unlinks symlinks under the directory and keeps their targets",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("delete-dir-symlink-inside");
    const outside = makeRoot("delete-dir-symlink-inside-outside");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    try {
      await mkdir(join(root, "tree"), { recursive: true });
      await writeFile(join(root, "tree", "keep.txt"), "x");
      await writeFile(join(outside, "target.txt"), "outside");
      await symlink(join(outside, "target.txt"), join(root, "tree", "linkOut"));
      await symlink(join(root, "tree", "keep.txt"), join(root, "tree", "linkIn"));

      const response = await removeDir(service.app, "?path=tree&recursive=true");
      assert.equal(response.status, 204, response.body.error ?? "");
      assert.equal(await exists(join(root, "tree")), false);
      // 配下の symlink はリンクだけ unlink され、リンク先は残る (rm -rf と同じ)
      assert.equal(await exists(join(outside, "target.txt")), true);
    } finally {
      service.close();
    }
  },
);

test("delete dir removes children that the listing cap hides", async () => {
  const root = makeRoot("delete-dir-cap");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "many"), { recursive: true });
    const names = Array.from({ length: SANDBOX_MAX_FILE_ENTRIES + 1 }, (_, index) => `f${index}.txt`);
    await Promise.all(names.map((name) => writeFile(join(root, "many", name), "x")));

    const listed = await service.app.request("/v1/files?path=many", { headers: authHeaders() });
    assert.equal(listed.status, 200);
    assert.equal(
      ((await listed.json()) as { truncated: boolean }).truncated,
      true,
      "一覧の上限を超えることを前提にする",
    );

    // 受け入れ条件: 削除範囲は一覧の上限に縛られない
    const response = await removeDir(service.app, "?path=many&recursive=true");
    assert.equal(response.status, 204, response.body.error ?? "");
    assert.equal(await exists(join(root, "many")), false);
  } finally {
    service.close();
  }
});

test("delete dir handles Object.prototype names", async () => {
  const root = makeRoot("delete-dir-proto");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "__proto__", "child"), { recursive: true });
    await writeFile(join(root, "__proto__", "child", "x.txt"), "x");

    const response = await removeDir(service.app, `?path=${encodeURIComponent("__proto__")}&recursive=true`);
    assert.equal(response.status, 204, response.body.error ?? "");
    assert.equal(await exists(join(root, "__proto__")), false);
  } finally {
    service.close();
  }
});

test("delete dir requires the bearer token", async () => {
  const root = makeRoot("delete-dir-auth");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "dirB", "stay.txt"), "x");
    assert.equal((await service.app.request("/v1/dirs?path=dirB&recursive=true", { method: "DELETE" })).status, 401);
    assert.equal(
      (
        await service.app.request("/v1/dirs?path=dirB&recursive=true", {
          method: "DELETE",
          headers: { Authorization: "Bearer wrong-token-0123456789abcdef" },
        })
      ).status,
      401,
    );
    assert.equal(await exists(join(root, "dirB", "stay.txt")), true);
  } finally {
    service.close();
  }
});
