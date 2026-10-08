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

test("raw streams allowlisted images and audio with their type and length", async () => {
  const root = await makeRoot("raw");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "logo.PNG"), png);
    await writeFile(join(root, "uploads", "bgm.MP3"), mp3);

    const image = await service.app.request("/v1/files/raw?path=uploads%2Flogo.PNG", { headers: authHeaders() });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("content-length"), String(png.byteLength));
    assert.equal(image.headers.get("accept-ranges"), "bytes");
    assert.equal(image.headers.get("cache-control"), "no-store");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    const audio = await service.app.request("/v1/files/raw?path=uploads%2Fbgm.MP3", { headers: authHeaders() });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.equal(audio.headers.get("content-length"), String(mp3.byteLength));
    assert.equal(audio.headers.get("accept-ranges"), "bytes");
    assert.equal(audio.headers.get("cache-control"), "no-store");
    assert.equal(audio.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), mp3);
  } finally {
    service.close();
  }
});

/** range 付きの raw 要求。応答本文はバイト列で返す (音声も画像も同じ経路)。 */
async function rawRange(
  app: App,
  path: string,
  range: string,
): Promise<{ status: number; contentRange: string | null; bytes: Buffer }> {
  const response = await app.request(`/v1/files/raw?path=${encodeURIComponent(path)}`, {
    headers: { ...authHeaders(), Range: range },
  });
  return {
    status: response.status,
    contentRange: response.headers.get("content-range"),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

test("raw serves a single byte range with 206 and Content-Range", async () => {
  const root = await makeRoot("raw-range");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "clip.mp3"), Buffer.from("abcdefgh"));

    // 先頭 / 中間 / 末尾開放 / 末尾 N バイト / 末尾を超える end は、
    // 実在する範囲へ丸めて 206 と `bytes <start>-<end>/<size>` を返す
    const cases: Array<[string, string, string]> = [
      ["bytes=0-1", "bytes 0-1/8", "ab"],
      ["bytes=2-5", "bytes 2-5/8", "cdef"],
      ["bytes=5-", "bytes 5-7/8", "fgh"],
      ["bytes=-3", "bytes 5-7/8", "fgh"],
      ["bytes=-100", "bytes 0-7/8", "abcdefgh"],
      ["bytes=6-100", "bytes 6-7/8", "gh"],
      ["bytes=0-0", "bytes 0-0/8", "a"],
      // 先頭の 0 は無視し、桁が大きくても size と比較できる (16 桁以上は size より大きい)
      ["bytes=0000000000000000000002-3", "bytes 2-3/8", "cd"],
      ["bytes=0-999999999999999999999999", "bytes 0-7/8", "abcdefgh"],
    ];
    for (const [range, contentRange, expected] of cases) {
      const response = await service.app.request("/v1/files/raw?path=uploads%2Fclip.mp3", {
        headers: { ...authHeaders(), Range: range },
      });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get("content-range"), contentRange, range);
      assert.equal(response.headers.get("accept-ranges"), "bytes", range);
      assert.equal(response.headers.get("content-type"), "audio/mpeg", range);
      assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(expected)), range);
      assert.equal(response.headers.get("cache-control"), "no-store", range);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", range);
      assert.equal(Buffer.from(await response.arrayBuffer()).toString(), expected, range);
    }

    // 画像も同じ経路で部分取得できる
    await writeFile(join(root, "uploads", "icon.png"), Buffer.from([1, 2, 3, 4]));
    const image = await service.app.request("/v1/files/raw?path=uploads%2Ficon.png", {
      headers: { ...authHeaders(), Range: "bytes=1-2" },
    });
    assert.equal(image.status, 206);
    assert.equal(image.headers.get("content-range"), "bytes 1-2/4");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([2, 3]));
  } finally {
    service.close();
  }
});

test("raw answers 416 only when the range cannot be satisfied", async () => {
  const root = await makeRoot("raw-range-416");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "clip.mp3"), Buffer.from("abcdefgh"));
    await writeFile(join(root, "uploads", "empty.wav"), Buffer.alloc(0));

    for (const range of ["bytes=8-", "bytes=100-200", "bytes=-0", "bytes=99999999999999999999-"]) {
      const response = await rawRange(service.app, "uploads/clip.mp3", range);
      assert.equal(response.status, 416, range);
      // 416 は「全体の長さ」を Content-Range で伝える (ブラウザーはこれで分割を取り直す)
      assert.equal(response.contentRange, "bytes */8", range);
    }
    // 0 バイトのファイルはどの範囲も満たせない
    const empty = await rawRange(service.app, "uploads/empty.wav", "bytes=0-");
    assert.equal(empty.status, 416);
    assert.equal(empty.contentRange, "bytes */0");
    // Range 無しの 0 バイトは従来どおり 200
    const whole = await service.app.request("/v1/files/raw?path=uploads%2Fempty.wav", { headers: authHeaders() });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-length"), "0");
  } finally {
    service.close();
  }
});

