// GET /v1/files/image-input。公開 raw とは別経路で、許可範囲 (scope) と実バイト判定を実ファイルシステムで検証する。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IMAGE_INPUT_MAX_BYTES } from "../src/image-format";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-sbx-${prefix}-`));
}

/** IHDR だけを持つ PNG（高さ 2 / 幅 3） */
function pngBytes(width = 3, height = 2): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageInputPath(path: string, scopes: readonly string[]): string {
  const query = new URLSearchParams({ path });
  for (const scope of scopes) query.append("scope", scope);
  return `/v1/files/image-input?${query.toString()}`;
}

async function request(app: App, path: string, scopes: readonly string[]): Promise<Response> {
  return app.request(imageInputPath(path, scopes), { headers: { Authorization: `Bearer ${TOKEN}` } });
}

test("scope 内の画像は拡張子に関係なく実バイトで通る", async () => {
  const root = await makeRoot("image-input");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "projects", "app", "generated"), { recursive: true });
    const bytes = pngBytes();
    await writeFile(join(root, "projects", "app", "generated", "portrait.bin"), bytes);
    const response = await request(service.app, "projects/app/generated/portrait.bin", [
      "projects/app",
      ".u7agent/uploads/0123456789",
    ]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(bytes));
  } finally {
    service.close();
  }
});

test("scope の外・存在しない範囲は 400、未作成の添付置き場は無視する", async () => {
  const root = await makeRoot("image-input-scope");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "projects", "app"), { recursive: true });
    await mkdir(join(root, "projects", "other"), { recursive: true });
    await writeFile(join(root, "projects", "app", "a.png"), pngBytes());
    await writeFile(join(root, "projects", "other", "b.png"), pngBytes());

    // 未作成の添付置き場は範囲に加えない（cwd だけが有効）
    assert.equal(
      (await request(service.app, "projects/app/a.png", ["projects/app", ".u7agent/uploads/x"])).status,
      200,
    );
    // cwd の外は範囲外
    const outside = await request(service.app, "projects/other/b.png", ["projects/app"]);
    assert.equal(outside.status, 400);
    assert.match(((await outside.json()) as { error: string }).error, /image input scope/);
    // 範囲を 1 つも渡さない / 実在しない範囲だけは 400
    assert.equal((await request(service.app, "projects/app/a.png", [])).status, 400);
    assert.equal((await request(service.app, "projects/app/a.png", [".u7agent/uploads/x"])).status, 400);
  } finally {
    service.close();
  }
});

test("root 外・workspace 外を指す symlink は範囲判定で拒む", async () => {
  const root = await makeRoot("image-input-link");
  const outside = await makeRoot("image-input-outside");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(outside, "secret.png"), pngBytes());
    await mkdir(join(root, "projects", "app"), { recursive: true });
    await symlink(join(outside, "secret.png"), join(root, "projects", "app", "link.png"));
    await symlink(join(root, "projects", "app"), join(root, "projects", "app", "inner"));
    await writeFile(join(root, "projects", "app", "inner", "ok.png"), pngBytes());

    // 範囲内を指す symlink は範囲内として通す（実パスで判定する）
    assert.equal((await request(service.app, "projects/app/inner/ok.png", ["projects/app"])).status, 200);
    const outsideLink = await request(service.app, "projects/app/link.png", ["projects/app"]);
    assert.equal(outsideLink.status, 400);
    assert.match(((await outsideLink.json()) as { error: string }).error, /outside the workspace/);
  } finally {
    service.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("画像でない実体・壊れたヘッダ・上限超過は課金前に 400 / 413 で拒む", async () => {
  const root = await makeRoot("image-input-invalid");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "fake.png"), "<html>not an image</html>");
    await writeFile(join(root, "generated", "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, "generated", "huge.png"), Buffer.alloc(IMAGE_INPUT_MAX_BYTES + 1));
    await writeFile(join(root, "generated", "tall.png"), pngBytes(20_000, 20_000));
    await mkdir(join(root, "generated", "dir.png"));

    const scopes = [""];
    for (const [path, status, pattern] of [
      ["generated/fake.png", 400, /Not a supported image/],
      ["generated/broken.png", 400, /Not a supported image/],
      ["generated/huge.png", 413, /too large/],
      ["generated/tall.png", 413, /megapixels/],
      ["generated/dir.png", 400, /Not a regular file/],
      ["generated/missing.png", 404, /Path not found/],
      ["../outside.png", 400, /outside the workspace/],
    ] as const) {
      const response = await request(service.app, path, scopes);
      assert.equal(response.status, status, path);
      assert.match(((await response.json()) as { error: string }).error, pattern, path);
    }
  } finally {
    service.close();
  }
});

test("scope は 8 個まで。path 欠落は 400", async () => {
  const root = await makeRoot("image-input-limit");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await writeFile(join(root, "a.png"), pngBytes());
    assert.equal(
      (await service.app.request("/v1/files/image-input", { headers: { Authorization: `Bearer ${TOKEN}` } })).status,
      400,
    );
    const tooMany = await request(
      service.app,
      "a.png",
      Array.from({ length: 9 }, () => ""),
    );
    assert.equal(tooMany.status, 400);
    assert.match(((await tooMany.json()) as { error: string }).error, /Too many scopes/);
  } finally {
    service.close();
  }
});
