// 追加した規則の RemoteAddress が、表記によらず期待する LAN セグメントと一致すると判定できることを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { cidrMatchesAny, normalizedCidr } from "../scripts/cidr"

test("ドット表記ネットマスクをプレフィックス長と同じ形へ正規化する", () => {
  assert.equal(normalizedCidr("192.0.2.0/24"), "192.0.2.0/24")
  assert.equal(normalizedCidr("192.0.2.0/255.255.255.0"), "192.0.2.0/24")
  assert.equal(normalizedCidr("198.51.100.128/255.255.255.192"), "198.51.100.128/26")
  assert.equal(normalizedCidr("203.0.113.0/0"), "0.0.0.0/0")
  assert.equal(normalizedCidr("203.0.113.7/32"), "203.0.113.7/32")
})

test("アドレスをネットワークアドレスへ寄せる", () => {
  assert.equal(normalizedCidr("192.0.2.5/24"), "192.0.2.0/24")
  assert.equal(normalizedCidr("192.0.2.5/255.255.255.0"), "192.0.2.0/24")
})

test("表記が違っても同じネットワークとプレフィックス長なら一致する", () => {
  assert.equal(cidrMatchesAny("192.0.2.0/24", ["192.0.2.0/255.255.255.0"]), true)
  assert.equal(cidrMatchesAny("192.0.2.0/255.255.255.0", ["192.0.2.0/24"]), true)
  assert.equal(cidrMatchesAny("192.0.2.0/24", ["198.51.100.0/24", "192.0.2.0/255.255.255.0"]), true)
})

test("ネットワークかプレフィックス長が違えば一致しない", () => {
  assert.equal(cidrMatchesAny("192.0.2.0/24", ["198.51.100.0/255.255.255.0"]), false)
  assert.equal(cidrMatchesAny("192.0.2.0/24", ["192.0.2.0/255.255.0.0"]), false)
  assert.equal(cidrMatchesAny("192.0.2.0/24", []), false)
})

test("解釈できない値は正規化しない", () => {
  for (const value of [
    "",
    "192.0.2.0",
    "192.0.2.0/",
    "/24",
    "192.0.2.0/33",
    "192.0.2.256/24",
    "999.0.2.0/24",
    "192.0.2/24",
    "192.0.2.0/255.0.255.0",
    "192.0.2.0/255.255.255.0/24",
    "LocalSubnet",
  ]) {
    assert.equal(normalizedCidr(value), null, value)
  }
})

test("期待する値が解釈できないときは一致にしない", () => {
  assert.equal(cidrMatchesAny("LocalSubnet", ["LocalSubnet"]), false)
})
