// Vite の proxy が発行 API を拒否する判定が、Hono のルーティング（decodeURI 済みのパス照合）と
// 一致することを固定する。URL.pathname だけで見ると %6e のような表記で拒否を迂回できる。
import assert from "node:assert/strict"
import test from "node:test"
import { Hono } from "hono"
import { PAIR_NEW_PATH, routingPathname } from "../src/server/routing-path"

const PROBE_PATHS = [
  "/api/pair/new",
  "/api/pair/%6eew",
  "/api/pair/%6Eew",
  "/api/pair/new?x=1",
  "/api/pair/%6eew?origin=http%3A%2F%2F192.0.2.1%3A18081",
  "/api/pair/new#fragment",
  "/api/pair/new%2F",
  "/api/pair/%6eew%2F",
  "/api/pair/%6ew",
  "/api/pair/NEW",
  "/api/pair/newx",
  "/api/pair/new/",
  "/api/pair/%2E%2E/pair/new",
  "/api/pair/./new",
  "/api/pair/%256eew",
  "/api/pair-neew",
]

test("routingPathname は通常・クエリ付き・エンコード済みのパスを発行ルートへ揃える", () => {
  assert.equal(routingPathname("http://localhost/api/pair/new"), PAIR_NEW_PATH)
  assert.equal(routingPathname("http://localhost/api/pair/%6eew"), PAIR_NEW_PATH)
  assert.equal(routingPathname("http://localhost/api/pair/new?origin=x"), PAIR_NEW_PATH)
  assert.equal(routingPathname(new URL("/api/pair/%6eew", "http://localhost")), PAIR_NEW_PATH)

  assert.notEqual(routingPathname("http://localhost/api/pair/newx"), PAIR_NEW_PATH)
  assert.notEqual(routingPathname("http://localhost/api/pair/new%2F"), PAIR_NEW_PATH)
  assert.notEqual(routingPathname("http://localhost/api/pair/NEW"), PAIR_NEW_PATH)
})

test("発行ルートかどうかの判定は Hono のルーティング結果と一致する", async () => {
  // 実際の公開ルートと同じ組み合わせにする（発行ルートと、認証不要の交換ルート）。
  const app = new Hono()
    .post(PAIR_NEW_PATH, (c) => c.text("pair-new"))
    .post("/api/pair", (c) => c.text("pair-exchange"))

  for (const probe of PROBE_PATHS) {
    const res = await app.request(`http://localhost${probe}`, { method: "POST" })
    const honoRouted = res.status === 200 && (await res.text()) === "pair-new"

    assert.equal(routingPathname(new URL(probe, "http://localhost")) === PAIR_NEW_PATH, honoRouted, probe)
  }
})
