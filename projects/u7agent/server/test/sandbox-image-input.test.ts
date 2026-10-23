// GET /v1/files/image-input。公開 raw とは別経路で、許可範囲 (scope) と実バイト判定を実ファイルシステムで検証する。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("開いた実体の実パスを引き直せないときは読取を拒否する（fail-open にしない）", async () => {
  const root = await makeRoot("image-input-verify");
  const bytes = pngBytes();
  try {
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "a.png"), bytes);

    // open 後にリンク先が消えた / 解決できない状況。範囲を確かめられないので 200 を返さない
    const unverified = createSandboxService({
      token: TOKEN,
      rootCwd: root,
      resolveOpenedImageInputPath: async () => undefined,
    });
    try {
      const response = await request(unverified.app, "generated/a.png", [""]);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /Cannot verify the opened image input/);
    } finally {
      unverified.close();
    }

    // 引き直した実パスが許可範囲の外なら（symlink 差し替えの競合）本文を返さない
    const swapped = createSandboxService({
      token: TOKEN,
      rootCwd: root,
      resolveOpenedImageInputPath: async () => join(root, "other.png"),
    });
    try {
      const response = await request(swapped.app, "generated/a.png", ["generated"]);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /left the image input scope/);
    } finally {
      swapped.close();
    }

    // 解決済みの実パスが workspace の外を指す場合も返さない
    const escaped = createSandboxService({
      token: TOKEN,
      rootCwd: root,
      resolveOpenedImageInputPath: async () => join(tmpdir(), "outside.png"),
    });
    try {
      const response = await request(escaped.app, "generated/a.png", ["generated"]);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /left the workspace/);
    } finally {
      escaped.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FIFO は開いて止まらずに拒み、並列要求を abort しても他の読み取りを塞がない", async (t) => {
  const root = await makeRoot("image-input-fifo");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  try {
    await mkdir(join(root, "generated"), { recursive: true });
    const names = ["a.png", "b.png", "c.png", "d.png"];
    try {
      for (const name of names) execFileSync("mkfifo", [join(root, "generated", name)]);
    } catch {
      t.skip("mkfifo が無い環境では FIFO を作れない");
      return;
    }
    await writeFile(join(root, "normal.txt"), "ok");

    // writer のいない FIFO を同時に指定し、全 request を abort する。blocking open だと
    // ここで FS worker が埋まり、無関係な readFile が終わらない（期限で落ちる）
    const controllers = names.map(() => new AbortController());
    const pending = names.map((name, index) =>
      service.app.request(imageInputPath(`generated/${name}`, [""]), {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: controllers[index]!.signal,
      }),
    );
    for (const controller of controllers) controller.abort();

    const settled = await Promise.race([
      Promise.allSettled(pending),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("FIFO 要求が終わらない")), 3000)),
    ]);
    for (const result of settled) {
      if (result.status === "rejected") continue;
      assert.notEqual(result.value.status, 200, "FIFO を画像として返している");
    }

    const text = await Promise.race([
      readFile(join(root, "normal.txt"), "utf8"),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("readFile が終わらない")), 3000)),
    ]);
    assert.equal(text, "ok");
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
