// クライアントのペアリング交換の分類と、表示する文言が混ざらないことを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { pairMessage } from "../src/client/message"
import { parsePairHash } from "../src/client/pair"
import { classifyPairResponse } from "../src/client/pair"

test("hash からは #pair= のコードだけを取り出す", () => {
  assert.equal(parsePairHash("#pair=AbCdEfGhIjK"), "AbCdEfGhIjK")
  assert.equal(parsePairHash("#pair=abcdefghij-"), "abcdefghij-")
  assert.equal(parsePairHash("#pair="), null)
  assert.equal(parsePairHash(""), null)
  assert.equal(parsePairHash("#other=AbCdEfGhIjK"), null)
  assert.equal(parsePairHash("AbCdEfGhIjK"), null)
})

test("400 と 410 はコードの無効として分類する", () => {
  assert.deepEqual(classifyPairResponse(400), { status: "invalid" })
  assert.deepEqual(classifyPairResponse(410), { status: "invalid" })
})

test("429 は試行過多として分類する", () => {
  assert.deepEqual(classifyPairResponse(429), { status: "rate-limited" })
})

test("分類できないステータスは到達不能として扱う", () => {
  assert.deepEqual(classifyPairResponse(500), { status: "unreachable", reason: "HTTP 500" })
  assert.deepEqual(classifyPairResponse(404), { status: "unreachable", reason: "HTTP 404" })
})

test("無効なコードは QR の出し直しを案内する", () => {
  const message = pairMessage({ status: "invalid" })

  assert.equal(message, "QR のコードが無効です（期限切れの可能性があります）。もう一度 QR を出してください")
})

test("試行過多は待ってから QR を出し直すよう案内する", () => {
  const message = pairMessage({ status: "rate-limited" })

  assert.equal(message, "試行が多すぎます。少し待ってから、もう一度 QR を出してください")
  assert.equal(message.includes("到達"), false)
})

test("到達不能はトークンの不一致ではないと案内する", () => {
  const message = pairMessage({ status: "unreachable", reason: "Failed to fetch" })

  assert.equal(message.includes("トークンの不一致ではありません"), true)
  assert.equal(message.includes("Failed to fetch"), true)
  assert.equal(message.includes("QR のコードが無効"), false)
  assert.equal(message.includes("試行が多すぎます"), false)
})
