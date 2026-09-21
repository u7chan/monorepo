// POST /v1/files/upload と GET /v1/files/raw。実ファイルシステムを使い、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import type { SandboxFileUpload } from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-sbx-${prefix}-`));
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function upload(
  app: App,
  options: { dir?: string; name?: string; body?: string },
): Promise<{ status: number; body: SandboxFileUpload & { error?: string } }> {
  const query = new URLSearchParams();
  if (options.dir !== undefined) query.set("dir", options.dir);
  if (options.name !== undefined) query.set("name", options.name);
  const response = await app.request(`/v1/files/upload?${query.toString()}`, {
    method: "POST",
    headers: authHeaders(),
    body: options.body ?? "hello",
  });
  return { status: response.status, body: (await response.json()) as SandboxFileUpload & { error?: string } };
}

test("upload writes the body under the requested directory", async () => {
  const root = await makeRoot("upload");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const result = await upload(service.app, { dir: "uploads", name: "note.txt", body: "hello upload" });
    assert.equal(result.status, 201);
    assert.equal(result.body.path, "uploads/note.txt");
    assert.equal(result.body.name, "note.txt");
    assert.equal(result.body.renamed, false);
    assert.equal(result.body.size, 12);
    assert.equal(await readFile(join(root, "uploads", "note.txt"), "utf8"), "hello upload");
    // temp (`.part`) を残さない
    assert.deepEqual(await readdir(join(root, "uploads")), ["note.txt"]);
  } finally {
    service.close();
  }
});

test("upload never overwrites an existing file and keeps numbering", async () => {
  const root = await makeRoot("upload-rename");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "photo.png"), "original");

    const first = await upload(service.app, { dir: "uploads", name: "photo.png", body: "second" });
    assert.equal(first.status, 201);
    assert.equal(first.body.name, "photo-1.png");
    assert.equal(first.body.renamed, true);
    assert.equal(first.body.path, "uploads/photo-1.png");

    const second = await upload(service.app, { dir: "uploads", name: "photo.png", body: "third" });
    assert.equal(second.body.name, "photo-2.png");
    assert.equal(second.body.renamed, true);

    assert.equal(await readFile(join(root, "uploads", "photo.png"), "utf8"), "original");
    assert.equal(await readFile(join(root, "uploads", "photo-1.png"), "utf8"), "second");
    // 拡張子なしの名前も連番で衝突を避ける
    await upload(service.app, { dir: "uploads", name: "README", body: "a" });
    const noExt = await upload(service.app, { dir: "uploads", name: "README", body: "b" });
    assert.equal(noExt.body.name, "README-1");
  } finally {
    service.close();
  }
});

test("concurrent uploads of the same name do not overwrite each other", async () => {
  const root = await makeRoot("upload-concurrent");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const [a, b] = await Promise.all([
      upload(service.app, { dir: "uploads", name: "same.txt", body: "aaa" }),
      upload(service.app, { dir: "uploads", name: "same.txt", body: "bbb" }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.name, b.body.name);
    const names = (await readdir(join(root, "uploads"))).sort();
    assert.deepEqual(names, [a.body.name, b.body.name].sort());
  } finally {
    service.close();
  }
});

test("upload creates nested directories and rejects names that are not a basename", async () => {
  const root = await makeRoot("upload-name");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const nested = await upload(service.app, { dir: "a/b/uploads", name: "x.png", body: "x" });
    assert.equal(nested.status, 201);
    assert.equal(nested.body.path, "a/b/uploads/x.png");

    for (const name of ["", ".", "..", "dir/file.png", "dir\\file.png", "x".repeat(201), "bad\u0000name.png"]) {
      const rejected = await upload(service.app, { dir: "uploads", name, body: "x" });
      assert.equal(rejected.status, 400, `name=${JSON.stringify(name)} は 400`);
      assert.match(rejected.body.error ?? "", /Invalid file name/);
    }
    // 名前でディレクトリを動かせず、弾いた要求は dir も作らない
    assert.deepEqual(await readdir(root), ["a"]);
  } finally {
    service.close();
  }
});

test("upload rejects a directory outside the workspace and too large bodies", async () => {
  const root = await makeRoot("upload-reject");
  const service = createSandboxService({ token: TOKEN, rootCwd: root, maxUploadBytes: 8 });
  try {
    const outside = await upload(service.app, { dir: "../outside", name: "x.txt", body: "x" });
    assert.equal(outside.status, 400);
    assert.match(outside.body.error ?? "", /outside the workspace/);

    const tooLarge = await upload(service.app, { dir: "uploads", name: "big.bin", body: "0123456789" });
    assert.equal(tooLarge.status, 413);
    // 413 の後始末: 中断した temp も最終ファイルも残さない
    assert.deepEqual(await readdir(join(root, "uploads")), []);

    const fits = await upload(service.app, { dir: "uploads", name: "small.bin", body: "01234567" });
    assert.equal(fits.status, 201);
    assert.equal(fits.body.size, 8);
  } finally {
    service.close();
  }
});

test("raw streams an allowlisted image with its type and length", async () => {
  const root = await makeRoot("raw");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "logo.PNG"), png);

    const response = await service.app.request("/v1/files/raw?path=uploads%2Flogo.PNG", { headers: authHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(png.byteLength));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  } finally {
    service.close();
  }
});

test("raw rejects non-allowlisted extensions, missing files and oversize images", async () => {
  const root = await makeRoot("raw-reject");
  const service = createSandboxService({ token: TOKEN, rootCwd: root, maxUploadBytes: 4 });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "page.html"), "<h1>x</h1>");
    await writeFile(join(root, "uploads", "vector.svg"), "<svg/>");
    await writeFile(join(root, "uploads", "big.png"), Buffer.alloc(5));

    const notImage = await service.app.request("/v1/files/raw?path=uploads%2Fpage.html", { headers: authHeaders() });
    assert.equal(notImage.status, 400);
    const svg = await service.app.request("/v1/files/raw?path=uploads%2Fvector.svg", { headers: authHeaders() });
    assert.equal(svg.status, 400);
    // Object.prototype の名前を拡張子にしたパスも allowlist を通過させない
    for (const name of ["x.constructor", "x.__proto__"]) {
      const prototypeKey = await service.app.request(`/v1/files/raw?path=${encodeURIComponent(`uploads/${name}`)}`, {
        headers: authHeaders(),
      });
      assert.equal(prototypeKey.status, 400, name);
    }
    const missing = await service.app.request("/v1/files/raw?path=uploads%2Fnope.png", { headers: authHeaders() });
    assert.equal(missing.status, 404);
    const tooLarge = await service.app.request("/v1/files/raw?path=uploads%2Fbig.png", { headers: authHeaders() });
    assert.equal(tooLarge.status, 413);
    const outside = await service.app.request("/v1/files/raw?path=..%2Fpage.png", { headers: authHeaders() });
    assert.equal(outside.status, 400);
    const directory = await service.app.request("/v1/files/raw?path=uploads", { headers: authHeaders() });
    assert.equal(directory.status, 400, "画像拡張子のないディレクトリは allowlist で先に弾く");
  } finally {
    service.close();
  }
});
