// 発行 API が受け付ける origin の形と、QR に載せる URL の組み立てを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { isPairOrigin, pairOriginFromBody, pairUrl } from "../src/server/origin"

test("origin は http のホストとポートだけを受け付ける", () => {
  for (const value of [
    "http://192.0.2.1:18081",
    "http://192.0.2.1:1",
    "http://198.51.100.10:65535",
    "http://203.0.113.9:80",
    "http://host.example.invalid:18081",
    "http://a-b.c:00080",
  ]) {
    assert.equal(isPairOrigin(value), true, value)
  }
})

test("origin は https / パス / クエリ / ユーザー情報 / ポート無しを弾く", () => {
  for (const value of [
    "https://192.0.2.1:18081",
    "http://192.0.2.1",
    "http://192.0.2.1:",
    "http://192.0.2.1:180811",
    "http://192.0.2.1:18081/",
    "http://192.0.2.1:18081/path",
    "http://192.0.2.1:18081?x=1",
    "http://192.0.2.1:80/#pair=abcdefghijk",
    "http://user@192.0.2.1:18081",
    "http://:18081",
    "ftp://192.0.2.1:18081",
    "192.0.2.1:18081",
    "",
  ]) {
    assert.equal(isPairOrigin(value), false, value)
  }
})

test("origin は文字列以外を受け付けない", () => {
  for (const value of [null, undefined, 1, true, {}, ["http://192.0.2.1:18081"]]) {
    assert.equal(isPairOrigin(value), false, String(value))
  }
})

test("request body からは形の正しい origin だけを取り出す", () => {
  assert.equal(pairOriginFromBody({ origin: "http://192.0.2.1:18081" }), "http://192.0.2.1:18081")
  assert.equal(pairOriginFromBody({ origin: "https://192.0.2.1:18081" }), null)
  assert.equal(pairOriginFromBody({}), null)
  assert.equal(pairOriginFromBody("http://192.0.2.1:18081"), null)
  assert.equal(pairOriginFromBody(null), null)
})

test("QR に載せる URL は origin に #pair= でコードを付ける", () => {
  assert.equal(pairUrl("http://192.0.2.1:18081", "AbCdEfGhIjK"), "http://192.0.2.1:18081/#pair=AbCdEfGhIjK")
  assert.equal(pairUrl("http://host.example.invalid:80", "abcdefghij-"), "http://host.example.invalid:80/#pair=abcdefghij-")
})
