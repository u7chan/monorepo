// 一時コードの発行・照合・試行回数制限を、時刻を注入して固定する。
import assert from "node:assert/strict"
import test from "node:test"
import {
  PAIR_ATTEMPT_LIMIT,
  PAIR_ATTEMPT_WINDOW_MS,
  PAIR_CODE_LENGTH,
  PAIR_TTL_MS,
  createPairing,
  generatePairCode,
  isPairCodeFormat,
  pairCodeFromBody,
} from "../src/server/pairing"

const code = "AbCdEfGhIjK"

function createTestPairing(options: { start?: number; code?: string } = {}) {
  let now = options.start ?? 0

  return {
    pairing: createPairing({ now: () => now, generateCode: () => options.code ?? code }),
    advance(ms: number) {
      now += ms
    },
  }
}

test("生成するコードは 11 文字の base64url になる", () => {
  for (let i = 0; i < 20; i++) {
    const generated = generatePairCode()

    assert.equal(generated.length, PAIR_CODE_LENGTH)
    assert.match(generated, /^[A-Za-z0-9_-]+$/)
  }
})

test("コードの形式は 11 文字の base64url だけを受け付ける", () => {
  assert.equal(isPairCodeFormat(code), true)
  assert.equal(isPairCodeFormat("abcdefghij-"), true)
  assert.equal(isPairCodeFormat("abcdefghij_"), true)

  for (const value of ["", "abcdefghij", "abcdefghijkl", "abcdefghij+", "abcdefghij=", 123, null, undefined, {}]) {
    assert.equal(isPairCodeFormat(value), false, String(value))
  }
})

test("request body からは形式の正しい code だけを取り出す", () => {
  assert.equal(pairCodeFromBody({ code }), code)
  assert.equal(pairCodeFromBody({ code: "short" }), null)
  assert.equal(pairCodeFromBody({ code: 1 }), null)
  assert.equal(pairCodeFromBody({}), null)
  assert.equal(pairCodeFromBody("abcdefghijk"), null)
  assert.equal(pairCodeFromBody(null), null)
})

test("発行したコードは一致し、TTL の内側でだけ使える", () => {
  const { pairing } = createTestPairing()

  const issued = pairing.issue()

  assert.equal(issued.code, code)
  assert.equal(issued.expiresAt, new Date(PAIR_TTL_MS).toISOString())
  assert.equal(pairing.consume(code), true)
  assert.equal(pairing.consume(code), false, "単回使用")
})

test("期限切れのコードは使えない", () => {
  const { pairing, advance } = createTestPairing()

  pairing.issue()
  advance(PAIR_TTL_MS)

  assert.equal(pairing.consume(code), false)
})

test("一致しないコードでは有効なコードを破棄しない", () => {
  const { pairing } = createTestPairing()

  pairing.issue()

  assert.equal(pairing.consume("ZZZZZZZZZZZ"), false)
  assert.equal(pairing.consume(code), true)
})

test("コードを発行していなければ一致しない", () => {
  const { pairing } = createTestPairing()

  assert.equal(pairing.consume(code), false)
})

test("再発行すると以前のコードは無効になる", () => {
  let generated = 0
  const pairing = createPairing({ now: () => 0, generateCode: () => `AbCdEfGhIj${generated++}` })

  const first = pairing.issue()
  const second = pairing.issue()

  assert.notEqual(first.code, second.code)
  assert.equal(pairing.consume(first.code), false)
  assert.equal(pairing.consume(second.code), true)
})

test("試行は 1 分あたり 10 回までで、11 回目を拒否する", () => {
  const { pairing } = createTestPairing()

  for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i++) {
    assert.equal(pairing.registerAttempt(), true, `${i + 1} 回目`)
  }

  assert.equal(pairing.registerAttempt(), false, "11 回目")
})

test("時間が経過すると試行回数が回復する", () => {
  const { pairing, advance } = createTestPairing()

  for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i++) {
    pairing.registerAttempt()
  }

  assert.equal(pairing.registerAttempt(), false)

  advance(PAIR_ATTEMPT_WINDOW_MS)

  assert.equal(pairing.registerAttempt(), true)
})

test("再発行では試行回数をリセットしない", () => {
  const { pairing } = createTestPairing()

  for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i++) {
    pairing.registerAttempt()
  }

  pairing.issue()

  assert.equal(pairing.registerAttempt(), false)
})
