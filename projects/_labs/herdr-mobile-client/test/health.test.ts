// GET /api/health が返す項目と値、および /api/* が Bearer トークン必須であることを固定する。
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createApp } from "../src/server/app"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

const token = "s3cret-token-for-test"
const app = createApp({ token })
const authorized = { authorization: `Bearer ${token}` }

test("GET /api/health は ok / version / startedAt だけを返す", async () => {
  const res = await app.request("/api/health", { headers: authorized })

  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /application\/json/)

  const body = (await res.json()) as Record<string, unknown>

  assert.deepEqual(Object.keys(body).sort(), ["ok", "startedAt", "version"])
  assert.equal(body.ok, true)
  assert.equal(body.version, packageJson.version)
  assert.equal(new Date(String(body.startedAt)).toISOString(), body.startedAt)
})

test("Authorization の無い /api/* は 401 を返し、トークン値を含まない", async () => {
  const res = await app.request("/api/health")

  assert.equal(res.status, 401)

  const raw = await res.text()

  assert.equal(raw.includes(token), false)
  assert.deepEqual(JSON.parse(raw), { error: "unauthorized" })
})

test("誤った / 形式不正な Authorization の /api/* は 401 を返し、トークン値を含まない", async () => {
  for (const authorization of ["Bearer wrong-token", `Basic ${token}`, token, "Bearer"]) {
    const res = await app.request("/api/health", { headers: { authorization } })

    assert.equal(res.status, 401, authorization)

    const raw = await res.text()

    assert.equal(raw.includes(token), false)
  }
})

test("未知の /api/* も認証前に 404 を返さない", async () => {
  assert.equal((await app.request("/api/unknown")).status, 401)
  assert.equal((await app.request("/api/unknown", { headers: authorized })).status, 404)
})

test("正しい Authorization の応答にもトークン値を含まない", async () => {
  const res = await app.request("/api/health", { headers: authorized })

  assert.equal(res.status, 200)
  assert.equal((await res.text()).includes(token), false)
})

test("トークンが違えば /api/health も 401 になる", async () => {
  const other = createApp({ token: "another-token" })

  assert.equal((await other.request("/api/health", { headers: authorized })).status, 401)
  assert.equal((await other.request("/api/health", { headers: { authorization: "Bearer another-token" } })).status, 200)
})
