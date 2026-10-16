// 発行を許す送信元の判定（IPv4 mapped の正規化を含む）を固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { isLoopbackAddress, normalizeRemoteAddress } from "../src/server/peer"

test("IPv4 mapped な IPv6 表記を IPv4 へ正規化する", () => {
  assert.equal(normalizeRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1")
  assert.equal(normalizeRemoteAddress("::FFFF:192.0.2.1"), "192.0.2.1")
  assert.equal(normalizeRemoteAddress(" 127.0.0.1 "), "127.0.0.1")
  assert.equal(normalizeRemoteAddress("::1"), "::1")
  assert.equal(normalizeRemoteAddress("::ffff:7f00:1"), "::ffff:7f00:1")
})

test("アドレスとして空の値は正規化しない", () => {
  assert.equal(normalizeRemoteAddress(""), null)
  assert.equal(normalizeRemoteAddress("   "), null)
  assert.equal(normalizeRemoteAddress(null), null)
  assert.equal(normalizeRemoteAddress(undefined), null)
})

test("loopback は 127.0.0.1 と ::1 だけ", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true)
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackAddress("::1"), true)
})

test("loopback 以外は発行元にしない", () => {
  for (const value of ["192.0.2.1", "::ffff:192.0.2.1", "198.51.100.10", "127.0.0.2", "::ffff:127.0.0.2", "0.0.0.0", "", null, undefined]) {
    assert.equal(isLoopbackAddress(value), false, String(value))
  }
})
