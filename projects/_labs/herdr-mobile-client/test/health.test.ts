// GET /api/health が返す項目と値を固定する。クライアントはここで固定した形を読む。
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createApp } from "../src/server/app"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

test("GET /api/health は ok / version / startedAt だけを返す", async () => {
  const res = await createApp().request("/api/health")

  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /application\/json/)

  const body = (await res.json()) as Record<string, unknown>

  assert.deepEqual(Object.keys(body).sort(), ["ok", "startedAt", "version"])
  assert.equal(body.ok, true)
  assert.equal(body.version, packageJson.version)
  assert.equal(new Date(String(body.startedAt)).toISOString(), body.startedAt)
})
