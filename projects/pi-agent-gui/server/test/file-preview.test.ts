import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";

test("preview accepts bounded UTF-8 files and rejects unsafe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-"));
  const token = "test-preview-token-0123456789";
  const service = createSandboxService({ rootCwd: root, token });
  const request = (path: string) =>
    service.app.request(`/v1/files/preview?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    await writeFile(join(root, "text"), "日本語\n<script>alert(1)</script>");
    await writeFile(join(root, "empty"), "");
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "invalid"), Buffer.from([255]));
    await writeFile(join(root, "large"), "a".repeat(256 * 1024 + 1));
    await symlink(tmpdir(), join(root, "outside"));
    assert.deepEqual(await (await request("text")).json(), { text: "日本語\n<script>alert(1)</script>" });
    assert.deepEqual(await (await request("empty")).json(), { text: "" });
    for (const path of ["binary", "invalid", "large", ".", "outside", "../missing"])
      assert.equal((await request(path)).status, 400, path);
    assert.equal((await request("missing")).status, 404);
    assert.equal((await service.app.request("/v1/files/preview?path=text")).status, 401);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
