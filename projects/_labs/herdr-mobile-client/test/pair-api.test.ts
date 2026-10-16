// 公開ルート（POST /api/pair/new, POST /api/pair）の状態遷移と、認証がかかったままであることを固定する。
// 送信元と時刻は app.request() では入らないため、createApp のオプションで注入する。
import assert from "node:assert/strict"
import test from "node:test"
import { createApp } from "../src/server/app"
import { PAIR_ATTEMPT_LIMIT, PAIR_ATTEMPT_WINDOW_MS, PAIR_CODE_LENGTH, PAIR_TTL_MS } from "../src/server/pairing"

const token = "pair-test-token"
const loopback = "127.0.0.1"
const origin = "http://192.0.2.1:18081"

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

function createTestApp(remoteAddress: string | null = loopback) {
  let now = 0

  const app = createApp({
    token,
    remoteAddress: () => remoteAddress,
    now: () => now,
  })

  return {
    app,
    advance(ms: number) {
      now += ms
    },
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>
}

async function issueCode(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/pair/new", postJson({ origin }))

  assert.equal(res.status, 200)

  const body = await readBody(res)

  return String(body.code)
}

test("loopback からの発行は code / url / expiresAt を返し、トークンを含まない", async () => {
  const { app } = createTestApp()

  for (const address of [loopback, "::1", "::ffff:127.0.0.1"]) {
    const res = await app.request("/api/pair/new", postJson({ origin }))

    assert.equal(res.status, 200, address)

    const raw = await res.text()

    assert.equal(raw.includes(token), false)

    const body = JSON.parse(raw) as Record<string, unknown>

    assert.deepEqual(Object.keys(body).sort(), ["code", "expiresAt", "url"])
    assert.equal(typeof body.code, "string")
    assert.equal(String(body.code).length, PAIR_CODE_LENGTH)
    assert.match(String(body.code), /^[A-Za-z0-9_-]+$/)
    assert.equal(body.url, `${origin}/#pair=${String(body.code)}`)
    assert.equal(body.expiresAt, new Date(PAIR_TTL_MS).toISOString())
  }
})

test("loopback 以外からの発行は 404 で、ルートの存在を見せない", async () => {
  for (const address of ["192.0.2.1", "203.0.113.5", "::ffff:192.0.2.1", "198.51.100.10", "::ffff:127.0.0.2"]) {
    const { app } = createTestApp(address)
    const res = await app.request("/api/pair/new", postJson({ origin }))

    assert.equal(res.status, 404, address)

    const raw = await res.text()

    assert.equal(raw.includes("code"), false)
    assert.equal(raw.includes(token), false)
  }
})

test("loopback 以外からの発行は、本文が不正でも 404 を返す（検証より先に判定する）", async () => {
  const { app } = createTestApp("203.0.113.5")

  assert.equal((await app.request("/api/pair/new", postJson({ origin: "https://192.0.2.1:18081" }))).status, 404)
  assert.equal((await app.request("/api/pair/new", postJson({}))).status, 404)
  assert.equal((await app.request("/api/pair/new", { method: "POST" })).status, 404)
})

test("接続情報を注入しない app.request() では発行しない", async () => {
  const app = createApp({ token })
  const res = await app.request("/api/pair/new", postJson({ origin }))

  assert.equal(res.status, 404)
})

test("origin が形に合わない発行は 400 を返す", async () => {
  const { app } = createTestApp()

  for (const value of ["https://192.0.2.1:18081", "http://192.0.2.1", "http://192.0.2.1:18081/path", "", 1, null]) {
    const res = await app.request("/api/pair/new", postJson({ origin: value }))

    assert.equal(res.status, 400, String(value))
  }
})

test("本文が JSON でない発行は 400 を返す（500 にしない）", async () => {
  const { app } = createTestApp()

  const notJson = await app.request("/api/pair/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  })

  assert.equal(notJson.status, 400)

  const noBody = await app.request("/api/pair/new", { method: "POST" })

  assert.equal(noBody.status, 400)
})

test("交換は発行したコードでだけ成功し、成功したコードは使えなくなる", async () => {
  const { app } = createTestApp()
  const code = await issueCode(app)

  const res = await app.request("/api/pair", postJson({ code }))

  assert.equal(res.status, 200)
  assert.deepEqual(await readBody(res), { token })

  const second = await app.request("/api/pair", postJson({ code }))

  assert.equal(second.status, 410)
})

test("交換に失敗した応答はコードもトークンも含まない", async () => {
  const { app } = createTestApp()
  const code = await issueCode(app)

  for (const [body, expected] of [
    [{ code: "ZZZZZZZZZZZ" }, 410],
    [{ code: "abcdefghij" }, 400],
    [{ code: 1 }, 400],
    [{}, 400],
  ] as const) {
    const res = await app.request("/api/pair", postJson(body))
    const raw = await res.text()

    assert.equal(res.status, expected, JSON.stringify(body))
    assert.equal(raw.includes(code), false)
    assert.equal(raw.includes(token), false)
  }
})

test("期限切れのコードでは交換できない", async () => {
  const { app, advance } = createTestApp()
  const code = await issueCode(app)

  advance(PAIR_TTL_MS)

  assert.equal((await app.request("/api/pair", postJson({ code }))).status, 410)
})

test("再発行すると以前のコードでは交換できない", async () => {
  const { app } = createTestApp()
  const first = await issueCode(app)
  const second = await issueCode(app)

  assert.notEqual(first, second)
  assert.equal((await app.request("/api/pair", postJson({ code: first }))).status, 410)
  assert.equal((await app.request("/api/pair", postJson({ code: second }))).status, 200)
})

test("交換は 1 分あたり 10 回で打ち切り、時間の経過で回復する", async () => {
  const { app, advance } = createTestApp()

  for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i++) {
    assert.equal((await app.request("/api/pair", postJson({ code: "ZZZZZZZZZZZ" }))).status, 410, `${i + 1} 回目`)
  }

  const limited = await app.request("/api/pair", postJson({ code: "ZZZZZZZZZZZ" }))

  assert.equal(limited.status, 429)
  assert.deepEqual(await readBody(limited), { error: "too_many_attempts" })

  advance(PAIR_ATTEMPT_WINDOW_MS)

  assert.equal((await app.request("/api/pair", postJson({ code: "ZZZZZZZZZZZ" }))).status, 410)
})

test("形式不正の交換も試行回数に数える", async () => {
  const { app } = createTestApp()

  for (let i = 0; i < PAIR_ATTEMPT_LIMIT; i++) {
    assert.equal((await app.request("/api/pair", postJson({ code: "short" }))).status, 400, `${i + 1} 回目`)
  }

  assert.equal((await app.request("/api/pair", postJson({ code: "short" }))).status, 429)
})

test("認証は /api/* にかかったままになる", async () => {
  const { app } = createTestApp()

  assert.equal((await app.request("/api/health")).status, 401)
  assert.equal((await app.request("/api/health", { headers: { authorization: `Bearer ${token}` } })).status, 200)
  assert.equal((await app.request("/api/unknown")).status, 401)
  assert.equal((await app.request("/api/unknown", { headers: { authorization: `Bearer ${token}` } })).status, 404)

  const code = await issueCode(app)

  assert.notEqual((await app.request("/api/pair", postJson({ code }))).status, 401)
})
