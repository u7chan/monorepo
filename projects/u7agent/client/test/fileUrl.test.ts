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

test("fileHtmlPreviewUrl はクエリではなくパス形式で同一オリジンの URL を組み立てる", async () => {
  // api.ts は module の読み込み時に location.origin を参照する (node のテストには DOM が無い)
  Object.defineProperty(globalThis, "location", { value: { origin: "http://localhost:5173" }, configurable: true });
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

test("fileDownloadUrl は path をクエリで渡し、サーバー側の 1 回の decode で元に戻る", async () => {
  Object.defineProperty(globalThis, "location", { value: { origin: "http://localhost:5173" }, configurable: true });
  const { fileDownloadUrl } = await import("../src/api");
  for (const path of ["a.txt", "src/nested 日本語", "a+b#c.txt", ""]) {
    const url = new URL(fileDownloadUrl(path));
    assert.equal(url.origin, "http://localhost:5173");
    assert.equal(url.pathname, "/api/files/download", path);
    // クエリの `+` は searchParams が空白へ戻す (`a+b` は `%2B` になる)
    assert.equal(url.searchParams.get("path"), path, path);
  }
});
