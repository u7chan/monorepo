// トークンの解決が、環境変数の指定 / 未指定 / 空白のみで期待どおりになることを固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { resolveToken } from "../src/server/token"

test("HERDR_CLIENT_TOKEN があればその値を使う", () => {
  assert.deepEqual(resolveToken({ HERDR_CLIENT_TOKEN: "fixed-token" }), {
    value: "fixed-token",
    source: "env",
  })
})

test("HERDR_CLIENT_TOKEN が無い / 空白のみなら生成する", () => {
  const missing = resolveToken({})
  const blank = resolveToken({ HERDR_CLIENT_TOKEN: "   " })

  assert.equal(missing.source, "generated")
  assert.equal(blank.source, "generated")
  assert.match(missing.value, /^[0-9a-f]{64}$/)
  assert.match(blank.value, /^[0-9a-f]{64}$/)
})

test("生成したトークンは呼び出しごとに変わる", () => {
  assert.notEqual(resolveToken({}).value, resolveToken({}).value)
})
