import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import { SANDBOX_MAX_PREVIEW_BYTES } from "../src/sandbox/protocol";

/**
 * GET /v1/files/stat。通常ファイルの実在だけを 200 で返し、不存在は 404、不正入力・root 外・
 * 通常ファイル以外は 400。本文を読まないため、テキストプレビュー固有の 400 (バイナリ / UTF-8 不正 /
 * 上限超過) は混ざらない。
 */
test("stat は通常ファイルだけを 200 で返し、不存在と拒否を分ける", async () => {
  const root = await mkdtemp(join(tmpdir(), "stat-"));
  const outside = await mkdtemp(join(tmpdir(), "stat-outside-"));
  const token = "test-stat-token-0123456789";
  const service = createSandboxService({ rootCwd: root, token });
  const request = (path: string) =>
    service.app.request(`/v1/files/stat?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    await writeFile(join(root, "text"), "hello");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "b.txt"), "b");
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "invalid"), Buffer.from([255]));
    await writeFile(join(root, "large"), "a".repeat(SANDBOX_MAX_PREVIEW_BYTES + 1));
    await writeFile(join(outside, "outside.txt"), "x");
    await symlink(join(root, "text"), join(root, "link"));
    await symlink(join(outside, "outside.txt"), join(root, "escaped"));
    await symlink(join(root, "missing"), join(root, "broken"));

    assert.deepEqual(await (await request("text")).json(), { path: "text" });
    assert.deepEqual(await (await request("nested/b.txt")).json(), { path: "nested/b.txt" });
    // root 内を指す symlink は辿った先の実パスを返す (一覧の path と同じ扱い)
    assert.deepEqual(await (await request("link")).json(), { path: "text" });
    // 本文を読まないので、プレビューでは 400 になる実体も「通常ファイルとして実在」で通る
    for (const path of ["binary", "invalid", "large"]) {
      assert.equal((await request(path)).status, 200, path);
    }

    // 不存在は 404 (壊れた symlink も実在しない)
    for (const path of ["missing", "broken"]) {
      assert.equal((await request(path)).status, 404, path);
    }
    // ディレクトリ・root 自身・root 外・壊れた要求は 400 (実在の確認に使わせない)
    for (const path of ["nested", ".", "", "../outside.txt", "escaped", "nested/..", "nested\u0000x"]) {
      const response = await request(path);
      assert.equal(response.status, 400, path);
      assert.equal(typeof ((await response.json()) as { error?: string }).error, "string", path);
    }
    assert.equal((await service.app.request("/v1/files/stat?path=text")).status, 401);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