test("raw ignores a Range it cannot interpret and answers 200", async () => {
  const root = await makeRoot("raw-range-ignore");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "clip.mp3"), Buffer.from("abcdefgh"));

    // 構文不正 (先頭 > 末尾 / 空 / 数字以外)・複数レンジ・bytes 以外の単位は、レンジ指定なしに倒す
    const cases = [
      "bytes=5-4",
      "bytes=",
      "bytes=-",
      "bytes=abc",
      "bytes=0-1-2",
      "bytes=0-1,3-4",
      "items=0-1",
      "bytes = 0-1",
    ];
    for (const range of cases) {
      const response = await service.app.request("/v1/files/raw?path=uploads%2Fclip.mp3", {
        headers: { ...authHeaders(), Range: range },
      });
      assert.equal(response.status, 200, range);
      assert.equal(response.headers.get("content-range"), null, range);
      assert.equal(response.headers.get("accept-ranges"), "bytes", range);
      assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "abcdefgh", range);
    }
  } finally {
    service.close();
  }
});

test("raw maps each allowlisted audio extension to its Content-Type", async () => {
  const root = await makeRoot("raw-audio");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    const cases: Array<[string, string]> = [
      ["bgm.mp3", "audio/mpeg"],
      ["song.m4a", "audio/mp4"],
      ["voice.ogg", "audio/ogg"],
      ["voice.oga", "audio/ogg"],
      ["beat.wav", "audio/wav"],
      ["master.flac", "audio/flac"],
    ];
    for (const [name, contentType] of cases) {
      await writeFile(join(root, "uploads", name), Buffer.from([1]));
      const response = await service.app.request(`/v1/files/raw?path=${encodeURIComponent(`uploads/${name}`)}`, {
        headers: authHeaders(),
      });
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), contentType, name);
    }
  } finally {
    service.close();
  }
});

test("raw rejects non-allowlisted extensions, missing files and oversize images or audio", async () => {
  const root = await makeRoot("raw-reject");
  const service = createSandboxService({ token: TOKEN, rootCwd: root, maxUploadBytes: 4 });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "page.html"), "<h1>x</h1>");
    await writeFile(join(root, "uploads", "vector.svg"), "<svg/>");
    await writeFile(join(root, "uploads", "big.png"), Buffer.alloc(5));
    await writeFile(join(root, "uploads", "big.mp3"), Buffer.alloc(5));
    await writeFile(join(root, "uploads", ".mp3"), Buffer.alloc(1));

    const notFile = await service.app.request("/v1/files/raw?path=uploads%2Fpage.html", { headers: authHeaders() });
    assert.equal(notFile.status, 400);
    assert.match(((await notFile.json()) as { error: string }).error, /^Not a servable file: /);
    const svg = await service.app.request("/v1/files/raw?path=uploads%2Fvector.svg", { headers: authHeaders() });
    assert.equal(svg.status, 400);
    // dotfile は拡張子なしと同じで、Object.prototype の名前も allowlist を通過させない
    for (const name of [".mp3", "x.constructor", "x.__proto__"]) {
      const prototypeKey = await service.app.request(`/v1/files/raw?path=${encodeURIComponent(`uploads/${name}`)}`, {
        headers: authHeaders(),
      });
      assert.equal(prototypeKey.status, 400, name);
    }
    const missing = await service.app.request("/v1/files/raw?path=uploads%2Fnope.png", { headers: authHeaders() });
    assert.equal(missing.status, 404);
    for (const name of ["big.png", "big.mp3"]) {
      const tooLarge = await service.app.request(`/v1/files/raw?path=uploads%2F${name}`, { headers: authHeaders() });
      assert.equal(tooLarge.status, 413, name);
      assert.deepEqual(await tooLarge.json(), { error: "File is too large (max 4 bytes)" }, name);
    }
    const outside = await service.app.request("/v1/files/raw?path=..%2Fpage.png", { headers: authHeaders() });
    assert.equal(outside.status, 400);
    const directory = await service.app.request("/v1/files/raw?path=uploads", { headers: authHeaders() });
    assert.equal(directory.status, 400, "拡張子のないディレクトリは allowlist で先に弾く");
  } finally {
    service.close();
  }
});
