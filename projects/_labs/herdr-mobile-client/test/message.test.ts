// 401 と到達不能で文言が混ざらないこと、失敗したペアリングの文言が手入力の結果で上書きされることを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { formMessage, healthMessage, pairMessage } from "../src/client/message"

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

test("health の結果がまだ無いときだけペアリングエラーを出す", () => {
  assert.equal(formMessage({ health: null, pair: { status: "invalid" } }), pairMessage({ status: "invalid" }))
  assert.equal(formMessage({ health: null, pair: { status: "rate-limited" } }), pairMessage({ status: "rate-limited" }))
  assert.equal(formMessage({ health: null, pair: null }), null)
})

test("手入力の結果が出たら、古いペアリングエラーではなく最新の health の文言を出す", () => {
  const unauthorized = { status: "unauthorized" } as const
  const unreachable = { status: "unreachable", reason: "Failed to fetch" } as const

  assert.equal(formMessage({ health: unauthorized, pair: { status: "invalid" } }), healthMessage(unauthorized))
  assert.equal(formMessage({ health: unreachable, pair: { status: "rate-limited" } }), healthMessage(unreachable))
  assert.equal(formMessage({ health: unauthorized, pair: null }), healthMessage(unauthorized))
})

test("health が ok ならペアリングエラーを出さない", () => {
  const ok = {
    status: "ok",
    health: { ok: true, version: "0.0.0", startedAt: "2026-10-15T00:00:00.000Z" },
  } as const

  assert.equal(formMessage({ health: ok, pair: { status: "invalid" } }), null)
})
