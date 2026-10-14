// 標準経路の外部到達ポリシー (server/src/browser/policy.ts) の契約を検証する。
// ループバックの表記と proxy の起動引数は、ずれると境界が黙って緩むため文字列まで固定する。

import assert from "node:assert/strict";
import test from "node:test";
import {
  browserArguments,
  isAllowedUrl,
  isLoopbackHost,
  LOOPBACK_HOSTS,
  PROXY_BYPASS_LIST,
} from "../src/browser/policy";

test("isAllowedUrl は許可したループバックだけを通す", () => {
  for (const url of [
    "http://127.0.0.1:3000/",
    "https://127.0.0.1/",
    "http://localhost:8080/app",
    "http://LOCALHOST/app",
    "http://[::1]:8080/",
    "ws://127.0.0.1:3000/ws",
    "wss://localhost/ws",
  ]) {
    assert.equal(isAllowedUrl(url), true, url);
  }
});

test("isAllowedUrl はループバックの別名と外部を拒否する", () => {
  for (const url of [
    "http://127.0.0.2:3000/",
    "http://127.0.0.1.evil.example/",
    "http://127.0.0.1@evil.example/",
    "http://localhost.evil.example/",
    "http://[::]:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.0.2.1/",
    "https://example.com/",
    "ws://192.0.2.1/ws",
    "not a url",
  ]) {
    assert.equal(isAllowedUrl(url), false, url);
  }
});

test("isAllowedUrl は通信ではない scheme を外部到達として扱わない", () => {
  for (const url of ["data:text/html,ok", "about:blank", "blob:http://127.0.0.1/id", "file:///etc/hostname"]) {
    assert.equal(isAllowedUrl(url), true, url);
  }
});

test("ループバックの表記は 127.0.0.1 / localhost / [::1] の 3 つだけ", () => {
  assert.deepEqual([...LOOPBACK_HOSTS], ["127.0.0.1", "localhost", "[::1]"]);
  assert.equal(isLoopbackHost("127.0.0.2"), false);
  assert.equal(isLoopbackHost("[::]"), false);
  assert.equal(PROXY_BYPASS_LIST, "<-loopback>;127.0.0.1;localhost;[::1]");
});

test("起動引数は deny-all proxy を指し、暗黙バイパスを外した一覧と固定引数を渡す", () => {
  const args = browserArguments("http://127.0.0.1:34567");
  assert.deepEqual(args, [
    "--proxy-server=http://127.0.0.1:34567",
    "--proxy-bypass-list=<-loopback>;127.0.0.1;localhost;[::1]",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-breakpad",
    "--hide-scrollbars",
  ]);
  // --user-data-dir は Playwright に管理させ、HOME は呼び出しごとの一時領域にする
  assert.ok(!args.some((arg) => arg.includes("user-data-dir")));
});
