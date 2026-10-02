// `/api/files/html/<path>` の URL 組み立て。サーバー (Hono の `:path{.+}`) は 1 回だけ percent decoding するため、
// クライアント側でちょうど 1 回 encode されていることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { encodeFilePathParam } from "../src/lib/fileUrl";

test("ファイルパスはセグメント単位で encode し、区切りの / は残す", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["a.png", "a.png"],
    ["dir/a b.png", "dir/a%20b.png"],
    ["日本語/画像.png", "%E6%97%A5%E6%9C%AC%E8%AA%9E/%E7%94%BB%E5%83%8F.png"],
    // URL の区切りとして解釈される文字を生で残さない (`#` は fragment、`?` は query になる)
    ["a#b.txt", "a%23b.txt"],
    ["a?b.txt", "a%3Fb.txt"],
    ["a%b.txt", "a%25b.txt"],
    ["a+b.txt", "a%2Bb.txt"],
    ["a&b=c.txt", "a%26b%3Dc.txt"],
    // encode 済みの `%2F` を渡されても、区切りへ戻さず 1 回だけ encode する
    ["dir%2Ffile.js", "dir%252Ffile.js"],
    ["dir//a.js", "dir//a.js"],
    ["/a.js", "/a.js"],
    ["a.js/", "a.js/"],
  ];
  for (const [path, encoded] of cases) {
    assert.equal(encodeFilePathParam(path), encoded, path);
    // サーバー側の 1 回の decode で元のパスに戻る
    assert.equal(decodeURIComponent(encoded), path, path);
  }
});

test("fileRawUrl は version 指定時だけ v を付け、未指定時は従来の URL を保つ", async () => {
  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:5173", hostname: "localhost" },
    configurable: true,
  });
  const { fileRawUrl } = await import("../src/api");
  assert.equal(fileRawUrl("generated/cafe.png"), "http://localhost:5173/api/files/raw?path=generated%2Fcafe.png");
  assert.equal(fileRawUrl("generated/cafe.png", undefined), fileRawUrl("generated/cafe.png"));
  for (const path of ["generated/cafe.png", "日本語/画像.png", "a+b#c&v=99.png"]) {
    const original = new URL(fileRawUrl(path));
    assert.equal(original.searchParams.get("path"), path);
    assert.equal(original.searchParams.has("v"), false);
    for (const version of [0, 1, 42]) {
      const url = new URL(fileRawUrl(path, version));
      assert.equal(url.origin, original.origin);
      assert.equal(url.pathname, "/api/files/raw");
      assert.equal(url.searchParams.get("path"), path);
      assert.equal(url.searchParams.get("v"), String(version));
      url.searchParams.delete("v");
      assert.equal(url.toString(), original.toString());
    }
  }
});

test("fileHtmlPreviewUrl はクエリではなくパス形式で同一オリジンの URL を組み立てる", async () => {
  // api.ts は module の読み込み時に location.origin を参照する (node のテストには DOM が無い)
  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:5173", hostname: "localhost" },
    configurable: true,
  });
  const { fileHtmlPreviewUrl } = await import("../src/api");
  const cases: Array<[string, string]> = [
    ["a.html", "http://localhost:5173/api/files/html/a.html"],
    ["dir/a b.png", "http://localhost:5173/api/files/html/dir/a%20b.png"],
    ["a#b.txt", "http://localhost:5173/api/files/html/a%23b.txt"],
    ["a?b.txt", "http://localhost:5173/api/files/html/a%3Fb.txt"],
    ["日本語/画像.png", "http://localhost:5173/api/files/html/%E6%97%A5%E6%9C%AC%E8%AA%9E/%E7%94%BB%E5%83%8F.png"],
  ];
  for (const [path, url] of cases) assert.equal(fileHtmlPreviewUrl(path), url, path);
});

test("fileStoragePreviewUrl は hostname と health のポートで別オリジンの URL を組み立てる", async () => {
  // dev はアプリが Vite の 3000 に居るため、location.host (3000) ではなく hostname + health のポートを使う
  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:3000", hostname: "localhost" },
    configurable: true,
  });
  const { fileStoragePreviewUrl } = await import("../src/api");
  const cases: Array<[string, number, string]> = [
    ["a.html", 4318, "http://localhost:4318/api/files/html/a.html"],
    ["dir/a b.png", 8017, "http://localhost:8017/api/files/html/dir/a%20b.png"],
    ["a#b.txt", 4318, "http://localhost:4318/api/files/html/a%23b.txt"],
    [
      "日本語/画像.png",
      4318,
      "http://localhost:4318/api/files/html/%E6%97%A5%E6%9C%AC%E8%AA%9E/%E7%94%BB%E5%83%8F.png",
    ],
  ];
  for (const [path, port, url] of cases) assert.equal(fileStoragePreviewUrl(path, port), url, path);
});

test("fileDownloadUrl は path をクエリで渡し、サーバー側の 1 回の decode で元に戻る", async () => {
  Object.defineProperty(globalThis, "location", {
    value: { origin: "http://localhost:5173", hostname: "localhost" },
    configurable: true,
  });
  const { fileDownloadUrl } = await import("../src/api");
  for (const path of ["a.txt", "src/nested 日本語", "a+b#c.txt", ""]) {
    const url = new URL(fileDownloadUrl(path));
    assert.equal(url.origin, "http://localhost:5173");
    assert.equal(url.pathname, "/api/files/download", path);
    // クエリの `+` は searchParams が空白へ戻す (`a+b` は `%2B` になる)
    assert.equal(url.searchParams.get("path"), path, path);
  }
});
