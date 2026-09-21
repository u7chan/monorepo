// 静的配信と SPA フォールバックの表。status だけでなく、配信する本文とヘッダまで固定する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";

const INDEX_HTML = "<html><body>index</body></html>";
/** 実際のブラウザーが送る複合 Accept */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

type Request = (path: string, init?: RequestInit) => Response | Promise<Response>;

/** 一時 dist を作り、BFF 経由で要求する。`files` のキーは dist からの相対パス。 */
async function withDist(files: Record<string, string>, run: (request: Request) => Promise<void>): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), "bff-spa-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = join(distDir, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    }
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, clientDistDir: distDir });
    try {
      await run((path, init) => bff.app.request(path, init));
    } finally {
      await bff.close();
    }
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
}

/** フォールバックが返す index.html の契約 (`/` と同じ本文・ヘッダ) */
async function assertIndexResponse(response: Response, message: string): Promise<void> {
  assert.equal(response.status, 200, message);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", message);
  assert.equal(response.headers.get("cache-control"), "no-cache", message);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", message);
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/, message);
  assert.equal(await response.text(), INDEX_HTML, message);
}

async function assertNotFound(response: Response, message: string): Promise<void> {
  assert.equal(response.status, 404, message);
  assert.equal(response.headers.get("cache-control"), null, message);
  assert.deepEqual(await response.json(), { error: "Not found" }, message);
}

test("page-like GET requests fall back to index.html", async () => {
  await withDist({ "index.html": INDEX_HTML, "assets/app.js": "console.log(1);" }, async (request) => {
    // 末尾スラッシュ・大文字でない未知パス・`/apix` (API と別境界)・`/assetsx` (assets と別境界)・query 付き
    const paths = ["/settings/agents", "/settings/files/", "/foo", "/apix", "/assetsx", "/settings/files?tab=1"];
    const results = await Promise.all(paths.map((path) => request(path, { headers: { Accept: BROWSER_ACCEPT } })));
    for (const [index, response] of results.entries()) {
      await assertIndexResponse(response, paths[index]);
    }

    // HEAD は GET と同じ扱い (本文は無い)
    const head = await request("/settings/files", { method: "HEAD", headers: { Accept: BROWSER_ACCEPT } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(head.headers.get("cache-control"), "no-cache");
    assert.equal(await head.text(), "");
  });
});

test("paths that name no file stay 404", async () => {
  await withDist({ "index.html": INDEX_HTML, "robots.txt": "User-agent: *" }, async (request) => {
    const paths = [
      // 拡張子あり・dotfile・末尾ドット
      "/nope.txt",
      "/nope.",
      "/.hidden",
      "/a/b.c/",
      // API と assets は prefix そのものと配下を区別する
      "/api",
      "/api/",
      "/api/unknown",
      "/assets",
      "/assets/",
      "/assets/missing",
    ];
    const results = await Promise.all(paths.map((path) => request(path, { headers: { Accept: BROWSER_ACCEPT } })));
    for (const [index, response] of results.entries()) {
      await assertNotFound(response, paths[index]);
    }

    // 既存の静的ファイルは index.html に化けない
    const robots = await request("/robots.txt", { headers: { Accept: BROWSER_ACCEPT } });
    assert.equal(robots.status, 200);
    assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await robots.text(), "User-agent: *");

    // POST は対象外 (Hono の GET ルートに乗らない)
    await assertNotFound(
      await request("/settings/files", { method: "POST", headers: { Accept: BROWSER_ACCEPT } }),
      "POST",
    );
  });
});

test("only text/html with q>0 falls back", async () => {
  await withDist({ "index.html": INDEX_HTML }, async (request) => {
    const accepted = ["text/html", "text/html;q=0.1", "TEXT/HTML", BROWSER_ACCEPT, "application/json, text/html"];
    for (const accept of accepted) {
      await assertIndexResponse(await request("/settings/files", { headers: { Accept: accept } }), accept);
    }

    const rejected = [
      undefined,
      "application/json",
      "*/*",
      "text/html;q=0",
      "text/html;q=0.0",
      "text/html;q=0, application/json",
      "text/plain, text/html;q=0",
    ];
    for (const accept of rejected) {
      const response = await request("/settings/files", accept ? { headers: { Accept: accept } } : undefined);
      await assertNotFound(response, String(accept));
    }
  });
});

test("invalid encoding and traversal are 404 even without an extension", async () => {
  await withDist({ "index.html": INDEX_HTML }, async (request) => {
    const paths = [
      "/%zz",
      "/%E0%A4%A",
      "/%2e%2e%2fsecret.txt",
      // 拡張子なしでも traversal は静的解決の guard で落ちる
      "/%2e%2e%2fsecret",
      // %2F で絶対パス / API prefix の境界を迂回させない
      "/%2Fsecret",
      "/%2Fapi%2Funknown",
      "/api%2Funknown",
      "/assets%2Fmissing",
    ];
    const results = await Promise.all(paths.map((path) => request(path, { headers: { Accept: BROWSER_ACCEPT } })));
    for (const [index, response] of results.entries()) {
      await assertNotFound(response, paths[index]);
    }
  });
});

test("existing hashed assets keep the immutable cache", async () => {
  await withDist({ "index.html": INDEX_HTML, "assets/app.js": "console.log(1);" }, async (request) => {
    const asset = await request("/assets/app.js", { headers: { Accept: BROWSER_ACCEPT } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await asset.text(), "console.log(1);");
  });
});

test("missing client build answers 503 for page URLs too", async () => {
  await withDist({}, async (request) => {
    for (const path of ["/", "/settings/files"]) {
      const response = await request(path, { headers: { Accept: BROWSER_ACCEPT } });
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8", path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
      assert.match(await response.text(), /Client build missing/, path);
    }

    // 拡張子ありはビルドが無くても index.html を返さない
    await assertNotFound(await request("/nope.txt", { headers: { Accept: BROWSER_ACCEPT } }), "/nope.txt");
  });
});
