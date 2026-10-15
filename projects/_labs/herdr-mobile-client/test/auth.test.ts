// Authorization ヘッダの判定を、欠落 / 形式不正 / 不一致 / 一致で固定する。
import assert from "node:assert/strict"
import test from "node:test"
import { extractBearerToken, isAuthorized } from "../src/server/auth"

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

test("extractBearerToken は Bearer 以外と空のトークンを受け付けない", () => {
  assert.equal(extractBearerToken(undefined), null)
  assert.equal(extractBearerToken(null), null)
  assert.equal(extractBearerToken(""), null)
  assert.equal(extractBearerToken("Bearer"), null)
  assert.equal(extractBearerToken("Bearer "), null)
  assert.equal(extractBearerToken("Basic abc"), null)
  assert.equal(extractBearerToken("abc"), null)
  assert.equal(extractBearerToken("Bearer a b"), null)
})

test("extractBearerToken は scheme の大小と前後の空白を許す", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc")
  assert.equal(extractBearerToken("bearer abc"), "abc")
  assert.equal(extractBearerToken("  Bearer abc  "), "abc")
})

test("ヘッダ欠落の場合は false", () => {
  assert.equal(isAuthorized(undefined, token), false)
  assert.equal(isAuthorized(null, token), false)
  assert.equal(isAuthorized("", token), false)
})

test("形式不正の場合は false", () => {
  assert.equal(isAuthorized("Bearer", token), false)
  assert.equal(isAuthorized("Bearer ", token), false)
  assert.equal(isAuthorized("Basic abc", token), false)
  assert.equal(isAuthorized(token, token), false)
  assert.equal(isAuthorized(`Bearer ${token} extra`, token), false)
})

test("一致しない場合は false", () => {
  assert.equal(isAuthorized("Bearer 0123456789abcdef", token), false)
  assert.equal(isAuthorized(`Bearer ${token.slice(0, -1)}`, token), false)
  assert.equal(isAuthorized(`Bearer ${token}0`, token), false)
  assert.equal(isAuthorized(`Bearer ${token.toUpperCase()}`, token), false)
})

test("一致する場合は true", () => {
  assert.equal(isAuthorized(`Bearer ${token}`, token), true)
  assert.equal(isAuthorized(`bearer ${token}`, token), true)
})
