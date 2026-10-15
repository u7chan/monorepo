// 401 と到達不能で文言が混ざらないことを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { healthMessage } from "../src/client/message"

test("401 はトークンの誤りとして案内する", () => {
  const message = healthMessage({ status: "unauthorized" })

  assert.equal(message?.includes("トークンが違います"), true)
  assert.equal(message?.includes("トークンの不一致ではありません"), false)
})

test("到達不能はトークンの誤りではないと案内する", () => {
  const message = healthMessage({ status: "unreachable", reason: "Failed to fetch" })

  assert.equal(message?.includes("トークンの不一致ではありません"), true)
  assert.equal(message?.includes("Failed to fetch"), true)
  assert.equal(message?.includes("トークンが違います"), false)
})

test("ok のときはメッセージを出さない", () => {
  assert.equal(
    healthMessage({
      status: "ok",
      health: { ok: true, version: "0.0.0", startedAt: "2026-10-15T00:00:00.000Z" },
    }),
    null,
  )
})
